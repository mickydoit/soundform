// Cymatic standing-wave field for Liquid mode.
//
// This replaces the circle-SDF metaball that Liquid used to be. That model
// could only ever produce circles: every isocontour of `length(p-c)-r` is a
// circle, and a smooth union only fillets the joins — so no nodal line,
// lattice or star was expressible, and the result read as soap bubbles.
//
// Here the geometry comes from a MODAL FIELD instead. Psi is a superposition
// of plate/membrane eigenmodes; water is a SEPARATE thickness field that
// pools where |Psi| is near zero — the nodal lines. That is the actual
// physics of a vibrated liquid layer, and it is what produces connected
// watery paths, lattices and floral figures rather than isolated blobs.
//
// ⚠ Mirrored in density.js's CYMA_FRAG. If the two drift apart, the vector
// export stops matching what is on screen. Change them together.

const PI = Math.PI;

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

// The default state: silence. Everything else glides toward audio-derived
// targets, so every field parameter is a float — integers would snap the
// topology between modes instead of flowing through it.
export function idleState() {
  return {
    m: 3, n: 2,        // square-plate mode orders (continuous, not integers)
    kr: 7, ma: 3,      // radial wavenumber and angular order
    mix: 0.5,          // 0 = square Chladni, 1 = circular membrane
    amp: 0,            // drives how much water is gathered into the pattern
    fine: 0,           // fine ripple detail (spectral centroid)
    chaos: 0,          // layering / instability (noisy input)
    phase: 0,
    t: 0,              // seconds
    ripAmt: 0,         // transient impulse strength
    ripT: 9,           // seconds since that impulse
  };
}

// Modal superposition. Continuous in every parameter so the topology can
// morph rather than switch.
export function psi(x, y, s) {
  // Square plate (classic Chladni): the antisymmetric combination is what
  // gives the familiar crosses, lattices and stars. A single cos*cos product
  // only ever yields a plain grid.
  const u = x * 0.5 + 0.5, v = y * 0.5 + 0.5;
  const sq = Math.cos(s.m * PI * u) * Math.cos(s.n * PI * v)
           - Math.cos(s.n * PI * u) * Math.cos(s.m * PI * v);

  // Circular membrane. A true Bessel J_m is far too costly per pixel; its
  // ring structure is captured by a decaying cosine, which is all the
  // geometry needs — the radii of the nodal circles and the angular lobes.
  const r = Math.sqrt(x * x + y * y);
  const th = Math.atan2(y, x);
  // The angular term must be PERIODIC in theta, or the atan2 branch cut at
  // theta = +-pi draws a hard seam straight across the figure. cos(ma*th) is
  // only periodic for integer ma — and ma has to stay continuous so the
  // angular order can morph — so blend the two neighbouring integer orders.
  const m0 = Math.floor(s.ma), fm = s.ma - m0;
  const ang = Math.cos(m0 * th + s.phase) * (1 - fm)
            + Math.cos((m0 + 1) * th + s.phase) * fm;
  const rad = Math.cos(s.kr * r - s.ma * PI * 0.5 - PI * 0.25)
            / Math.sqrt(1 + s.kr * r * 0.6) * ang;

  let f = sq * (1 - s.mix) + rad * s.mix * 1.7;

  // Fine structure from brightness — a higher-order mode laid over the
  // fundamental, drifting slowly so the surface never looks frozen.
  if (s.fine > 0) {
    f += s.fine * 0.30
       * Math.cos(s.m * 2.7 * PI * u + s.t * 0.21)
       * Math.cos(s.n * 2.7 * PI * v - s.t * 0.17);
  }

  // Noisy input layers a second, detuned mode over the first, so broadband
  // sound reads as an unstable / doubled figure instead of a clean one.
  if (s.chaos > 0) {
    f += s.chaos * 0.45
       * (Math.cos((s.m + 1.7) * PI * u) * Math.cos((s.n + 0.6) * PI * v)
        - Math.cos((s.n + 0.6) * PI * u) * Math.cos((s.m + 1.7) * PI * v));
  }

  // A transient sends a ring travelling outward, decaying in time and radius.
  if (s.ripAmt > 0) {
    f += s.ripAmt * Math.sin(14 * r - s.ripT * 9)
       * Math.exp(-s.ripT * 1.6) * Math.exp(-r * 0.7);
  }

  // Gentle breathing so a sustained tone still lives.
  return f * (0.88 + 0.12 * Math.sin(s.t * 0.9));
}

// How much water stands at a point.
//
// Water is driven off the antinodes and collects along the nodal lines, so
// thickness is high where |Psi| is small. The band widens with amplitude:
// louder sound sweeps liquid out of a larger area and into the figure, which
// is exactly the "water flows into the pattern" behaviour.
export function nodalThickness(x, y, s) {
  const f = Math.abs(psi(x, y, s));
  const band = 0.05 + 0.34 * s.amp;
  let T = 1 - smoothstep(band * 0.30, band, f);
  // Soft plate boundary — the dish edge, not a hard crop.
  const r = Math.sqrt(x * x + y * y);
  T *= 1 - smoothstep(1.02, 1.30, r);
  return T;
}

