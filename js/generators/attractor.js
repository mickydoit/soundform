import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';

// Five systems. Harmony class + noteCount pick the system; pitch sets
// coefficients inside pre-validated chaotic ranges; velocity adds turbulence.
const lerp = (a, b, t) => a + (b - a) * t;

// Complexity biases a coefficient toward the end of its range that reads as
// more elaborate. cx = 0.5 is neutral (the axis-derived value, unchanged);
// cx = 1 pushes fully toward `toward`; cx = 0 fully away. The push is capped
// at 30% of the remaining distance (narrowed from an initial 60%: measurement
// showed aizawa's `d` crosses a bifurcation boundary well before the 60% mark
// — cell occupancy nearly doubles and the design jumps to a different-looking
// regime rather than a modulated one — so coefficients never reach the
// validated range's edge, where validateOccupancy starts rejecting and
// generate() falls back to the capture path — a fallback discards live
// variance entirely).
const complexify = (v, lo, hi, cx, toward) => {
  const t = Math.max(-1, Math.min(1, (cx - 0.5) * 2)) * 0.3;
  const end = toward === 'hi' ? hi : lo;
  const away = toward === 'hi' ? lo : hi;
  return t >= 0 ? lerp(v, end, t) : lerp(v, away, -t);
};

const SYSTEMS = {
  thomas: {
    dt: 0.06, flow: true,
    coeffs: fp => ({ b: lerp(0.10, 0.165, 1 - fp.pitchMedian) }),
    // bx/by/bz are live-only. They are undefined on the capture path, where all
    // three fall back to the single symmetric b — byte-identical to before.
    step: (p, c) => [
      Math.sin(p[1]) - (c.bx ?? c.b) * p[0],
      Math.sin(p[2]) - (c.by ?? c.b) * p[1],
      Math.sin(p[0]) - (c.bz ?? c.b) * p[2]],
    // Thomas has a single damping term, so pitch alone barely moves it. Equal
    // damping on all three axes is the *symmetric special case*; mild per-axis
    // asymmetry re-lobes the knot. Asymmetry stays gentle because thomas already
    // sits close to the occupancy check's 400-cell floor, and a strong split
    // tips it into a limit cycle (b also stays under the b ≈ 0.208 boundary).
    liveCoeffs: (c, ax, cx = 0.5) => {
      const b = complexify(lerp(0.168, 0.098, ax[4]), 0.168, 0.098, cx, 'hi');
      c.b = b;
      c.bx = b * lerp(0.93, 1.07, ax[1]);
      c.by = b * lerp(0.93, 1.07, ax[2]);
      c.bz = b * lerp(0.93, 1.07, ax[3]);
    },
    liveTarget: safe => ({ ...safe, bx: safe.b, by: safe.b, bz: safe.b }),
  },
  halvorsen: {
    dt: 0.012, flow: true,
    coeffs: fp => ({ a: lerp(1.4, 2.2, fp.pitchMedian) }),
    // kx/ky/kz are the cross-coupling, a symmetric 4 on the capture path.
    step: (p, c) => {
      const kx = c.kx ?? 4, ky = c.ky ?? 4, kz = c.kz ?? 4;
      return [
        -c.a * p[0] - kx * p[1] - kx * p[2] - p[1] * p[1],
        -c.a * p[1] - ky * p[2] - ky * p[0] - p[2] * p[2],
        -c.a * p[2] - kz * p[0] - kz * p[1] - p[0] * p[0]];
    },
    // Halvorsen is the most fragile of the four — a polynomial system that
    // diverges under Euler outside a tight band, so `a` hugs the classic 1.4.
    // `a` alone is nearly useless as a live knob anyway: it mostly changes the
    // attractor's SIZE, and finalize() pins r95 = 1, normalising that away.
    // The visible knob is breaking the three-fold cyclic symmetry.
    //
    // `spread` and `bias` are DELIBERATELY separate terms carrying two
    // different jobs. `spread` is the ax-driven asymmetry gain: it is what
    // makes consecutive live regenerations of the SAME voice look alike, so
    // it stays at its original, narrow, pre-complexity-lever magnitude
    // (0.04 — an effective ±4% split, matching thomas's ±7% and lorenz's
    // analogous terms). A widened version of this exact term (0.14..0.34,
    // tried first) made the Complexity slider register, but it also
    // multiplied halvorsen's sensitivity to ordinary fingerprint SAMPLING
    // NOISE by 3.5-8.5x, because that noise flows through the very same
    // `ax` this term multiplies — consecutive-regeneration cell-occupancy
    // Jaccard (250k points, four voices) fell to 0.038-0.375 min / 13-36 of
    // 78 steps under 0.70, the worst of the four flow systems, exactly when
    // this branch raised the regeneration rate to 4 Hz. Reverting `spread`
    // alone restores it to the best of the four: min 0.518-0.852, ~2/152
    // steps under 0.70 across a wider voice sweep.
    //
    // `bias` is complexity's OWN lever: a small additive skew driven by `cx`
    // directly, not multiplied against `ax`, so it cannot amplify fingerprint
    // drift the way the old shared term did. It only has to move kx/ky/kz
    // apart from each other, not track the sound, so ±4% (cx: 0..1 spans
    // ±0.04) is enough to clear the project's complexity-lever bar (worst
    // voice overlap 0.35-0.79 across all six SPEAKERS profiles, comfortably
    // under the 0.85 ceiling and 0.15 floor) without reopening the
    // continuity regression — larger bias magnitudes (tried 0.16-0.36) hit a
    // halvorsen bifurcation and made both metrics worse, not just the second.
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.a = lerp(1.36, 1.92, ax[4]);
      const k = lerp(3.88, 4.12, ax[1]);
      const spread = 0.04;
      const bias = (cx - 0.5) * 0.08;              // -0.04 .. 0.04
      c.kx = k * (1 + spread * (ax[1] * 2 - 1) + bias);
      c.ky = k * (1 + spread * (ax[2] * 2 - 1) - bias);
      c.kz = k * (1 + spread * (ax[3] * 2 - 1));
    },
    liveTarget: safe => ({ ...safe, kx: 4, ky: 4, kz: 4 }),
  },
  aizawa: {
    dt: 0.015, flow: true,
    coeffs: fp => ({ a: 0.95, b: 0.7, c: 0.6, d: lerp(3.0, 3.9, fp.pitchMedian), e: lerp(0.2, 0.3, fp.centroid), f: 0.1 }),
    step: (p, c) => [
      (p[2] - c.b) * p[0] - c.d * p[1],
      c.d * p[0] + (p[2] - c.b) * p[1],
      c.c + c.a * p[2] - (p[2] ** 3) / 3 - (p[0] ** 2 + p[1] ** 2) * (1 + c.e * p[2]) + c.f * p[2] * p[0] ** 3],
    // a/b/c/f were fixed constants, so only two of six coefficients ever heard
    // the sound. All six move now, around the classic (0.95, 0.7, 0.6, 3.5,
    // 0.25, 0.1); f stays tight because it scales an x³ term that diverges
    // quickly.
    //
    // I2: aizawa collapsed for calm low voices even with complexify() ablated
    // to a no-op — this is pre-existing sensitivity in b/e/a/c/f, which used
    // to span their FULL listed range on raw `ax`, not a complexity-lever
    // defect. Measured consecutive-regeneration cell-occupancy Jaccard (250k,
    // one voice) as low as 0.025-0.155 with two-step-wide dips. `a` in
    // particular sits against the "a > 1 diverges" boundary, so noise in ax[2]
    // could push it into a near-critical regime every few ticks.
    // b/e/a/c/f are now narrow bands around the classic values (roughly
    // ±3-6%, matching thomas/halvorsen's discipline elsewhere in this file)
    // so per-tick fingerprint sampling noise no longer swings a coefficient
    // across its whole range or near a bifurcation. `d` keeps a narrow
    // ax-driven band too, but complexify() still targets the ORIGINAL wide
    // 3.00..3.95 bounds — complexify()'s push is a fixed fraction of
    // (bound − base) regardless of how narrow the base band is, so
    // complexity's swing is unchanged while ax-driven drift on `d` is not.
    // Measured after: min 0.678 (up from 0.420) on the four-voice set used
    // for halvorsen, 0/152 steps under 0.50 (was 2/152); a wider 28-voice
    // sweep held min 0.615, 5/392 steps under 0.70. complexify()'s own
    // worst-voice separation is 0.811-0.875 (six SPEAKERS profiles), still
    // under the system's 0.90 ceiling.
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.d = complexify(lerp(3.35, 3.60, ax[4]), 3.00, 3.95, cx, 'hi');
      c.b = lerp(0.68, 0.72, ax[0]);
      c.e = lerp(0.235, 0.265, ax[1]);
      c.a = lerp(0.93, 0.97, ax[2]);   // a > 1 grows the z term until it diverges
      c.c = lerp(0.575, 0.625, ax[3]);
      c.f = lerp(0.093, 0.107, ax[2]);
    },
  },
  // Lorenz butterfly — replaces Dadras, which was unstable under plain Euler
  // (diverged or fell into limit cycles across most of its coefficient range).
  // Lorenz is robustly chaotic for r ≈ 28–45 and integrates cleanly at this dt.
  lorenz: {
    dt: 0.007, flow: true,
    coeffs: fp => ({ s: lerp(9, 11, fp.centroid), r: lerp(29, 44, fp.pitchMedian), b: 8 / 3 + fp.spread * 0.4 }),
    step: (p, c) => [
      c.s * (p[1] - p[0]),
      p[0] * (c.r - p[2]) - p[1],
      p[0] * p[1] - c.b * p[2]],
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.r = complexify(lerp(28.0, 46.0, ax[4]), 28.0, 46.0, cx, 'hi');
      c.s = lerp(8.5, 12.5, ax[2]);
      c.b = lerp(2.35, 3.25, ax[1]);
    },
  },
  sinemap: {
    flow: false, // discrete map, like the reference sine-map images
    coeffs: (fp, rnd) => ({
      a: lerp(1.2, 4.2, fp.contour[1]), b: lerp(1.2, 4.2, fp.contour[3]), c: lerp(1.2, 4.2, fp.contour[5]),
      d: lerp(-1.3, 1.3, fp.centroid), e: lerp(-1.3, 1.3, fp.spread), f: lerp(-1.3, 1.3, fp.volMean),
      g: rnd() * Math.PI * 2, h: rnd() * Math.PI * 2, i: rnd() * Math.PI * 2,
    }),
    step: (p, c) => [
      Math.sin(c.a * p[1]) + c.d * Math.sin(c.b * p[2] + c.g),
      Math.sin(c.b * p[2]) + c.e * Math.sin(c.c * p[0] + c.h),
      Math.sin(c.c * p[0]) + c.f * Math.sin(c.a * p[1] + c.i)],
  },
};

