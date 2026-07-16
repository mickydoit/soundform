// Paint mode pacing: the sound is the hand moving the brush. Loudness sets
// the stroke speed through an attack/release envelope; onsets add bursts;
// silence rests the brush. Pure and node-testable.

export const PAINT_MAX_POINTS = 600_000;
export const PAINT_MAX_POINTS_MOBILE = 200_000;

export class BrushPace {
  constructor() { this.env = 0; }
  // rms: current frame loudness; kickValue: onset envelope 0..1; dt: seconds.
  pointsThisFrame(rms, kickValue, dt) {
    const target = rms > 0.008 ? rms : 0;      // matches live SILENCE_RMS
    const tau = target > this.env ? 0.1 : 0.6; // fast attack, slower release
    this.env += (target - this.env) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
    if (this.env < 0.004) return 0;            // resting
    const rate = 400 + 22_000 * this.env + 6_000 * kickValue;
    return Math.min(Math.round(dt * rate), Math.round(dt * 40_000));
  }
}