// How strongly the pattern has taken hold. Below this, the liquid has not
// been organised yet and sits as scattered droplets.
export function gather(s) { return smoothstep(0.04, 0.34, s.amp); }

// Full thickness including idle droplets. `withDrops` is false for the vector
// export: the droplet term uses a sin-hash, which cannot be reproduced bit
// for bit between float32 GLSL and float64 JS (WebGL1 has no integer ops), so
// the export traces the cymatic structure only. Droplets are secondary detail
// and dissolve as soon as there is sound.
export function thickness(x, y, s, withDrops = true) {
  const g = gather(s);
  const nodal = nodalThickness(x, y, s);
  if (!withDrops) return nodal;
  return clamp01(nodal * g + droplets(x, y, s) * (1 - g));
}

function hash2(i, j) {
  const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

// Scattered idle pools. Deliberately irregular — a grid of jittered centres
// with per-cell radii, so they never read as repeated circles.
export function droplets(x, y, s) {
  const scale = 2.6;
  const gx = x * scale, gy = y * scale;
  const i0 = Math.floor(gx), j0 = Math.floor(gy);
  let best = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj;
      const h = hash2(i, j), h2 = hash2(i + 37.1, j - 11.7);
      if (h > 0.62) {
        const cx = i + 0.15 + 0.7 * h, cy = j + 0.15 + 0.7 * h2;
        const rad = 0.16 + 0.30 * h2;
        // Real droplets are rounded, slightly elongated puddles — not lobed
        // stars. Per-drop rotation and aspect vary them far more naturally
        // (and more water-like) than adding harmonics ever did; a strong
        // angular wobble just made every one a starfish.
        const rot = h * 6.2831853;
        const dx = gx - cx, dy = gy - cy;
        const qx = (dx * Math.cos(rot) + dy * Math.sin(rot)) / (0.66 + 0.7 * h2);
        const qy = -dx * Math.sin(rot) + dy * Math.cos(rot);
        const d = Math.sqrt(qx * qx + qy * qy);
        const a = Math.atan2(qy, qx);
        const rr = rad * (1 + 0.10 * Math.sin(a * 2 + h * 21) + 0.05 * Math.sin(a * 3 - h2 * 17));
        best = Math.max(best, 1 - smoothstep(rr * 0.45, rr, d));
      }
    }
  }
  const r = Math.sqrt(x * x + y * y);
  // Idle water is a secondary detail: thinner than gathered water, so the
  // resting state reads as a damp surface rather than as the subject.
  return best * 0.7 * (1 - smoothstep(1.02, 1.30, r));
}

// ── audio → field ──────────────────────────────────────────────────────
//
// Every mapping is continuous, and callers glide toward these rather than
// jumping, so the water morphs instead of snapping between figures.
export function targetFromFeatures(f) {
  const pitch = clamp01(f.pitchNorm ?? 0.4);
  const rms = clamp01(f.rms ?? 0);
  const centroid = clamp01(f.centroid ?? 0.3);
  const spread = clamp01(f.spread ?? 0.3);
  const conf = clamp01(f.pitchConf ?? 0.5);

  // Pitch sets the modal ORDER — the topology — not a colour or a size.
  // Low notes give few large lobes; high notes give fine, busy nodal work.
  return {
    m: 2 + pitch * 7.5,
    n: 1.5 + pitch * 5.0 + spread * 1.5,
    kr: 4.5 + pitch * 16,
    ma: 2 + pitch * 6,
    // A confident, tonal pitch reads as a circular membrane (floral, radial);
    // noisy or atonal input leans to the square plate (lattice, broken).
    mix: clamp01(0.25 + conf * 0.6 - spread * 0.35),
    amp: Math.min(1, rms * 3.2),
    fine: centroid,
    chaos: clamp01(spread * 0.8 + (1 - conf) * 0.5),
  };
}

// Exponential glide, frame-rate independent.
export function glide(state, target, dt, tau = 0.5) {
  const k = 1 - Math.exp(-dt / Math.max(1e-3, tau));
  for (const key of ['m', 'n', 'kr', 'ma', 'mix', 'amp', 'fine', 'chaos']) {
    if (target[key] !== undefined) state[key] += (target[key] - state[key]) * k;
  }
  return state;
}

// Advance time and decay the transient impulse.
export function advance(state, dt) {
  state.t += dt;
  state.ripT += dt;
  state.phase += dt * 0.15;
  state.ripAmt *= Math.exp(-dt * 1.2);
  return state;
}

export function kick(state, strength = 1) {
  state.ripAmt = Math.min(1.2, state.ripAmt + strength * 0.5);
  state.ripT = 0;
  return state;
}

// Signed field for contouring: negative inside the water.
export function makeWaterField(s, iso = 0.5) {
  return (x, y) => iso - thickness(x, y, s, false);
}