// Smooth, LOCALITY-PRESERVING character axes for live variance: each axis is
// a clamped linear blend of continuous fingerprint channels, so similar
// sounds land on nearby coefficients (steady sound = stable design) while
// different sound characters still sweep the whole range. Seed-free.
// (A fract-hash was tried here first and reverted: it made ±2% window drift
// teleport across the design space — designs read as random, not
// sound-driven.)
function liveAxes(fp) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const cons = fp.consonance ?? 0.5;
  return [
    clamp01(0.6 * fp.pitchMedian + 0.4 * fp.centroid),                        // brightness
    clamp01(0.5 * (1 - cons) + 0.3 * fp.spread + 0.2 * fp.velocity),          // roughness
    clamp01(0.5 * (fp.volMean ?? 0.5) + 0.3 * (fp.volVar ?? 0) + 0.2 * (fp.attackSlope ?? 0)), // energy
    clamp01(0.6 * fp.velocity + 0.4 * (fp.attackSlope ?? 0)),                 // percussiveness
  ];
}

// Real sound occupies only a narrow band of each axis. Measured across seven
// speech profiles run through buildFingerprint, brightness spans 0.12–0.36 and
// roughness 0.34–0.51 of the nominal 0–1 — speech F0 covers barely a quarter of
// the 6-octave pitch scale, and a 4s window averages the rest toward the middle.
// Driving coefficients straight off those leaves each system's validated range
// almost unexplored, which is why every speaker collapsed onto one design.
//
// `expandAxes` re-centres each axis on its real-world midpoint and stretches it
// through a tanh. The middle spreads out, the tails saturate smoothly instead of
// clamping flat (so a whistle or a clap still reaches the extremes), and the
// mapping stays monotonic and seed-free — a small drift is still a small move,
// which is what keeps a steady sound on a stable design.
const AXIS_CENTRE = [0.26, 0.40, 0.32, 0.48];
const AXIS_GAIN = 3.4;

