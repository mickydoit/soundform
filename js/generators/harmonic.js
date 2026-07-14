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
  const plan = recipe(fp, params);

  // ── Displacement field: Y_l^m backbone + interference waves + crumple ──
  const lMain = 3 + Math.round(fp.pitchMedian * 6); // pitch → dominant degree
  const nComp = Math.max(1, Math.min(4, 1 + Math.round(fp.volVar * 2 + fp.attackSlope)));
  const comps = [];
  for (let c = 0; c < nComp; c++) {
    const l = Math.max(2, Math.min(10, lMain + (c === 0 ? 0 : Math.round((rnd() - 0.5) * 4))));
    const m = fp.noteSet[c % fp.noteCount] % (l + 1);
    const phase = fp.chroma[(c * 5) % 12] * Math.PI * 2 + rnd() * 0.5;
    comps.push({ l, m, phase, amp: 0.5 / (c + 1) });
  }
  const nWaves = 4 + Math.round(Math.min(1, fp.volVar + fp.velocity) * 3); // 4..7
  const wild = 0.5 + (1 - (fp.consonance ?? 0.5)); // 0.5 (consonant) .. 1.5 (atonal/speech)
  const waves = [];
  for (let w = 0; w < nWaves; w++) {
    waves.push({
      f: (w + 1) * 0.5 + (rnd() - 0.5) * 0.8 * wild,
      phase: rnd() * Math.PI * 2,
      amp: (0.9 / (w + 2)) * (1 + (rnd() - 0.5) * 0.6 * wild),
    });
  }
  const vnoise = makeValueNoise3(rnd);
  const crumple = 0.1 + fp.spread * 0.35;
  const A = 0.35 + Math.min(1, fp.volMean + fp.velocity * 0.5) * 0.4; // 0.35..0.75

  // Prosody envelope: the utterance's pitch contour shapes the form pole-to-
  // pole, so spoken phrases with different intonation read differently.
  const contour = fp.contour && fp.contour.length >= 8 ? fp.contour : null;
  const prosody = (theta) => {
    if (!contour) return 1;
    const x = Math.min(6.999, Math.max(0, (theta / Math.PI) * 7));
    const i = Math.floor(x), f = x - i;
    return 0.7 + (contour[i] + (contour[i + 1] - contour[i]) * f) * 0.6;
  };

  const disp = (theta, phi) => {
    let d = 0;
    for (const c of comps) d += c.amp * sphericalY(c.l, c.m, theta, phi, c.phase);
    for (const w of waves) d += w.amp * Math.sin(w.f * phi * 3 + w.f * theta * 2 + w.phase);
    const st = Math.sin(theta);
    d += (vnoise.fractal(st * Math.cos(phi) * 3.2, Math.cos(theta) * 3.2, st * Math.sin(phi) * 3.2) - 0.5) * crumple * 6;
    return d * A * prosody(theta);
  };
  const surf = (theta, phi) => {
    const r = Math.max(0.05, 1 + disp(theta, phi));
    const st = Math.sin(theta);
    return [r * st * Math.cos(phi), r * Math.cos(theta), r * st * Math.sin(phi)];
  };

  const total = plan.meshPts + plan.rayPts + plan.dashPts;
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const jit = 0.0035;
  let w = 0;
  const push = (x, y, z, a) => {
    positions[w * 3]     = x + (rnd() - 0.5) * jit;
    positions[w * 3 + 1] = y + (rnd() - 0.5) * jit;
    positions[w * 3 + 2] = z + (rnd() - 0.5) * jit;
    attr[w] = a;
    w++;
  };
  const meshAttr = (theta, phi) =>
    Math.max(0, Math.min(1, 0.45 + disp(theta, phi) * 1.2));

  // ── Mesh net: coarse lat rings + lon lines, points along the lines ──
  const lines = plan.rings + plan.lons;
  const perLine = Math.floor(plan.meshPts / lines);
  const ringStrand = (fixed, isLat) => {
    const raw = new Float32Array(200 * 3);
    for (let s = 0; s < 200; s++) {
      const t = s / 199;
      const theta = isLat ? fixed : t * Math.PI;
      const phi = isLat ? t * Math.PI * 2 : fixed;
      const [x, y, z] = surf(theta, phi);
      raw[s * 3] = x; raw[s * 3 + 1] = y; raw[s * 3 + 2] = z;
    }
    return raw;
  };
  for (let i = 0; i < plan.rings; i++) {
    const theta = ((i + 0.5) / plan.rings) * Math.PI;
    for (let k = 0; k < perLine; k++) {
      const phi = rnd() * Math.PI * 2;
      const [x, y, z] = surf(theta, phi);
      push(x, y, z, meshAttr(theta, phi));
    }
    strands.push(ringStrand(theta, true));
    if (onProgress && i % 8 === 0) onProgress(i / lines);
  }
  for (let j = 0; j < plan.lons; j++) {
    const phi = (j / plan.lons) * Math.PI * 2;
    for (let k = 0; k < perLine; k++) {
      const theta = rnd() * Math.PI;
      const [x, y, z] = surf(theta, phi);
      push(x, y, z, meshAttr(theta, phi));
    }
    strands.push(ringStrand(phi, false));
  }
  // Spend any floor() remainder on extra mesh points along random rings
  while (w < plan.meshPts) {
    const theta = rnd() * Math.PI, phi = rnd() * Math.PI * 2;
    const [x, y, z] = surf(theta, phi);
    push(x, y, z, meshAttr(theta, phi));
  }

  // ── Burst rays: faint straight spikes from the centre through the form ──
  if (plan.nRays > 0) {
    const perRay = Math.max(4, Math.floor(plan.rayPts / plan.nRays));
    for (let r = 0; r < plan.nRays && w + perRay <= total; r++) {
      const u = rnd() * 2 - 1, az = rnd() * Math.PI * 2;
      const s2 = Math.sqrt(Math.max(0, 1 - u * u));
      const dir = [s2 * Math.cos(az), u, s2 * Math.sin(az)];
      const theta = Math.acos(u), phi = Math.atan2(dir[2], dir[0]);
      const end = Math.min(2.2, Math.max(0.4, 1 + disp(theta, phi)) * (1.25 + rnd() * 0.55));
      for (let k = 0; k < perRay; k++) {
        const t = 0.08 + (k / (perRay - 1)) * (end - 0.08);
        push(dir[0] * t, dir[1] * t, dir[2] * t, 0.15);
      }
      const ray = new Float32Array(8 * 3);
      for (let s = 0; s < 8; s++) {
        const t = 0.08 + (s / 7) * (end - 0.08);
        ray[s * 3] = dir[0] * t; ray[s * 3 + 1] = dir[1] * t; ray[s * 3 + 2] = dir[2] * t;
      }
      strands.push(ray);
    }
  }

  // ── Dash field: short surface-following strokes (noisy-timbre fray) ──
  if (plan.nDashes > 0) {
    let dashStrandsAdded = 0;
    for (let dIdx = 0; dIdx < plan.nDashes && w + 12 <= total; dIdx++) {
      const theta = Math.acos(rnd() * 2 - 1), phi = rnd() * Math.PI * 2;
      const [px, py, pz] = surf(theta, phi);
      const pr = Math.hypot(px, py, pz) || 1;
      const nx = px / pr, ny = py / pr, nz = pz / pr;
      const rv = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
      const dot = rv[0] * nx + rv[1] * ny + rv[2] * nz;
      let tx = rv[0] - dot * nx, ty = rv[1] - dot * ny, tz = rv[2] - dot * nz;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const L = 0.05 + rnd() * 0.07;
      for (let k = 0; k < 12; k++) {
        const t = (k / 11 - 0.5) * L;
        push(px + tx * t, py + ty * t, pz + tz * t, 0.45);
      }
      if (dashStrandsAdded < 150) {
        const dash = new Float32Array(2 * 3);
        dash[0] = px - tx * L / 2; dash[1] = py - ty * L / 2; dash[2] = pz - tz * L / 2;
        dash[3] = px + tx * L / 2; dash[4] = py + ty * L / 2; dash[5] = pz + tz * L / 2;
        strands.push(dash);
        dashStrandsAdded++;
      }
    }
  }

  // Trim to points actually written (ray/dash loops guard the budget)
  const outPos = w === total ? positions : positions.slice(0, w * 3);
  const outAttr = w === total ? attr : attr.slice(0, w);
  const resampled = strands.map(s => s.length === 6 ? s : resamplePolyline(s, 200));
  return finalize(outPos, outAttr, resampled, params);
}

