// Live growth engine: each sound event becomes a small fragment placed on a
// golden-angle spiral that blooms outward from the centre — the session grows
// like tree rings. Pure math + typed-array bookkeeping; node-testable.

export const FRAGMENT_POINTS = 10000;
export const FRAGMENT_POINTS_MOBILE = 7000;
export const GROW_MAX_POINTS = 1_200_000;
export const GROW_MAX_POINTS_MOBILE = 400_000;
export const HALF_LIFE = 180;   // seconds to half brightness in grow-fade
export const PRUNE_W = 0.04;    // fragments dimmer than this are dropped
export const GOLDEN = 2.39996;  // golden angle, radians

// Where the index-th fragment lands: spiral angle, asymptotic bloom radius,
// loudness → size, pitch → tilt and (volumetric modes) lift.
export function placeFragment(index, fp, flat = false) {
  const angle = index * GOLDEN;
  const radius = 0.12 + 0.95 * (1 - Math.exp(-index / 22));
  const scale = 0.10 + 0.22 * (fp.volMean ?? 0.5);
  const rotY = angle;
  const rotX = ((fp.pitchMedian ?? 0.5) - 0.5) * 1.2;
  const y = flat ? 0 : ((fp.pitchMedian ?? 0.5) - 0.5) * 0.5;
  return { angle, radius, scale, rotX, rotY,
           x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
}

export class GrowComposite {
  constructor({ maxPoints = GROW_MAX_POINTS, fade = true } = {}) {
    this.maxPoints = maxPoints;
    this.fade = fade;
    this.clear();
  }

  clear() { this.frags = []; this.total = 0; this.index = 0; this.full = false; }

  // Transform a fragment by its placement (scale → rotX → rotY → translate)
  // and store it. Returns false when a keep-mode composite is full.
  append(positions, attr, fp, nowSec, flat = false) {
    const n = positions.length / 3;
    if (this.total + n > this.maxPoints) {
      if (!this.fade) { this.full = true; return false; }
      while (this.frags.length && this.total + n > this.maxPoints) {
        this.total -= this.frags.shift().n;   // fade mode: oldest gives way
      }
    }
    const pl = placeFragment(this.index, fp, flat);
    const cy = Math.cos(pl.rotY), sy = Math.sin(pl.rotY);
    const cx = Math.cos(pl.rotX), sx = Math.sin(pl.rotX);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3] * pl.scale;
      const y = positions[i * 3 + 1] * pl.scale;
      const z = positions[i * 3 + 2] * pl.scale;
      const y1 = y * cx - z * sx, z1 = y * sx + z * cx;      // tilt (X axis)
      const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;   // spin (Y axis)
      out[i * 3] = x2 + pl.x;
      out[i * 3 + 1] = y1 + pl.y;
      out[i * 3 + 2] = z2 + pl.z;
    }
    this.frags.push({ positions: out, attr: attr.slice(), birth: nowSec, n });
    this.total += n;
    this.index++;
    return true;
  }

  // Fade mode housekeeping: drop fragments dimmer than PRUNE_W.
  ageWeights(nowSec) {
    if (!this.fade) return false;
    const before = this.frags.length;
    this.frags = this.frags.filter((f) => {
      const w = Math.pow(0.5, (nowSec - f.birth) / HALF_LIFE);
      if (w < PRUNE_W) { this.total -= f.n; return false; }
      return true;
    });
    return this.frags.length !== before;
  }

  flatten(nowSec) {
    const positions = new Float32Array(this.total * 3);
    const attr = new Float32Array(this.total);
    const weights = new Float32Array(this.total);
    let o = 0;
    for (const f of this.frags) {
      positions.set(f.positions, o * 3);
      attr.set(f.attr, o);
      const w = this.fade ? Math.pow(0.5, (nowSec - f.birth) / HALF_LIFE) : 1;
      weights.fill(w, o, o + f.n);
      o += f.n;
    }
    return { positions, attr, weights, count: this.total };
  }
}