// Pitch gets a fifth axis of its own, with a steeper gain. It is the most
// audible difference between two voices, but liveAxes only ever sees it blended
// 60/40 with centroid into `brightness` — which puts a male and a female
// speaker just 0.09 apart there, so the single most obvious thing about a voice
// was the thing most averaged away. Speech F0 occupies roughly 0.13–0.40 of the
// 6-octave scale, hence the low centre and the hard stretch.
const PITCH_CENTRE = 0.26, PITCH_GAIN = 4;

// The pitch axis is HALF stretched, half raw. A pure tanh centred on the speech
// band saturates everything above it — musical pitch 0.55 and 0.85 both map to
// ~0.95, so a chord and a whistle become the same input. Averaging the stretch
// with the raw value keeps the speech band expanded while the upper register
// still spreads monotonically across its own range.
function pitchAxis(fp) {
  const stretched = 0.5 + 0.5 * Math.tanh(PITCH_GAIN * (fp.pitchMedian - PITCH_CENTRE));
  return 0.5 * stretched + 0.5 * fp.pitchMedian;
}

// -> [brightness, roughness, energy, percussiveness, pitch], all expanded.
function expandAxes(axes, fp) {
  const out = axes.map((v, i) => 0.5 + 0.5 * Math.tanh(AXIS_GAIN * (v - AXIS_CENTRE[i])));
  out.push(pitchAxis(fp));
  return out;
}

