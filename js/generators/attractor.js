import { mulberry32, finalize, resamplePolyline } from './common.js';

// Five systems. Harmony class + noteCount pick the system; pitch sets
// coefficients inside pre-validated chaotic ranges; velocity adds turbulence.
const lerp = (a, b, t) => a + (b - a) * t;

const SYSTEMS = {
  thomas: {
    dt: 0.06, flow: true,
    coeffs: fp => ({ b: lerp(0.10, 0.19, 1 - fp.pitchMedian) }),
    step: (p, c) => [Math.sin(p[1]) - c.b * p[0], Math.sin(p[2]) - c.b * p[1], Math.sin(p[0]) - c.b * p[2]],
  },
  halvorsen: {
    dt: 0.012, flow: true,
    coeffs: fp => ({ a: lerp(1.4, 2.2, fp.pitchMedian) }),
    step: (p, c) => [
      -c.a * p[0] - 4 * p[1] - 4 * p[2] - p[1] * p[1],
      -c.a * p[1] - 4 * p[2] - 4 * p[0] - p[2] * p[2],
      -c.a * p[2] - 4 * p[0] - 4 * p[1] - p[0] * p[0]],
  },
  aizawa: {
    dt: 0.015, flow: true,
    coeffs: fp => ({ a: 0.95, b: 0.7, c: 0.6, d: lerp(3.0, 3.9, fp.pitchMedian), e: lerp(0.2, 0.3, fp.centroid), f: 0.1 }),
    step: (p, c) => [
      (p[2] - c.b) * p[0] - c.d * p[1],
      c.d * p[0] + (p[2] - c.b) * p[1],
      c.c + c.a * p[2] - (p[2] ** 3) / 3 - (p[0] ** 2 + p[1] ** 2) * (1 + c.e * p[2]) + c.f * p[2] * p[0] ** 3],
  },
  dadras: {
    dt: 0.01, flow: true,
    coeffs: fp => ({ a: lerp(2.0, 3.0, fp.pitchMedian), b: lerp(1.9, 2.7, fp.centroid), c: lerp(1.3, 1.7, fp.spread), d: lerp(1.2, 2.0, fp.volMean), e: 9 }),
    step: (p, c) => [
      p[1] - c.a * p[0] + c.b * p[1] * p[2],
      c.c * p[1] - p[0] * p[2] + p[2],
      c.d * p[0] * p[1] - c.e * p[2]],
  },
  sinemap: {
    flow: false, // discrete map, like the reference sine-map images
    coeffs: (fp, rnd) => ({
      a: lerp(1.2, 4.2, fp.contour[1]), b: lerp(1.2, 4.2, fp.contour[3]), c: lerp(1.2, 4.2, fp.contour[5]),
      d: lerp(-1.3, 1.3, fp.centroid), e: lerp(-1.3, 1.3, fp.spread), f: lerp(-1.3, 1.3, fp.volMean),
      g: rnd() * Math.PI * 2, h: rnd() * Math.PI * 2, i: rnd() * Math.PI * 2,
    }),
    step: (p, c) => [
      Math.sin(c.a * p[1]) + c.d * Math.sin(c.b * p[2] + c.g),
      Math.sin(c.b * p[2]) + c.e * Math.sin(c.c * p[0] + c.h),
      Math.sin(c.c * p[0]) + c.f * Math.sin(c.a * p[1] + c.i)],
  },
};

export function pickSystem(fp) {
  if (fp.pitchConfidence < 0.35 || fp.velocity > 0.75) return 'sinemap'; // percussive/noisy
  if (fp.consonance > 0.55 && fp.majorLeaning) return fp.noteCount <= 3 ? 'thomas' : 'aizawa';
  if (fp.consonance > 0.55) return 'halvorsen'; // minor
  return 'dadras'; // dissonant
}

function cloudStdDev(pos, n) {
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) m[d] += pos[i * 3 + d] / n;
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) s[d] += (pos[i * 3 + d] - m[d]) ** 2 / n;
  return Math.sqrt(s[0] + s[1] + s[2]);
}

export function generate(fp, params, onProgress) {
  const name = pickSystem(fp);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const jitter = fp.velocity * 0.012 * (0.5 + params.complexity); // turbulence
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const excursion = 0.5 + params.complexity; // complexity widens coefficient excursion

  // Deterministic retry: if the system collapses, nudge fingerprint-projection
  for (let attempt = 0; attempt < 8; attempt++) {
    const fpAdj = attempt === 0 ? fp : { ...fp, pitchMedian: (fp.pitchMedian + attempt * 0.618) % 1, contour: fp.contour.map(v => (v + attempt * 0.618) % 1) };
    const c = sys.coeffs(fpAdj, rnd);
    if (sys.flow) for (const key of Object.keys(c)) {
      if (typeof c[key] === 'number' && key !== 'e') c[key] = c[key] * lerp(0.92, 1.08, ((excursion * 7 + attempt) % 1));
    }

    const positions = new Float32Array(N * 3);
    const attr = new Float32Array(N);
    let p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];

    for (let i = 0; i < 3000; i++) { // warmup onto the attractor
      const d = sys.step(p, c);
      p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
    }

    let speedMax = 1e-6;
    const speeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = sys.step(p, c);
      const next = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
      const sp = Math.hypot(next[0] - p[0], next[1] - p[1], next[2] - p[2]);
      p = next;
      positions[i * 3] = p[0] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 1] = p[1] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 2] = p[2] + (rnd() - 0.5) * jitter;
      speeds[i] = sp;
      if (sp > speedMax) speedMax = sp;
      if (onProgress && i % 200000 === 0) onProgress(i / N);
    }
    // attr: dwell (slow = dense manifold = high palette position)
    for (let i = 0; i < N; i++) attr[i] = Math.max(0, Math.min(1, 1 - speeds[i] / speedMax));

    if (cloudStdDev(positions, Math.min(N, 5000)) < 0.02) continue; // collapsed → retry

    // Strands: continue the SAME trajectory, chopped into consecutive pieces
    const strandCount = Math.max(24, Math.min(96, params.strandCount || 96));
    const strands = [];
    const stepsPer = sys.flow ? 1400 : 500;
    for (let s = 0; s < strandCount; s++) {
      const raw = new Float32Array(stepsPer * 3);
      for (let i = 0; i < stepsPer; i++) {
        const d = sys.step(p, c);
        p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
        raw[i * 3] = p[0]; raw[i * 3 + 1] = p[1]; raw[i * 3 + 2] = p[2];
      }
      strands.push(resamplePolyline(raw, sys.flow ? 400 : 240));
    }
    return finalize(positions, attr, strands, params);
  }
  throw new Error('attractor: all retries degenerate');
}
