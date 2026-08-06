// Voice → slider values. The live conductor feeds audio features in; this
// glides the real UI parameters toward them so the design is modulated through
// the same controls a user would reach for. Pure: no DOM, no THREE, no imports.

// Range each auto-driven parameter sweeps. Deliberately narrower than the
// slider's full span — the extremes of twist and scale are compositional
// choices, not something a voice should be able to slam into.
// NOTE: `scale` was removed at the user's request — the design resizing itself
// as you got louder was not wanted. Size is manual again (the Scale slider) and
// loudness reads through visibleFraction and clifford's relief instead.
export const AUTO_RANGE = {
  complexity:     [0.15, 1.0],
  twist:          [-0.9, 0.9],
  visibleFraction:[0.35, 1.0],
};

// Glide time constants, seconds. visibleFraction is fastest because it costs
// nothing (draw range only) and carries the immediate loudness response;
// twist is slowest because rotating geometry reads as motion, and fast motion
// looks like a glitch rather than a response.
export const AUTO_TAU = {
  complexity: 1.2,
  twist: 2.0,
  visibleFraction: 0.25,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;

// Which feature drives which parameter. One feature per parameter, so a change
// in the sound is attributable to a change in the design.
const DRIVER = {
  complexity: 'brightness',
  twist: 'roughness',
  visibleFraction: 'loudness',
};

// Same character axes the attractor uses, plus instantaneous loudness. Kept
// here rather than imported so this module stays a leaf.
export function featuresFromFingerprint(fp, loudness = 0) {
  const cons = fp.consonance ?? 0.5;
  return {
    brightness: clamp01(0.6 * fp.pitchMedian + 0.4 * (fp.centroid ?? 0.5)),
    roughness:  clamp01(0.5 * (1 - cons) + 0.3 * (fp.spread ?? 0) + 0.2 * (fp.velocity ?? 0)),
    energy:     clamp01(0.5 * (fp.volMean ?? 0.5) + 0.3 * (fp.volVar ?? 0) + 0.2 * (fp.attackSlope ?? 0)),
    loudness:   clamp01(loudness),
  };
}

export class AutoParams {
  constructor(initial = {}) {
    this.value = {};
    for (const k of Object.keys(AUTO_RANGE)) {
      const [lo, hi] = AUTO_RANGE[k];
      this.value[k] = initial[k] ?? (lo + hi) / 2;
    }
  }

  // Where each parameter wants to be for the current sound.
  targets(fx) {
    const out = {};
    for (const k of Object.keys(AUTO_RANGE)) {
      const [lo, hi] = AUTO_RANGE[k];
      out[k] = lerp(lo, hi, clamp01(fx[DRIVER[k]] ?? 0.5));
    }
    return out;
  }

  // Exponential glide, framerate-independent.
  step(fx, dt) {
    const t = this.targets(fx);
    for (const k of Object.keys(AUTO_RANGE)) {
      const a = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-4, AUTO_TAU[k]));
      const [lo, hi] = AUTO_RANGE[k];
      this.value[k] = Math.max(lo, Math.min(hi, this.value[k] + (t[k] - this.value[k]) * a));
    }
    return { ...this.value };
  }
}