// CAPTURE-PATH routing. Harmony picks the system for a recorded take, and this
// must not change: test/snapshot.test.js pins recorded output by checksum.
export function pickSystem(fp) {
  if (fp.pitchConfidence < 0.35 || fp.velocity > 0.75) return 'sinemap'; // percussive/noisy
  if (fp.consonance > 0.55 && fp.majorLeaning) return fp.noteCount <= 3 ? 'thomas' : 'aizawa';
  if (fp.consonance > 0.55) return 'halvorsen'; // minor
  return 'lorenz'; // dissonant
}

// LIVE routing. Harmony is the wrong selector for a live mic: chroma
// triad-matching scores ordinary voiced speech as tonal (consonance 0.61–0.77
// measured), so every speaker cleared the > 0.55 gate and landed on aizawa or
// halvorsen — two designs, whatever anyone said. And system identity dominates
// everything else: two designs from the same system overlap 0.60–0.88 by cell
// occupancy, two from different systems only 0.10–0.39. No coefficient inside a
// system's stable band escapes its silhouette (aizawa always reads as a sphere
// with an axial spike), so variety has to come from the routing.
//
// Live therefore routes on two axes you can hear yourself crossing: vocal
// REGISTER (expanded pitch) and DELIVERY (percussiveness — calm vs animated).
// Roughness was the obvious second axis and is the wrong one: all seven speech
// profiles measured 0.34–0.51 on it, clustered right on the boundary, which
// separates poorly AND flips easily.
//
// This is NOT the v=34 fract-hash that got reverted. The boundaries are fixed
// and the axes are continuous and seed-free, so one voice maps to one system
// every time — no teleporting between designs on window drift.
// Register is split three ways, not two. Two would put a mid chord and a high
// whistle in the same cell — speech only spans the bottom of the pitch scale,
// so a boundary placed to separate voices leaves everything musical above it
// lumped together. LOW/MID covers the vocal range, HIGH catches whistles and
// the top of the singing register.
const REGISTER_LOW = 0.38, REGISTER_HIGH = 0.80;

