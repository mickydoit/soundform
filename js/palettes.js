// Colour ramps shared by the screen tonemap LUT and SVG export gradients.
// Stops: [t, '#hex'] with t ascending 0→1. t=0 is the near-background tone.

export const PALETTES = {
  nebula:  { label: 'Nebula',  stops: [[0, '#050614'], [0.25, '#3b2a6e'], [0.55, '#9d5bd2'], [0.8, '#f2a7d8'], [1, '#ffffff']] },
  ember:   { label: 'Ember',   stops: [[0, '#0a0505'], [0.3, '#6e1e2a'], [0.6, '#e2603a'], [0.85, '#ffc266'], [1, '#fff7e0']] },
  aurora:  { label: 'Aurora',  stops: [[0, '#071010'], [0.3, '#7fd8c4'], [0.6, '#c5b8f0'], [0.85, '#f4c6d7'], [1, '#ffffff']] },
  glacier: { label: 'Glacier', stops: [[0, '#040a14'], [0.3, '#1e4f8a'], [0.6, '#4fa8d8'], [0.85, '#bde8f5'], [1, '#ffffff']] },
  rosegold:{ label: 'Rosé',    stops: [[0, '#120a0e'], [0.3, '#8a4a5e'], [0.6, '#d891a0'], [0.85, '#f2d3b8'], [1, '#fff8f0']] },
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function sampleRamp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = hexToRgb(c0), b = hexToRgb(c1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function buildLUT(stops) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = sampleRamp(stops, i / 255);
    out[i * 4] = Math.round(c[0] * 255);
    out[i * 4 + 1] = Math.round(c[1] * 255);
    out[i * 4 + 2] = Math.round(c[2] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function rgbToHex([r, g, b]) {
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Custom ramp from user colour pickers: background-dark → c1 → c2 → c3
export function customRamp(bgHex, c1, c2, c3) {
  return [[0, bgHex], [0.35, c1], [0.7, c2], [1, c3]];
}
