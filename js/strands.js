// Strand → editable SVG path machinery. DOM/THREE-free (works under node).

import { sampleRamp, rgbToHex, hexToRgb } from './palettes.js?v=44';

export function projectStrand(strand, m, w, h) {
  const pts = [];
  let depthSum = 0, count = 0;
  for (let i = 0; i < strand.length; i += 3) {
    const x = strand[i], y = strand[i + 1], z = strand[i + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) continue;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    const cz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cw;
    if (cz < -1 || cz > 1) continue;
    pts.push([(cx + 1) * 0.5 * w, (1 - cy) * 0.5 * h]);
    depthSum += cz; count++;
  }
  return { pts, depth: count ? depthSum / count : 1 };
}

// Ramer–Douglas–Peucker, iterative (stack), epsilon in pixels. Operates on
// an open chain — the start/end chord must have real length (see rdp()).
function rdpOpen(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Ramer–Douglas–Peucker, epsilon in pixels. The standard algorithm measures
// each point's perpendicular distance from the start-end chord — when the
// chord is ~zero length (a closed or near-closed loop, e.g. a full-sweep
// ring strand), that distance is undefined and every point looks collinear,
// collapsing the whole loop to 2 duplicate points. Detect that case and
// split the loop at its farthest point first, simplifying each half as an
// open chain.
export function rdp(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  if (Math.hypot(bx - ax, by - ay) >= epsilon) return rdpOpen(pts, epsilon);
  let farI = 0, farD = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
    if (d > farD) { farD = d; farI = i; }
  }
  if (farD < epsilon) return [pts[0]]; // truly a dot at this scale
  const first = rdpOpen(pts.slice(0, farI + 1), epsilon);
  const second = rdpOpen(pts.slice(farI), epsilon);
  return first.concat(second.slice(1));
}

const SIMPLIFY_BUDGET = 500;
const SIMPLIFY_GROWTH = 1.3;
const SIMPLIFY_MAX_ATTEMPTS = 6;

// Adaptive RDP: loosen epsilon until the strand fits the budget instead of
// ever dropping it outright. Dense strands get coarser, never invisible.
export function simplifyToBudget(pts, epsilon0 = 1.4, budget = SIMPLIFY_BUDGET) {
  let epsilon = epsilon0;
  let out = rdp(pts, epsilon);
  for (let i = 1; i < SIMPLIFY_MAX_ATTEMPTS && out.length > budget; i++) {
    epsilon *= SIMPLIFY_GROWTH;
    out = rdp(pts, epsilon);
  }
  return out;
}

// Catmull-Rom through pts -> absolute cubic bezier control points.
export function catmullRomToBezier(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    segs.push({ c1, c2, end: p2 });
  }
  return segs;
}