export function pickSystemLive(fp) {
  // Breathy, unvoiced or percussive input keeps the discrete sine-map web.
  if (fp.pitchConfidence < 0.35 || fp.velocity > 0.75) return 'sinemap';
  const ax = expandAxes(liveAxes(fp), fp);
  const calm = ax[3] < 0.5;
  if (ax[4] < REGISTER_LOW) return calm ? 'halvorsen' : 'lorenz';
  if (ax[4] < REGISTER_HIGH) return calm ? 'aizawa' : 'thomas';
  return calm ? 'thomas' : 'lorenz';   // six cells over four flow systems
}

function cloudStdDev(pos, n) {
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) m[d] += pos[i * 3 + d] / n;
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) s[d] += (pos[i * 3 + d] - m[d]) ** 2 / n;
  return Math.sqrt(s[0] + s[1] + s[2]);
}

// Validate the FINALIZED (normalized) output: catches fat-tail outliers that
// computeNormalization's r95 scaling can't see (a tight core with rare far
// excursions still gets scale=1/r95, sending those excursions to huge maxAbs).
// Stride-sampled for speed. NaN/Infinity fail both checks naturally (maxAbs
// becomes NaN/Infinity, which is never <= 1.8; std sums to NaN, never >= 0.2).
function validateFinalized(out) {
  const n = out.positions.length / 3;
  const stride = 7;
  let count = 0;
  let maxAbs = 0;
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i += stride) {
    for (let d = 0; d < 3; d++) {
      const v = out.positions[i * 3 + d];
      maxAbs = Math.max(maxAbs, Math.abs(v));
      m[d] += v;
    }
    count++;
  }
  if (count === 0) return false;
  for (let d = 0; d < 3; d++) m[d] /= count;
  for (let i = 0; i < n; i += stride) {
    for (let d = 0; d < 3; d++) s[d] += (out.positions[i * 3 + d] - m[d]) ** 2;
  }
  const std = [0, 1, 2].map(d => Math.sqrt(s[d] / count));
  const stdSum = std[0] + std[1] + std[2];
  return maxAbs <= 1.8 && stdSum >= 0.2;
}

// Validate the FINALIZED strands: the trajectory continues for ~134k Euler
// steps past the cloud (strandCount * stepsPer), and for polynomial flow
// systems (halvorsen, dadras) that extension can escape the basin even when
// the cloud itself validated clean (validateFinalized only ever saw the
// cloud). Stride-sampled (every 5th value) per strand for speed, but every
// strand is checked — a blowup only needs to hit one strand to poison the
// render. NaN/Infinity fail the finite check naturally; a merely-large but
// finite escape is caught by the |v| <= 2.5 bound (matches checkGenerator's
// maxAbs <= 2.5 contract).
function validateStrands(strands) {
  const stride = 5;
  for (const s of strands) {
    for (let i = 0; i < s.length; i += stride) {
      const v = s[i];
      if (!Number.isFinite(v) || Math.abs(v) > 2.5) return false;
    }
  }
  return true;
}

// Detect periodic collapse (limit cycles / low-dimensional loops) that the
// bounded/std checks above miss: a 1D closed curve can still have plenty of
// spread along its loop while occupying only a sliver of 3D space. Stride-
// sample up to 20,000 points into a 20x20x20 grid over [-1.3, 1.3]^3 (the
// finalized/normalized coordinate range) and count distinct occupied cells.
// A limit cycle occupies ~50-200 cells; genuine chaotic clouds occupy
// thousands, so reject below 400.
function occupiedCellCount(positions) {
  const n = positions.length / 3;
  const stride = Math.max(1, Math.floor(n / 20000));
  const grid = 20;
  const lo = -1.3, span = 2.6;
  const cells = new Set();
  for (let i = 0; i < n; i += stride) {
    const gx = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3] - lo) / span * grid)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 1] - lo) / span * grid)));
    const gz = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 2] - lo) / span * grid)));
    cells.add((gx * grid + gy) * grid + gz);
  }
  return cells.size;
}

function validateOccupancy(out) {
  return occupiedCellCount(out.positions) >= 400;
}

