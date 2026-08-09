import { mulberry32 } from './common.js?v=55';

// Liquid: a metaball blob built from a handful of circles, smooth-unioned.
//
// This mode does NOT produce a point cloud. Its shape is analytic — an
// isocontour of the field in js/blob.js — so it returns `circles` and the
// renderer and exporters work from those directly. The tiny positions/attr
// arrays exist only to satisfy the worker's transfer contract; nothing draws
// them. Cymatics and the other point-cloud modes are untouched by this.

export const LIQUID_MIN_LOBES = 3;
export const LIQUID_MAX_LOBES = 8;

// The reference identity describes its own states as running "from flat (as
// ice) to random (as water)". That maps cleanly onto how ordered a sound is:
// a clean, consonant tone lays lobes out evenly on a ring at near-equal radii
// (the ice end), while a rough, noisy, dynamic sound scatters their angles,
// radii and distances (the water end).
export function chaosOf(fp) {
  const rough = 1 - clamp01(fp.consonance);
  return clamp01(0.15 + 0.55 * rough + 0.3 * clamp01(fp.volVar) + 0.2 * clamp01(fp.spread));
}

function clamp01(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

export function buildCircles(fp, params = {}) {
  const rnd = mulberry32((fp.seed >>> 0) ^ 0x11d5b0b);
  const chaos = chaosOf(fp);

  // Lobe count from how many distinct notes are present, widened by the
  // Complexity slider. Below 3 the blob stops reading as a cluster; above 8
  // the lobes crowd into a disc and the silhouette loses its character.
  const comp = Number.isFinite(params.complexity) ? clamp01(params.complexity) : 0.5;
  const notes = Number.isFinite(fp.noteCount) ? fp.noteCount : 3;
  const lobes = Math.max(LIQUID_MIN_LOBES,
    Math.min(LIQUID_MAX_LOBES, Math.round(notes * 0.7 + comp * 4 + 1)));

  // Brighter, higher sounds sit the lobes further out; louder ones swell them.
  // The RATIO of spread to radius is what decides whether this reads as an
  // amoeba with arms or as one fused potato: the lobes have to stand clear of
  // one another and be bridged by a neck, not overlap outright. Spread must
  // stay comfortably above the lobe radius for the silhouette to articulate.
  const spreadR = 0.44 + clamp01(fp.centroid) * 0.22;
  const baseR = 0.15 + clamp01(fp.volMean) * 0.10;
  const twist = Number.isFinite(params.twist) ? params.twist : 0;

  const circles = [];
  for (let i = 0; i < lobes; i++) {
    // Even placement is the "ice" state; chaos pushes each lobe off its slot.
    const slot = (i / lobes) * Math.PI * 2 + twist * 0.6;
    const ang = slot + (rnd() - 0.5) * chaos * (Math.PI * 2 / lobes) * 1.4;
    const dist = spreadR * (1 + (rnd() - 0.5) * chaos * 0.9);
    const r = baseR * (1 + (rnd() - 0.5) * chaos * 1.1);
    circles.push({
      x: Math.cos(ang) * dist,
      y: Math.sin(ang) * dist,
      r: Math.max(0.06, r),
    });
  }

  // A centre lobe ties the arms into one body instead of a ring of islands.
  // Kept smaller than the arms: sized up to match them it dominates the
  // silhouette and the arms read as bumps on a disc rather than as limbs.
  circles.push({ x: 0, y: 0, r: Math.max(0.08, baseR * (0.5 + comp * 0.22)) });

  return circles;
}

// Blend radius: how far neighbouring lobes melt into one another. Sustained,
// tonal sounds pool into one soft mass; percussive ones stay articulated.
export function smoothOf(fp, params = {}) {
  const sustain = 1 - clamp01(fp.velocity);
  const base = 0.07 + sustain * 0.09;
  const scale = Number.isFinite(params.scale) ? params.scale : 1;
  return base * (0.7 + 0.3 * scale);
}

export function generate(fp, params = {}, onProgress) {
  const circles = buildCircles(fp, params);
  const smooth = smoothOf(fp, params);
  if (onProgress) onProgress(1);
  return {
    kind: 'blob',
    circles,
    smooth,
    // Contract stubs — the worker transfers these buffers and main.js checks
    // `kind` before ever handing them to the point-cloud renderer.
    positions: new Float32Array(0),
    attr: new Float32Array(0),
    strands: [],
  };
}