// Seeded 3D value noise: 256-permutation lattice + trilinear interpolation,
// 3 fractal octaves. DOM-free and deterministic per rnd stream — this is the
// "crumple" that roughens the displacement into a hand-drawn edge.
export function makeValueNoise3(rnd) {
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rnd();
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const latt = (X, Y, Z) => vals[perm[(perm[(perm[X & 255] + (Y & 255)) & 255] + (Z & 255)) & 255]];
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const noise = (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = smooth(x - X), fy = smooth(y - Y), fz = smooth(z - Z);
    return lerp(
      lerp(lerp(latt(X, Y, Z),     latt(X + 1, Y, Z),     fx),
           lerp(latt(X, Y + 1, Z), latt(X + 1, Y + 1, Z), fx), fy),
      lerp(lerp(latt(X, Y, Z + 1),     latt(X + 1, Y, Z + 1),     fx),
           lerp(latt(X, Y + 1, Z + 1), latt(X + 1, Y + 1, Z + 1), fx), fy),
      fz);
  };
  const fractal = (x, y, z) =>
    (noise(x, y, z) + 0.5 * noise(x * 2 + 17.3, y * 2 + 17.3, z * 2 + 17.3)
                    + 0.25 * noise(x * 4 + 43.7, y * 4 + 43.7, z * 4 + 43.7)) / 1.75;
  return { noise, fractal };
}

// Treatment allocation: how the density budget splits between the mesh
// backbone (always ≥55%), percussion-driven burst rays, and noise-driven
// dash fray. Pure so tests can assert the mix without generating geometry.
export function recipe(fp, params) {
  const N = Math.max(1000, Math.floor(params.density));
  const burstW = fp.velocity > 0.12 ? Math.min(0.20, fp.velocity * 0.22 + fp.attackSlope * 0.06) : 0;
  const dashW  = fp.spread > 0.1 ? Math.min(0.25, (fp.spread - 0.1) * 0.6) : 0;
  const rings = 24 + Math.round((params.complexity || 0.5) * 24); // 24..48
  const lons  = 16 + Math.round((params.complexity || 0.5) * 16); // 16..32
  const nRays = burstW > 0 ? Math.min(160, Math.round(fp.velocity * 220)) : 0;
  const rayPts  = nRays > 0 ? Math.floor(N * burstW) : 0;
  const dashPts = dashW > 0 ? Math.floor(N * dashW) : 0;
  const nDashes = Math.floor(dashPts / 12); // ~12 points per stroke
  const meshPts = N - rayPts - dashPts;
  return { rings, lons, nRays, nDashes, meshPts, rayPts, dashPts };
}