export function generate(fp, params, onProgress) {
  const arch = params.liveVariance ? formArchetype(fp) : null;
  const axes = arch ? liveAxes(fp) : null;
  // Capture keeps the harmony rules; live routes on register × delivery. Both
  // mappings are fixed and continuous, so they stay stable and learnable — the
  // variety comes from the axes, never from system roulette.
  // Live locks the system for a whole session (params.lockedSystem) so the
  // design is modulated rather than swapped. Capture ignores it entirely —
  // recorded output is pinned by snapshot checksums. Validated only on the
  // live path: an unknown name (including '', which ?? does not catch since
  // it is non-nullish) must fail loudly here, not as a cryptic
  // "Cannot read properties of undefined" a few lines down in the retry loop.
  if (arch && params.lockedSystem != null && !(params.lockedSystem in SYSTEMS)) {
    throw new Error(`generate(): unknown params.lockedSystem "${params.lockedSystem}" — must be one of ${Object.keys(SYSTEMS).join(', ')}`);
  }
  const name = arch ? (params.lockedSystem ?? pickSystemLive(fp)) : pickSystem(fp);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const jitter = fp.velocity * 0.012 * (0.5 + params.complexity) * (arch ? 1 + arch.wildness : 1);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const excursion = 0.5 + params.complexity; // complexity widens coefficient excursion

  // Deterministic retry: if the system collapses, nudge fingerprint-projection
  for (let attempt = 0; attempt < 8; attempt++) {
    const fpAdj = attempt === 0 ? fp : { ...fp, pitchMedian: (fp.pitchMedian + attempt * 0.618) % 1, contour: fp.contour.map(v => (v + attempt * 0.618) % 1) };
    const c = sys.coeffs(fpAdj, rnd);
    if (sys.flow && arch) {
      // Live: drive the system's OWN coefficients from the expanded character
      // axes. This branch previously applied only the excursion multiplier
      // below — which reads params.complexity, not the sound — so `axes` was
      // computed and thrown away, and the sole sound→shape channel was whatever
      // coeffs(fp) happened to read (pitchMedian, plus centroid for aizawa).
      const safe = (sys.liveTarget ?? (s => s))({ ...c });
      sys.liveCoeffs(c, expandAxes(axes, fp), params.complexity ?? 0.5);
      // Graceful retry: pull the live coefficients back toward the validated
      // capture-path set rather than jittering them, so a rejected design
      // degrades toward a known-good shape instead of rolling the dice again.
      // Attempt 0 leaves the axis mapping exactly as chosen.
      if (attempt) {
        const t = attempt / 8;
        for (const key of Object.keys(c)) {
          if (typeof c[key] === 'number' && typeof safe[key] === 'number') {
            c[key] = lerp(c[key], safe[key], t);
          }
        }
      }
    } else if (sys.flow) {
      // Capture path, unchanged: flow systems map pitch across their full
      // validated coefficient range in coeffs(fp), and that IS the sound→shape
      // correspondence for a recorded take.
      for (const key of Object.keys(c)) {
        if (typeof c[key] === 'number' && key !== 'e') {
          c[key] = c[key] * lerp(0.92, 1.08, ((excursion * 7 + attempt) % 1));
        }
      }
    } else if (arch) {
      // Discrete map, live: fold coefficients blend the pitch contour with
      // smooth timbre axes (percussive input has a flat contour, which
      // otherwise pins a,b,c to one web); phases come from the axes, not the
      // seed (the seed re-hashes on any window drift → web teleports); and
      // the cross-couplings get a strong strictly-positive range — near-zero
      // d/e/f (centroid or volume ≈ 0.5) decouples the map into a collapsed
      // 1D chain that occupancy then rejects.
      c.a = lerp(1.2, 4.2, 0.5 * fp.contour[1] + 0.5 * axes[0]);
      c.b = lerp(1.2, 4.2, 0.5 * fp.contour[3] + 0.5 * axes[1]);
      c.c = lerp(1.2, 4.2, 0.5 * fp.contour[5] + 0.5 * axes[3]);
      c.g = axes[0] * Math.PI * 2;
      c.h = axes[1] * Math.PI * 2;
      c.i = axes[3] * Math.PI * 2;
      const hi = 0.9 + 0.4 * arch.wildness;
      c.d = lerp(0.4, hi, axes[0]);
      c.e = lerp(0.4, hi, axes[1]);
      c.f = lerp(0.4, hi, axes[3]);
    }

    const positions = new Float32Array(N * 3);
    const attr = new Float32Array(N);
    let p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];

    for (let i = 0; i < 3000; i++) { // warmup onto the attractor
      const d = sys.step(p, c);
      p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
    }

    let speedMax = 1e-6;
    const speeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = sys.step(p, c);
      const next = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
      const sp = Math.hypot(next[0] - p[0], next[1] - p[1], next[2] - p[2]);
      p = next;
      positions[i * 3] = p[0] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 1] = p[1] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 2] = p[2] + (rnd() - 0.5) * jitter;
      speeds[i] = sp;
      if (sp > speedMax) speedMax = sp;
      if (onProgress && i % 200000 === 0) onProgress(i / N);
    }
    // attr: dwell (slow = dense manifold = high palette position)
    for (let i = 0; i < N; i++) attr[i] = Math.max(0, Math.min(1, 1 - speeds[i] / speedMax));

    if (cloudStdDev(positions, Math.min(N, 5000)) < 0.02) continue; // collapsed → retry

    // Strands: continue the SAME trajectory, chopped into consecutive pieces
    const strandCount = Math.max(24, Math.min(96, params.strandCount || 96));
    const strands = [];
    const stepsPer = sys.flow ? 1400 : 500;
    for (let s = 0; s < strandCount; s++) {
      const raw = new Float32Array(stepsPer * 3);
      for (let i = 0; i < stepsPer; i++) {
        const d = sys.step(p, c);
        p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
        raw[i * 3] = p[0]; raw[i * 3 + 1] = p[1]; raw[i * 3 + 2] = p[2];
      }
      strands.push(resamplePolyline(raw, sys.flow ? 400 : 240));
    }

    const out = finalize(positions, attr, strands, params);
    if (!validateFinalized(out)) continue; // fat-tail collapse → retry
    if (!validateStrands(out.strands)) continue; // strand-phase escape → retry
    if (!validateOccupancy(out)) continue; // periodic collapse (limit cycle) → retry
    if (arch) {
      // Loudness → physical size: finalize pins r95 = 1 for every design, so
      // scale after validation (0.7 whisper .. 1.25 loud; maxAbs stays ≤ 2.25,
      // inside the 2.5 render contract).
      const s = 0.7 + 0.55 * (fp.volMean ?? 0.5);
      for (let i = 0; i < out.positions.length; i++) out.positions[i] *= s;
      for (const st of out.strands) for (let i = 0; i < st.length; i++) st[i] *= s;
    }
    return out;
  }
  if (arch) return generate(fp, { ...params, liveVariance: false }, onProgress);
  throw new Error('attractor: all retries degenerate');
}

