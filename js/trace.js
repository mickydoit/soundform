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
