// Sound → pastel colour mapping for Live mode. Pure functions only —
// node-testable, no DOM/THREE. Pitch classes map to pastel hue anchors
// (C = lavender 270°, +30°/semitone); chord root picks the primary hue,
// the second-strongest pitch class the secondary; major leans warm+light,
// minor cool+deep; consonance drives saturation; centroid lifts the
// accent toward cream. Output feeds customRamp-shaped stops → buildLUT.
import { bestTriad } from './features.js?v=43';

export const PC_BASE_HUE = 270;      // C = lavender
export const BG_HEX = '#04040a';
const GLIDE_TAU = 0.5;               // seconds — hue/sat/light glide

export function pcHue(pc) {
  return (((PC_BASE_HUE + pc * 30) % 360) + 360) % 360;
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Shortest-arc hue blend: k=0 → a, k=1 → b.
export function mixHue(a, b, k) {
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;  // when equidistant, prefer forward direction
  return ((a + d * k) % 360 + 360) % 360;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function liveTarget(chroma, centroid) {
  const { root, major, score } = bestTriad(chroma);
  const consonance = clamp(score * 1.4, 0, 1);
  let second = (root + 7) % 12, sv = -1;
  for (let i = 0; i < 12; i++) if (i !== root && chroma[i] > sv) { sv = chroma[i]; second = i; }
  const warm = major ? -10 : 10;       // major → warm/rose side, minor → cool/blue
  const lShift = major ? 0.05 : -0.05;
  const s1 = clamp(0.22 + 0.45 * consonance, 0.15, 0.7);
  return {
    bg: BG_HEX,
    stops: [
      { h: mixHue(pcHue(root), pcHue(root) + warm, 1), s: s1,
        l: clamp(0.60 + lShift, 0.45, 0.95) },
      { h: mixHue(pcHue(second), pcHue(second) + warm, 1), s: clamp(s1 * 0.9, 0.15, 0.7),
        l: clamp(0.72 + lShift, 0.45, 0.95) },
      { h: mixHue(pcHue(second), 45, 0.3 + 0.5 * centroid), s: 0.3,
        l: clamp(0.86 + 0.08 * centroid, 0.45, 0.95) },
    ],
  };
}

// Exponential glide of the current colour state toward the target.
// cur === null snaps straight to the target (first frame of live).
export function glideStops(cur, target, dt) {
  if (!cur) return { bg: target.bg, stops: target.stops.map(s => ({ ...s })) };
  const k = 1 - Math.exp(-dt / GLIDE_TAU);
  return {
    bg: target.bg,
    stops: cur.stops.map((c, i) => {
      const t = target.stops[i];
      return { h: mixHue(c.h, t.h, k), s: c.s + (t.s - c.s) * k, l: c.l + (t.l - c.l) * k };
    }),
  };
}

export function stopsToHex(state) {
  return [
    [0, state.bg],
    [0.35, hslToHex(state.stops[0].h, state.stops[0].s, state.stops[0].l)],
    [0.7,  hslToHex(state.stops[1].h, state.stops[1].s, state.stops[1].l)],
    [1,    hslToHex(state.stops[2].h, state.stops[2].s, state.stops[2].l)],
  ];
}
