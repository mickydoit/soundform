import { mulberry32 } from './generators/common.js';

// Deterministic per-design motion: a plane wave travelling through the form,
// displacing each point along its radial direction. Every time term is a
// whole multiple of 2π·t, so phase t=0 and t=1 render identically — the loop
// is seamless by construction. displacePoint mirrors the GLSL in
// density.js SPLAT_VERT exactly; keep the two in lockstep.

export function motionParams(seed) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const az = rnd() * Math.PI * 2;
  const el = Math.acos(2 * rnd() - 1);
  return {
    dir: [Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az)],
    freq: 4 + rnd() * 5,          // spatial frequency of the travelling wave
    amp: 0.025 + rnd() * 0.015,   // 2.5–4% of form radius: breathes, not explodes
  };
}

export function displacePoint(x, y, z, mp, t) {
  const len = Math.sqrt(x * x + y * y + z * z) || 1e-6;
  const s = mp.amp * Math.sin(mp.freq * (x * mp.dir[0] + y * mp.dir[1] + z * mp.dir[2]) + Math.PI * 2 * t);
  return [x + (x / len) * s, y + (y / len) * s, z + (z / len) * s];
}