export function toBezierPath(pts) {
  if (pts.length < 2) return '';
  const f = v => +v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (const { c1, c2, end } of catmullRomToBezier(pts)) {
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d;
}

// Relative bezier-curve deltas for jsPDF's lines() API: per jsPDF's actual
// implementation, all three pairs in a 6-value entry (c1, c2, end) are
// offsets from the point BEFORE the curve started — not chained from one
// to the next. Encoding them as chained deltas (c2 relative to c1, end
// relative to c2) silently corrupts every curve but the first in a run.
export function toRelativeBezierLegs(start, segments) {
  const legs = [];
  let cx = start[0], cy = start[1];
  for (const { c1, c2, end } of segments) {
    legs.push([c1[0] - cx, c1[1] - cy, c2[0] - cx, c2[1] - cy, end[0] - cx, end[1] - cy]);
    cx = end[0]; cy = end[1];
  }
  return legs;
}

// Coarse 3D occupancy grid over [-1.3, 1.3]³, max-normalised.
export function buildDensityGrid(positions, res = 24) {
  const grid = new Float32Array(res * res * res);
  const idx = v => Math.max(0, Math.min(res - 1, Math.floor((v + 1.3) / 2.6 * res)));
  const step = Math.max(1, Math.floor(positions.length / 3 / 300000)); // sample big clouds
  let max = 1e-9;
  for (let i = 0; i < positions.length; i += 3 * step) {
    const g = (idx(positions[i]) * res + idx(positions[i + 1])) * res + idx(positions[i + 2]);
    grid[g]++;
    if (grid[g] > max) max = grid[g];
  }
  return {
    sample(x, y, z) {
      return grid[(idx(x) * res + idx(y)) * res + idx(z)] / max;
    },
  };
}

// Tone-carrying strands (cymatics fine-fringe arcs): flat palette colour per
// quantized tone class instead of a density-grid gradient — the raster
// tonemap analogue, and Illustrator "Select → Same → Stroke Color" friendly.
// TONE_CLASSES must equal TONE_LEVELS in js/generators/cymatics.js.
export const TONE_CLASSES = 5;
const TONE_RAMP_POS = [0.45, 0.6, 0.72, 0.85, 0.97];
const TONE_OPACITY  = [0.55, 0.68, 0.78, 0.88, 0.97];
const TONE_WIDTH    = [0.7, 0.975, 1.25, 1.525, 1.8];

export function toneClass(tone) {
  return Math.max(0, Math.min(TONE_CLASSES - 1, Math.floor(tone * TONE_CLASSES)));
}

// Strands-slider mapping for tone strands: keep an evenly spaced subset of
// whole rings — a ring's tone runs only read together, so individual arcs
// are never stride-dropped the way legacy strands are.
export function selectRingSubset(strands, frac) {
  const ringIds = [...new Set(strands.map((s) => s.ring))].sort((a, b) => a - b);
  const wantRings = Math.max(8, Math.min(ringIds.length, Math.round(ringIds.length * frac)));
  const stride = ringIds.length / wantRings;
  const keep = new Set();
  for (let i = 0; i < wantRings; i++) keep.add(ringIds[Math.floor(i * stride)]);
  return strands.filter((s) => keep.has(s.ring));
}

// Strand → simplified 2D path + resolved color/weight, ready for any
// vector format (SVG gradient stops, PDF flat-color runs) to draw from.
// Tone strands ({pts,tone,band,ring}) style from their tone class; bare
// arrays keep the density-grid gradient styling.
export function buildVectorPaths({ strands, positions, mvp, width, height, stops, weight }) {
  let grid = null; // built lazily — tone strands never sample it
  const items = [];

  strands.forEach((strand, si) => {
    const raw = strand.pts ?? strand;
    const { pts, depth } = projectStrand(raw, mvp, width, height);
    if (pts.length < 2) return;
    const simplified = simplifyToBudget(pts, 1.4, SIMPLIFY_BUDGET);
    if (simplified.length < 2) return;
    const ends = {
      x1: simplified[0][0], y1: simplified[0][1],
      x2: simplified[simplified.length - 1][0], y2: simplified[simplified.length - 1][1],
    };
    if (strand.pts) {
      const q = toneClass(strand.tone);
      items.push({
        si, depth, points: simplified,
        tone: strand.tone, toneClass: q + 1, band: strand.band, ring: strand.ring,
        color: rgbToHex(sampleRamp(stops, TONE_RAMP_POS[q])),
        strokeWidth: TONE_WIDTH[q] * weight,
        opacity: TONE_OPACITY[q],
        ...ends,
      });
      return;
    }
    grid ??= buildDensityGrid(positions);
    let dSum = 0, dN = 0;
    for (let i = 0; i < raw.length; i += 30) {
      dSum += grid.sample(raw[i], raw[i + 1], raw[i + 2]); dN++;
    }
    const density = dN ? dSum / dN : 0.3;
    items.push({
      si, depth, density, points: simplified,
      c1: rgbToHex(sampleRamp(stops, 0.35 + density * 0.3)),
      c2: rgbToHex(sampleRamp(stops, 0.6 + density * 0.4)),
      strokeWidth: (0.6 + density * 3.4) * weight,
      opacity: 0.35 + density * 0.55,
      ...ends,
    });
  });

  items.sort((a, b) => b.depth - a.depth); // far strands first (painter's order)
  return items;
}

const PDF_RUN_SEGMENTS = 6; // bezier segments per solid-color run

// jsPDF's core API has no per-stroke gradient — approximate the SVG
// gradient by splitting each stroke into short flat-color runs.
export function lerpHex(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// Pure PDF draw-op builder: same path data as SVG, pre-split into
// jsPDF-lines()-ready runs. No jsPDF/DOM dependency — js/exporter.js wires
// this into an actual document.
export function buildPdfOps({ strands, positions, mvp, width, height, stops, weight, background }) {
  const items = buildVectorPaths({ strands, positions, mvp, width, height, stops, weight });
  const strokeStrokes = items.map((it) => {
    const segs = catmullRomToBezier(it.points);
    if (it.color) {
      // Tone strand: one flat-color run covers the whole path.
      return {
        runs: [{ start: it.points[0], legs: toRelativeBezierLegs(it.points[0], segs), color: it.color }],
        strokeWidth: it.strokeWidth, opacity: it.opacity,
      };
    }
    const runs = [];
    for (let i = 0; i < segs.length; i += PDF_RUN_SEGMENTS) {
      const chunk = segs.slice(i, i + PDF_RUN_SEGMENTS);
      const start = i === 0 ? it.points[0] : segs[i - 1].end;
      const t = (i + chunk.length / 2) / Math.max(1, segs.length);
      runs.push({ start, legs: toRelativeBezierLegs(start, chunk), color: lerpHex(it.c1, it.c2, t) });
    }
    return { runs, strokeWidth: it.strokeWidth, opacity: it.opacity };
  });
  return { width, height, background: background ?? null, strokes: strokeStrokes };
}
