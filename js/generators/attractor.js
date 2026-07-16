import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';

// Five systems. Harmony class + noteCount pick the system; pitch sets
// coefficients inside pre-validated chaotic ranges; velocity adds turbulence.
const lerp = (a, b, t) => a + (b - a) * t;

const SYSTEMS = {
  thomas: {
    dt: 0.06, flow: true,
    coeffs: fp => ({ b: lerp(0.10, 0.165, 1 - fp.pitchMedian) }),
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
  // Lorenz butterfly — replaces Dadras, which was unstable under plain Euler
  // (diverged or fell into limit cycles across most of its coefficient range).
  // Lorenz is robustly chaotic for r ≈ 28–45 and integrates cleanly at this dt.
  lorenz: {
    dt: 0.007, flow: true,
    coeffs: fp => ({ s: lerp(9, 11, fp.centroid), r: lerp(29, 44, fp.pitchMedian), b: 8 / 3 + fp.spread * 0.4 }),
    step: (p, c) => [
      c.s * (p[1] - p[0]),
      p[0] * (c.r - p[2]) - p[1],
      p[0] * p[1] - c.b * p[2]],
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
  return 'lorenz'; // dissonant
}

function cloudStdDev(pos, n) {
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) m[d] += pos[i * 3 + d] / n;
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) s[d] += (pos[i * 3 + d] - m[d]) ** 2 / n;
  return Math.sqrt(s[0] + s[1] + s[2]);
}

// Validate the FINALIZED (normalized) output: catches fat-tail outliers that
// computeNormalization's r95 scaling can't see (a tight core with rare far
// excursions still gets scale=1/r95, sending those excursions to huge maxAbs).
// Stride-sampled for speed. NaN/Infinity fail both checks naturally (maxAbs
// becomes NaN/Infinity, which is never <= 1.8; std sums to NaN, never >= 0.2).
function validateFinalized(out) {
  const n = out.positions.length / 3;
  const stride = 7;
  let count = 0;
  let maxAbs = 0;
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i += stride) {
    for (let d = 0; d < 3; d++) {
      const v = out.positions[i * 3 + d];
      maxAbs = Math.max(maxAbs, Math.abs(v));
      m[d] += v;
    }
    count++;
  }
  if (count === 0) return false;
  for (let d = 0; d < 3; d++) m[d] /= count;
  for (let i = 0; i < n; i += stride) {
    for (let d = 0; d < 3; d++) s[d] += (out.positions[i * 3 + d] - m[d]) ** 2;
  }
  const std = [0, 1, 2].map(d => Math.sqrt(s[d] / count));
  const stdSum = std[0] + std[1] + std[2];
  return maxAbs <= 1.8 && stdSum >= 0.2;
}

// Validate the FINALIZED strands: the trajectory continues for ~134k Euler
// steps past the cloud (strandCount * stepsPer), and for polynomial flow
// systems (halvorsen, dadras) that extension can escape the basin even when
// the cloud itself validated clean (validateFinalized only ever saw the
// cloud). Stride-sampled (every 5th value) per strand for speed, but every
// strand is checked — a blowup only needs to hit one strand to poison the
// render. NaN/Infinity fail the finite check naturally; a merely-large but
// finite escape is caught by the |v| <= 2.5 bound (matches checkGenerator's
// maxAbs <= 2.5 contract).
function validateStrands(strands) {
  const stride = 5;
  for (const s of strands) {
    for (let i = 0; i < s.length; i += stride) {
      const v = s[i];
      if (!Number.isFinite(v) || Math.abs(v) > 2.5) return false;
    }
  }
  return true;
}

// Detect periodic collapse (limit cycles / low-dimensional loops) that the
// bounded/std checks above miss: a 1D closed curve can still have plenty of
// spread along its loop while occupying only a sliver of 3D space. Stride-
// sample up to 20,000 points into a 20x20x20 grid over [-1.3, 1.3]^3 (the
// finalized/normalized coordinate range) and count distinct occupied cells.
// A limit cycle occupies ~50-200 cells; genuine chaotic clouds occupy
// thousands, so reject below 400.
function occupiedCellCount(positions) {
  const n = positions.length / 3;
  const stride = Math.max(1, Math.floor(n / 20000));
  const grid = 20;
  const lo = -1.3, span = 2.6;
  const cells = new Set();
  for (let i = 0; i < n; i += stride) {
    const gx = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3] - lo) / span * grid)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 1] - lo) / span * grid)));
    const gz = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 2] - lo) / span * grid)));
    cells.add((gx * grid + gy) * grid + gz);
  }
  return cells.size;
}

function validateOccupancy(out) {
  return occupiedCellCount(out.positions) >= 400;
}

export function generate(fp, params, onProgress) {
  const name = pickSystem(fp);
  const sys = SYSTEMS[name];
  const arch = params.liveVariance ? formArchetype(fp) : null;
  const rnd = mulberry32(fp.seed);
  const jitter = fp.velocity * 0.012 * (0.5 + params.complexity) * (arch ? 1 + arch.wildness : 1);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const excursion = 0.5 + params.complexity; // complexity widens coefficient excursion
  const exSpread = arch ? 0.06 * arch.wildness : 0; // live widens the range itself

  // Deterministic retry: if the system collapses, nudge fingerprint-projection
  for (let attempt = 0; attempt < 8; attempt++) {
    const fpAdj = attempt === 0 ? fp : { ...fp, pitchMedian: (fp.pitchMedian + attempt * 0.618) % 1, contour: fp.contour.map(v => (v + attempt * 0.618) % 1) };
    const c = sys.coeffs(fpAdj, rnd);
    if (sys.flow) for (const key of Object.keys(c)) {
      if (typeof c[key] === 'number' && key !== 'e') {
        c[key] = c[key] * lerp(0.92 - exSpread, 1.08 + exSpread, ((excursion * 7 + attempt) % 1));
      }
    } else if (arch) {
      // Discrete maps ignore the flow excursion; wildness instead deepens the
      // cross-coupling folds that shape the sine-map web.
      const mul = 1 + 0.35 * arch.wildness;
      c.d *= mul; c.e *= mul; c.f *= mul;
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

    const out = finalize(positions, attr, strands, params);
    if (!validateFinalized(out)) continue; // fat-tail collapse → retry
    if (!validateStrands(out.strands)) continue; // strand-phase escape → retry
    if (!validateOccupancy(out)) continue; // periodic collapse (limit cycle) → retry
    return out;
  }
  if (arch) return generate(fp, { ...params, liveVariance: false }, onProgress);
  throw new Error('attractor: all retries degenerate');
}