// Paint mode's streaming brush: the attractor orbit IS the brush stroke.
// Points are emitted through a normalization transform calibrated up front
// (the batch path normalizes after the fact; a stream can't), coefficients
// glide toward each steer() target so the ribbons bend rather than jump,
// and a stagnation guard jolts the orbit out of collapsed loops.
export function createOrbitBrush(fp, params = {}) {
  // Paint is a live mode, so it takes the live routing. The system is fixed for
  // the whole painting — steer() bends the coefficients within it, and swapping
  // systems mid-stroke would break the canvas rather than bend it.
  const name = pickSystemLive(fp);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const complexity = params.complexity ?? 0.5;

  const coeffsFor = (f) => {
    const c = sys.coeffs(f, rnd);
    const axes = liveAxes(f);
    if (sys.flow) {
      // Same dead-axes defect as the batch path: this used to apply only a
      // complexity-derived multiplier, so steering a flow-system brush with a
      // new fingerprint barely moved it.
      sys.liveCoeffs(c, expandAxes(axes, f), complexity);
    } else {
      const arch = formArchetype(f);
      c.a = lerp(1.2, 4.2, 0.5 * f.contour[1] + 0.5 * axes[0]);
      c.b = lerp(1.2, 4.2, 0.5 * f.contour[3] + 0.5 * axes[1]);
      c.c = lerp(1.2, 4.2, 0.5 * f.contour[5] + 0.5 * axes[3]);
      c.g = axes[0] * Math.PI * 2;
      c.h = axes[1] * Math.PI * 2;
      c.i = axes[3] * Math.PI * 2;
      const hi = 0.9 + 0.4 * arch.wildness;
      c.d = lerp(0.4, hi, axes[0]);
      c.e = lerp(0.4, hi, axes[1]);
      c.f = lerp(0.4, hi, axes[3]);
    }
    return c;
  };

  let c = coeffsFor(fp);
  let cTarget = { ...c };
  let p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const stepOnce = () => {
    const d = sys.step(p, c);
    p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
  };

  // Calibrate: 3000 warmup steps onto the attractor, then 2000 probe steps
  // to fix centre + r95 scale for the whole painting.
  for (let i = 0; i < 3000; i++) stepOnce();
  const probe = [];
  for (let i = 0; i < 2000; i++) { stepOnce(); probe.push(p[0], p[1], p[2]); }
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < 2000; i++) { cx += probe[i * 3] / 2000; cy += probe[i * 3 + 1] / 2000; cz += probe[i * 3 + 2] / 2000; }
  const radii = [];
  for (let i = 0; i < 2000; i++) {
    radii.push(Math.hypot(probe[i * 3] - cx, probe[i * 3 + 1] - cy, probe[i * 3 + 2] - cz));
  }
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] || 1;
  const scale = r95 > 1e-6 ? 1 / r95 : 1;

  let speedMax = 1e-6;
  let batchN = 0, bx = 0, by = 0, bz = 0, bxx = 0, byy = 0, bzz = 0; // stagnation stats
  const jolt = (n) => {
    p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const nudged = { ...fp, pitchMedian: (fp.pitchMedian + 0.618 * n) % 1,
                     contour: fp.contour.map(v => (v + 0.618 * n) % 1) };
    cTarget = coeffsFor(nudged);
    for (let i = 0; i < 500; i++) stepOnce(); // settle back onto an attractor
  };
  let joltCount = 0;

  return {
    system: name,

    steer(newFp) { cTarget = coeffsFor(newFp); },

    next(k, dt) {
      // coefficient glide toward the steer target (τ = 3s)
      const g = 1 - Math.exp(-(dt || 1 / 60) / 3);
      for (const key of Object.keys(c)) {
        if (typeof c[key] === 'number' && typeof cTarget[key] === 'number') {
          c[key] += (cTarget[key] - c[key]) * g;
        }
      }
      const positions = new Float32Array(k * 3);
      const attr = new Float32Array(k);
      for (let i = 0; i < k; i++) {
        const prev = p;
        stepOnce();
        const sp = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
        if (sp > speedMax) speedMax = sp;
        let x = (p[0] - cx) * scale, y = (p[1] - cy) * scale, z = (p[2] - cz) * scale;
        if (Math.abs(x) > 2.2 || Math.abs(y) > 2.2 || Math.abs(z) > 2.2) {
          // steering pushed the orbit out of the calibrated frame — re-enter
          x = Math.max(-2.2, Math.min(2.2, x));
          y = Math.max(-2.2, Math.min(2.2, y));
          z = Math.max(-2.2, Math.min(2.2, z));
          p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        }
        positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
        attr[i] = Math.max(0, Math.min(1, 1 - sp / speedMax));
        // stagnation stats over 2000-point batches
        bx += x; by += y; bz += z; bxx += x * x; byy += y * y; bzz += z * z; batchN++;
        if (batchN >= 2000) {
          const vx = bxx / batchN - (bx / batchN) ** 2;
          const vy = byy / batchN - (by / batchN) ** 2;
          const vz = bzz / batchN - (bz / batchN) ** 2;
          if (Math.sqrt(Math.max(0, vx + vy + vz)) < 0.05) jolt(++joltCount);
          batchN = 0; bx = by = bz = bxx = byy = bzz = 0;
        }
      }
      return { positions, attr };
    },
  };
}
