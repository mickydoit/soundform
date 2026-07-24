// js/trace.js — Tracedata → editable SVG/PDF. DOM/THREE-free (runs under node).
// Consumes imagetracer's tracedata; knows nothing about imagetracer itself.

import { sampleRamp, rgbToHex } from './palettes.js?v=45';

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
