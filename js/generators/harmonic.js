import { mulberry32, finalize, resamplePolyline } from './common.js';

// Analogue wireframe sphere deformed by real spherical harmonics: fine
// lat/long rings whose radius is displaced by a stack of Y_l^m terms, so the
// form reads as a resonating physical body drawn by a plotter. Points are
// sampled ALONG the rings (tight jitter) so the density renderer draws crisp
// lines instead of volumetric clouds; the rings themselves are the strands.

function factorialRatio(l, m) {
  // (l-m)!/(l+m)! as a running product — avoids overflow for l ≤ 10
  let r = 1;
  for (let i = l - m + 1; i <= l + m; i++) r /= i;
  return r;
}

function legendreP(l, m, x) {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));
    let fact = 1;
    for (let i = 1; i <= m; i++) { pmm *= -fact * s; fact += 2; }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = (x * (2 * ll - 1) * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1; pmmp1 = pll;
  }
  return pll;
}

export function sphericalY(l, m, theta, phi, phase = 0) {
  const am = Math.min(Math.abs(m), l);
  const norm = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * factorialRatio(l, am));
  return norm * legendreP(l, am, Math.cos(theta)) * Math.cos(am * phi + phase);
}

export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const N = Math.max(1000, Math.floor(params.density));

  // Pitch → dominant degree l (low = few large lobes, high = fine ripples);
  // notes → orders m; chroma → phases; dynamics → component count.
  const lMain = 3 + Math.round(fp.pitchMedian * 6); // 3..9
  const nComp = Math.max(1, Math.min(4, 1 + Math.round(fp.volVar * 2 + fp.attackSlope)));
  const comps = [];
  for (let c = 0; c < nComp; c++) {
    const l = Math.max(2, Math.min(10, lMain + (c === 0 ? 0 : Math.round((rnd() - 0.5) * 4))));
    const m = fp.noteSet[c % fp.noteCount] % (l + 1);
    const phase = fp.chroma[(c * 5) % 12] * Math.PI * 2 + rnd() * 0.5;
    const amp = (0.32 / (c + 1)) * (0.7 + fp.velocity * 0.6);
    comps.push({ l, m, phase, amp });
  }

  const disp = (theta, phi) => {
    let d = 0;
    for (const c of comps) d += c.amp * sphericalY(c.l, c.m, theta, phi, c.phase);
    return d;
  };

  const rings = 44 + Math.round((params.complexity || 0.5) * 36); // 44..80
  const lons = 16;
  const perRing = Math.max(40, Math.floor(N / (rings + lons)));
  const total = perRing * (rings + lons);
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const jit = 0.0035; // tight jitter keeps line-work crisp
  let w = 0;

  const push = (theta, phi) => {
    const d = disp(theta, phi);
    const r = 1 + d;
    const st = Math.sin(theta);
    positions[w * 3]     = r * st * Math.cos(phi) + (rnd() - 0.5) * jit;
    positions[w * 3 + 1] = r * Math.cos(theta)    + (rnd() - 0.5) * jit;
    positions[w * 3 + 2] = r * st * Math.sin(phi) + (rnd() - 0.5) * jit;
    attr[w] = Math.max(0, Math.min(1, 0.5 + d * 1.6)); // lobes brighten
    w++;
  };

  const ringStrand = (fixed, isLat) => {
    const raw = new Float32Array(256 * 3);
    for (let s = 0; s < 256; s++) {
      const t = s / 255;
      const theta = isLat ? fixed : t * Math.PI;
      const phi = isLat ? t * Math.PI * 2 : fixed;
      const d = disp(theta, phi), r = 1 + d, st = Math.sin(theta);
      raw[s * 3] = r * st * Math.cos(phi);
      raw[s * 3 + 1] = r * Math.cos(theta);
      raw[s * 3 + 2] = r * st * Math.sin(phi);
    }
    return resamplePolyline(raw, 200);
  };

  for (let i = 0; i < rings; i++) {
    const theta = ((i + 0.5) / rings) * Math.PI;
    for (let p = 0; p < perRing; p++) push(theta, rnd() * Math.PI * 2);
    strands.push(ringStrand(theta, true));
    if (onProgress && i % 8 === 0) onProgress(i / (rings + lons));
  }
  for (let j = 0; j < lons; j++) {
    const phi = (j / lons) * Math.PI * 2;
    for (let p = 0; p < perRing; p++) push(rnd() * Math.PI, phi);
    strands.push(ringStrand(phi, false));
  }

  return finalize(positions, attr, strands, params);
}
