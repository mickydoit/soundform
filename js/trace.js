// js/trace.js — Tracedata → editable SVG/PDF. DOM/THREE-free (runs under node).
// Consumes imagetracer's tracedata; knows nothing about imagetracer itself.

import { sampleRamp, rgbToHex } from './palettes.js?v=48';

// N palette swatches sampled evenly across the active ramp. Index 0 is the
// background tone (ramp t=0). Quantization snaps background pixels to it; the
// SVG/PDF builders skip layer 0 and draw the background as a single rect.
export function paletteFromRamp(stops, levels) {
  const pal = [];
  for (let i = 0; i < levels; i++) {
    const t = levels > 1 ? i / (levels - 1) : 0;
    const [r, g, b] = sampleRamp(stops, t);
    pal.push({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: 255 });
  }
  return pal;
}

// Exact quadratic→cubic control-point elevation:
//   C1 = P0 + (2/3)(Q - P0),  C2 = P2 + (2/3)(Q - P2)
export function qToCubic(sx, sy, qx, qy, ex, ey) {
  return [
    sx + (2 / 3) * (qx - sx), sy + (2 / 3) * (qy - sy),
    ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey),
  ];
}

function pathToD(segments) {
  if (!segments.length) return '';
  const s0 = segments[0];
  let d = `M ${round(s0.x1)} ${round(s0.y1)}`;
  for (const s of segments) {
    if (s.type === 'Q') d += ` Q ${round(s.x2)} ${round(s.y2)} ${round(s.x3)} ${round(s.y3)}`;
    else d += ` L ${round(s.x2)} ${round(s.y2)}`;
  }
  return d + ' Z';
}

function round(v) { return Math.round(v * 100) / 100; }

// Tracedata → grouped SVG. One <g id="tone-NN"> per palette layer, skipping
// layer 0 (background). Every path in a layer — hole or not — is filled in the
// layer colour, reproducing imagetracer's opaque layer-stack model; the
// excluded background lets true background show through holes.
export function buildTraceSVG(tracedata, { background }) {
  const { width, height, layers, palette } = tracedata;
  const groups = [];
  for (let k = 1; k < layers.length; k++) {           // skip background layer 0
    const paths = layers[k];
    if (!paths || !paths.length) continue;
    const color = rgbToHex([palette[k].r / 255, palette[k].g / 255, palette[k].b / 255]);
    const body = paths
      .filter((p) => p.segments && p.segments.length)
      .map((p) => `    <path d="${pathToD(p.segments)}" fill="${color}"/>`)
      .join('\n');
    if (!body) continue;
    groups.push(`  <g id="tone-${String(k).padStart(2, '0')}" fill-rule="evenodd">\n${body}\n  </g>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...groups,
    '</svg>',
  ].join('\n');
}

// One traced path → jsPDF lines() input. `start` is the first anchor; each leg
// holds deltas relative to that segment's OWN start (the running point), so a
// cubic leg's three pairs are all offset from the point before the curve — the
// encoding jsPDF's lines() actually uses (chaining them corrupts every segment
// past the first, the 2026-07-23 bezier bug).
export function segmentsToPdfLegs(segments) {
  const start = [segments[0].x1, segments[0].y1];
  let cx = start[0], cy = start[1];
  const legs = [];
  for (const s of segments) {
    if (s.type === 'Q') {
      const [c1x, c1y, c2x, c2y] = qToCubic(cx, cy, s.x2, s.y2, s.x3, s.y3);
      legs.push([c1x - cx, c1y - cy, c2x - cx, c2y - cy, s.x3 - cx, s.y3 - cy]);
      cx = s.x3; cy = s.y3;
    } else {
      legs.push([s.x2 - cx, s.y2 - cy]);
      cx = s.x2; cy = s.y2;
    }
  }
  return { start, legs };
}

// Tracedata → PDF draw ops. One entry per palette layer except background (0);
// each carries an integer 0–255 rgb fill and its paths as jsPDF leg arrays.
export function buildTracePdfOps(tracedata, { background }) {
  const { width, height, layers, palette } = tracedata;
  const out = [];
  for (let k = 1; k < layers.length; k++) {
    const paths = (layers[k] || []).filter((p) => p.segments && p.segments.length);
    if (!paths.length) continue;
    out.push({
      color: { r: palette[k].r, g: palette[k].g, b: palette[k].b },
      paths: paths.map((p) => segmentsToPdfLegs(p.segments)),
    });
  }
  return { width, height, background: background ?? null, layers: out };
}
