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
  // Clifford — the classic 2D strange attractor, given depth from the sound.
  //
  //   x' = sin(a·y) + c·cos(a·x)
  //   y' = sin(b·x) + d·cos(b·y)
  //
  // It has no z of its own. Rather than leave it a flat sheet (correct only in
  // the default top-down view, and edge-on the moment you drag to rotate), z is
  // a relief lifted off the folded surface: an audio-driven amplitude over a
  // ripple whose frequency comes from the sound too. The XY silhouette stays
  // exactly Clifford; the relief just gives it a form from other angles.
  //
  // Discrete map, so no dt — step() returns the next point outright.
  clifford: {
    flow: false,
    // a and b are FIXED, and that is a measured decision, not laziness.
    // Clifford's (a,b) plane is pocked with degenerate slivers — 18 of 49
    // sampled combinations collapse to under 60 occupied cells, and even a
    // narrow sweep of `a` at fixed b hits dead values at -1.90, -1.65 and
    // -1.45 with healthy plateaus between them. Driving a or b continuously
    // from a voice would cross those slivers constantly, and every crossing is
    // a rejected design that falls back and discards live variance. a = -1.80
    // sits mid-plateau (neighbours at -1.85/-1.75 score 178/173), so the sound
    // drives the coefficients that ARE safe across their whole box instead:
    // c in 0.8..1.4 and d in 0.7..1.3 measured 163-217 cells with no dead
    // spots, and relief/rk only touch z so they cannot destabilise the map.
    coeffs: fp => ({
      a: -1.80, b: 1.85,
      c: lerp(0.85, 1.35, fp.centroid ?? 0.5),
      d: lerp(0.75, 1.25, fp.pitchMedian),
      relief: lerp(0.20, 0.45, fp.volMean ?? 0.5),
      rk: lerp(1.2, 2.2, fp.spread ?? 0.5),
    }),
    step: (p, c) => {
      const x = Math.sin(c.a * p[1]) + c.c * Math.cos(c.a * p[0]);
      const y = Math.sin(c.b * p[0]) + c.d * Math.cos(c.b * p[1]);
      return [x, y, c.relief * Math.sin(c.rk * (x + y))];
    },
    // Same split of duties the flow system uses. The AX-DRIVEN spans are
    // deliberately narrow: clifford's caustics move fast with c and d, and the
    // ax values carry ordinary fingerprint sampling noise, so wide ax spans
    // made a steady voice jump (radial-profile distance 0.749 against a 0.15
    // bar). Complexity gets its OWN wide bounds through complexify, driven by
    // cx directly rather than multiplied against a noisy axis, so it can sweep
    // the full validated c box without amplifying drift.
    // Clifford reads the RAW axes, not the expanded ones. expandAxes applies a
    // tanh with gain 3.4 to spread speech's narrow band across the full range —
    // useful for choosing a form, but it magnifies ordinary fingerprint
    // sampling noise by the same factor, and clifford's caustics move fast
    // enough with c and d that the amplified noise made a steady voice jump
    // (radial-profile distance 0.749 against a 0.15 bar). On the raw axes a
    // small drift stays a small drift, while a genuine change of character —
    // calm to animated is ~0.33 of an axis, not ~0.02 — still moves the form.
    // Complexity keeps its own wide bounds through complexify, driven by cx
    // directly, so the lever does not depend on either axis scale.
    // `raw` mirrors `ax`'s shape: the four liveAxes channels plus raw pitchMedian.
    liveCoeffs: (c, ax, cx = 0.5, raw = ax) => {
      c.c = complexify(lerp(0.84, 1.36, raw[0]), 0.82, 1.38, cx, 'hi');
      c.d = lerp(0.74, 1.26, raw[4]);
      c.relief = complexify(lerp(0.24, 0.44, raw[2]), 0.20, 0.50, cx, 'hi');
      c.rk = lerp(1.25, 2.15, raw[1]);
    },
  },
  // Thomas — the cyclically symmetric knot. Restored 2026-08-07 after the cut to
  // two systems, this time as a system you pick rather than one the sound picks.
  //
  //   x' = sin(y) - b·x,  y' = sin(z) - b·y,  z' = sin(x) - b·z
  //
  // The coefficients below are thomas's ORIGINAL, pre-cut values, restored
  // unchanged. The "attractor: all retries degenerate" crash they used to cause
  // (23 of 252 fingerprint x Complexity combinations threw, every one of them
  // exhausting all 8 retries on validateOccupancy) was never a fault in these
  // numbers — it was the occupancy floor judging thomas by the wrong bar. See
  // the OCCUPANCY note on this system's descriptor.
  //
  // The evidence, because it is easy to reach the opposite conclusion: `b`
  // above ~0.100 does score few cells (85-260 against the flow floor of 400),
  // which reads exactly like the limit-cycle collapse that floor exists to
  // catch. It is not. The largest Lyapunov exponent over b = 0.075..0.200 is
  // 0.24-0.43, strongly positive throughout, with no periodic window anywhere;
  // it only goes negative past b ~ 0.32 (measured -0.13 at 0.40, -0.56 at
  // 0.60), far outside any range used here. What actually changes across
  // 0.10..0.20 is how SPACE-FILLING the attractor is, not whether it is
  // chaotic: as b falls toward 0 thomas approaches a lattice-filling random
  // walk (many cells), and as b rises it tightens into the compact knot the
  // system is known for (few cells, still chaotic).
  //
  // Retuning `b` down onto the low-b "plateau" was tried first and rejected. It
  // did fix the crash (0 of 252), but it bought that by moving thomas into the
  // diffuse regime — the wrong look, and unstable under live modulation: a
  // space-filling walk reorganises completely under small coefficient changes,
  // and consecutive-regeneration overlap fell to 0.23 against the project's
  // 0.55 bar (halvorsen and clifford both pass). Fixing the validator instead
  // keeps thomas's classic form AND its live continuity.
  thomas: {
    dt: 0.06, flow: true,
    coeffs: fp => ({ b: lerp(0.10, 0.165, 1 - fp.pitchMedian) }),
    // bx/by/bz are live-only. They are undefined on the capture path, where all
    // three fall back to the single symmetric b.
    step: (p, c) => [
      Math.sin(p[1]) - (c.bx ?? c.b) * p[0],
      Math.sin(p[2]) - (c.by ?? c.b) * p[1],
      Math.sin(p[0]) - (c.bz ?? c.b) * p[2]],
    // Thomas has a single damping term, so pitch alone barely moves it. Equal
    // damping on all three axes is the *symmetric special case*; mild per-axis
    // asymmetry re-lobes the knot. Asymmetry stays gentle because a strong
    // split pushes the system toward the genuinely periodic regime (b ~ 0.32
    // and up), and b also stays under the classic b ~ 0.208 boundary.
    //
    // Also original, pre-cut values. The ax-driven base is narrow while
    // complexify() keeps its own wider lo/hi targets — the fix shape this
    // project arrived at for every system (see halvorsen's `spread`/`bias`
    // note): ordinary fingerprint sampling noise rides on `ax`, so a wide
    // ax-driven base puts b near a regime boundary before complexify() has
    // pushed it anywhere. Narrowing the base to 0.148..0.118 while leaving the
    // targets at 0.168/0.098 is what took consecutive-regeneration overlap
    // from 0.013 to 0.622.
    liveCoeffs: (c, ax, cx = 0.5) => {
      const b = complexify(lerp(0.148, 0.118, ax[4]), 0.168, 0.098, cx, 'hi');
      c.b = b;
      c.bx = b * lerp(0.93, 1.07, ax[1]);
      c.by = b * lerp(0.93, 1.07, ax[2]);
      c.bz = b * lerp(0.93, 1.07, ax[3]);
    },
    liveTarget: safe => ({ ...safe, bx: safe.b, by: safe.b, bz: safe.b }),
    // OCCUPANCY: thomas is chaotic but COMPACT, so the 400-cell flow default
    // is the wrong bar for it — the same category of mistake clifford's planar
    // mode fixed, just on a different axis (clifford is measured on the wrong
    // number of dimensions; thomas on the wrong assumption that a chaotic
    // attractor must be space-filling).
    //
    // Calibrated the way clifford's 90 was, against genuine degeneracy rather
    // than against a guess. Classifying by largest Lyapunov exponent over
    // b = 0.10..1.0: every genuinely chaotic value scores 71-528 cells, and
    // every genuinely periodic one collapses to 1-9. A floor of 40 sits ~1.8x
    // below the worst chaotic case and ~4.4x above the worst periodic one, so
    // it still rejects the limit cycles this check exists to catch while
    // passing the knot thomas is supposed to look like.
    occupancy: { planar: false, floor: 40 },
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
    // 's ax-driven span was narrowed from [1.36, 1.92] when the system set
    // dropped to two: ax[4] carries the widest drift of any axis (0.058 across
    // a steady window), and with halvorsen now taking the whole low register
    // that drift pushed one voice's consecutive-regeneration overlap to 0.532
    // against a 0.55 floor. [1.40, 1.62] clears it while keeping pitch a
    // visible lever within the band (the register test asserts that).
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.a = lerp(1.40, 1.62, ax[4]);
      const k = lerp(3.88, 4.12, ax[1]);
      const spread = 0.04;
      const bias = (cx - 0.5) * 0.06;   // retuned with the narrowed `a`: 0.08 crossed a bifurcation              // -0.04 .. 0.04
      c.kx = k * (1 + spread * (ax[1] * 2 - 1) + bias);
      c.ky = k * (1 + spread * (ax[2] * 2 - 1) - bias);
      c.kz = k * (1 + spread * (ax[3] * 2 - 1));
    },
    liveTarget: safe => ({ ...safe, kx: 4, ky: 4, kz: 4 }),
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
  // Two systems, split on vocal register. The boundary sits at pitchMedian
  // 0.257, which is ~160 Hz on the 55 Hz–3520 Hz log scale — between a typical
  // male and female speaking voice, so it is a split you can cross on purpose.
  return fp.pitchMedian < REGISTER_SPLIT ? 'halvorsen' : 'clifford';
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
const REGISTER_LOW = 0.38;        // expanded-axis boundary
const REGISTER_SPLIT = 0.257;     // raw pitchMedian boundary, ~160 Hz

export function pickSystemLive(fp) {
  // Same register split as capture, measured on the expanded pitch axis.
  // REGISTER_LOW (0.38) is where pitchMedian 0.257 lands after expandAxes, so
  // the two paths agree on where the boundary is.
  const ax = expandAxes(liveAxes(fp), fp);
  return ax[4] < REGISTER_LOW ? 'halvorsen' : 'clifford';
}

// The systems a user can choose by name, in UI order. Exported so index.html's
// picker and the tests share one list with SYSTEMS rather than restating it.
export const SYSTEM_NAMES = Object.keys(SYSTEMS);

// Can this system be regenerated on the fast MODULATE cadence (~4 Hz, 0.15s
// crossfade) and still read as ONE design being deformed?
//
// Only where consecutive regenerations from a drifting voice stay
// geometrically continuous. Measured as cell-occupancy Jaccard between
// consecutive live regenerations at production density (250k), all six M7
// voices forced onto each system:
//
//   halvorsen  min 0.631,   0/176 steps below 0.50
//   clifford   min 0.739,   0/176 steps below 0.50
//   thomas     min 0.000,  55/176 steps below 0.50
//
// thomas is excluded, and no amount of narrowing its coefficient band fixes
// it — a band 3% wide still produced consecutive designs sharing ZERO cells.
// The cause is structural rather than a tuning error: thomas's sine coupling
// makes it multistable across a spatial lattice, so nearby coefficients
// (and, separately, the per-window change in fp.seed that moves the starting
// point) settle into genuinely different basins. It is a fine design and a
// poor deformable one.
//
// Excluded systems are not degraded, they just take the ordinary morph path
// they had before continuous modulation existed: regenerate on a real change
// in the sound, and dissolve across it with the full MORPH_CROSSFADE_SEC.
// That is still how every non-attractor mode behaves.
const MODULATES = new Set(['halvorsen', 'clifford']);
export const modulatesContinuously = (name) => MODULATES.has(name);

// `Object.hasOwn`, not `name in SYSTEMS`: `in` walks the prototype chain, so
// 'constructor', 'toString' and '__proto__' would pass the guard and then blow
// up further down as "sys.coeffs is not a function".
const isSystem = (name) => Object.hasOwn(SYSTEMS, name);

const assertSystem = (name, key, extra = '') => {
  if (!isSystem(name)) {
    throw new Error(`generate(): unknown params.${key} "${name}" — must be ${extra}one of ${SYSTEM_NAMES.join(', ')}`);
  }
};

// Which system to build, for BOTH paths.
//
// `params.attractorSystem` is the user's pick from the Mode panel and it wins
// outright wherever it is set to a real system — that is the whole point of the
// control, and routing that a user has overridden is not routing any more.
// 'auto' (and an absent value, for callers written before the picker existed)
// falls through to the historic sound-based routing, unchanged.
//
// `params.lockedSystem` stays what it always was: the LIVE session's hold, so a
// session modulates one design instead of swapping between them. It is only
// consulted under 'auto', because an explicit pick has already answered the
// question the lock exists to answer. The conductor seeds its lock from the
// pick anyway, so in practice the two agree; this ordering just means they
// cannot disagree if a stale lock outlives a change of pick.
//
// Capture ignores `lockedSystem` entirely, including an invalid one — recorded
// output is pinned by snapshot checksums and must not depend on live state.
function resolveSystem(fp, params, live) {
  const choice = params.attractorSystem;
  if (choice != null && choice !== 'auto') {
    assertSystem(choice, 'attractorSystem', "'auto' or ");
    return choice;
  }
  if (!live) return pickSystem(fp);
  if (params.lockedSystem != null) {
    assertSystem(params.lockedSystem, 'lockedSystem');
    return params.lockedSystem;
  }
  return pickSystemLive(fp);
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
function occupiedCellCount(positions, planar = false) {
  const n = positions.length / 3;
  const stride = Math.max(1, Math.floor(n / 20000));
  const grid = 20;
  const lo = -1.3, span = 2.6;
  const cells = new Set();
  for (let i = 0; i < n; i += stride) {
    const gx = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3] - lo) / span * grid)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 1] - lo) / span * grid)));
    const gz = Math.min(grid - 1, Math.max(0, Math.floor((positions[i * 3 + 2] - lo) / span * grid)));
    cells.add(planar ? gx * grid + gy : (gx * grid + gy) * grid + gz);
  }
  return cells.size;
}

// How much space a healthy design occupies is a PER-SYSTEM fact, so each system
// may carry its own `occupancy: { planar, floor }`. The shared default below is
// the volumetric 400 that flow systems are held to.
//
// A 2D map is a SURFACE with a thin relief, so a volumetric cell count judges
// it on the wrong axis — a perfectly healthy clifford scores 206-290 of 8000
// 3D cells and would be rejected outright. Measured on the XY plane instead
// (400 cells available), healthy clifford lands at 132-217 while every
// degenerate configuration collapses to 1-43, so 90 separates them cleanly.
//
// thomas overrides the floor rather than the axis — see its descriptor.
//
// Every floor here is calibrated the same way: measure what a genuinely
// degenerate configuration scores, measure what a healthy one scores, and put
// the bar in the gap. A floor picked any other way either passes limit cycles
// or rejects perfectly good designs, and the second failure mode is the one
// that is hard to notice, because it surfaces as an unexplained
// "all retries degenerate" rather than as an ugly design.
const DEFAULT_OCCUPANCY = { planar: false, floor: 400 };

function validateOccupancy(out, sys) {
  const { planar, floor } = sys.occupancy
    ?? (sys.flow ? DEFAULT_OCCUPANCY : { planar: true, floor: 90 });
  return occupiedCellCount(out.positions, planar) >= floor;
}

export function generate(fp, params, onProgress) {
  const arch = params.liveVariance ? formArchetype(fp) : null;
  const axes = arch ? liveAxes(fp) : null;
  // Capture keeps the harmony rules; live routes on register × delivery. Both
  // mappings are fixed and continuous, so they stay stable and learnable — the
  // variety comes from the axes, never from system roulette.
  // …unless the user has picked a system by name, which overrides both. See
  // resolveSystem for the precedence and for why an unknown name throws here
  // rather than becoming a cryptic "sys.coeffs is not a function" below.
  const name = resolveSystem(fp, params, !!arch);
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
    if (arch) {
      // Live: drive the system's OWN coefficients from the expanded character
      // axes. Both systems implement liveCoeffs, so this no longer forks on
      // sys.flow — the discrete map needs the same treatment as the flow one.
      const safe = (sys.liveTarget ?? (t => t))({ ...c });
      sys.liveCoeffs(c, expandAxes(axes, fp), params.complexity ?? 0.5, [...axes, fp.pitchMedian]);
      // Graceful retry: pull the live coefficients back toward the validated
      // capture-path set rather than jittering them, so a rejected design
      // degrades toward a known-good shape instead of rolling the dice again.
      if (attempt) {
        const t = attempt / 8;
        for (const key of Object.keys(c)) {
          if (typeof c[key] === 'number' && typeof safe[key] === 'number') {
            c[key] = lerp(c[key], safe[key], t);
          }
        }
      }
    } else if (sys.flow) {
      // Capture path, unchanged for the flow system: coeffs(fp) maps pitch
      // across its validated range, and that IS the sound→shape correspondence
      // for a recorded take.
      for (const key of Object.keys(c)) {
        if (typeof c[key] === 'number' && key !== 'e') {
          c[key] = c[key] * lerp(0.92, 1.08, ((excursion * 7 + attempt) % 1));
        }
      }
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
    if (!validateOccupancy(out, sys)) continue; // periodic collapse (limit cycle) → retry
    // NOTE: loudness no longer scales the design's physical size. finalize()
    // pins r95 = 1, and a post-validation `s = 0.7 + 0.55 * volMean` used to
    // stretch that — so the form grew and shrank as you got louder. Removed at
    // the user's request; the Scale slider is manual again, and loudness reads
    // through clifford's relief and the density/exposure layers instead.
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
  // Paint is a live mode, so it takes the live resolution — the user's pick
  // first, then the session lock, then the routing. The system is fixed for the
  // whole painting: steer() bends the coefficients within it, and swapping
  // systems mid-stroke would break the canvas rather than bend it.
  //
  // This used to call pickSystemLive() directly while the conductor recorded
  // its lock from a SEPARATE call, "the choice createOrbitBrush makes
  // independently". Two independent calls agreed only because they ran the same
  // function on the same fingerprint; once a pick or a lock can override that,
  // they would silently diverge and the painting would be a different system
  // from the one the session reported. One resolution, passed in.
  const name = resolveSystem(fp, params, true);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const complexity = params.complexity ?? 0.5;

  const coeffsFor = (f, nudge = 0) => {
    const adj = nudge ? { ...f, pitchMedian: (f.pitchMedian + nudge * 0.618) % 1 } : f;
    const c = sys.coeffs(adj, rnd);
    const axes = liveAxes(adj);
    // Both systems implement liveCoeffs — the flow one and the discrete map —
    // so this no longer forks. (It used to fall through to a sinemap-specific
    // branch, which silently overwrote the discrete map's coefficients with
    // values from a system that no longer exists.)
    sys.liveCoeffs(c, expandAxes(axes, adj), complexity, [...axes, adj.pitchMedian]);
    return c;
  };

  // Does this coefficient set stay finite? generate() gets to validate a whole
  // cloud and retry up to 8 times; a streaming brush has no such luxury, and
  // without this check halvorsen streamed 100% non-finite points for every
  // low-register fingerprint — a completely blank Paint canvas, silently.
  // (Pre-existing: generate() only ever looked stable there because its retry
  // loop quietly landed on a different coefficient set.)
  // Must cover at least the brush's own 3000 warmup + 2000 probe steps: a
  // coefficient set can survive a short probe and diverge later, which is
  // exactly what a shorter check let through.
  const survives = (cand) => {
    let q = [0.1, 0.1, 0.1];
    for (let i = 0; i < 5600; i++) {
      const d = sys.step(q, cand);
      q = sys.flow ? [q[0] + d[0] * sys.dt, q[1] + d[1] * sys.dt, q[2] + d[2] * sys.dt] : d;
      if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || !Number.isFinite(q[2])) return false;
      if (Math.abs(q[0]) > 1e4 || Math.abs(q[1]) > 1e4 || Math.abs(q[2]) > 1e4) return false;
    }
    return true;
  };
  const stableCoeffs = (f) => {
    for (let n = 0; n < 8; n++) {
      const cand = coeffsFor(f, n);
      if (survives(cand)) return cand;
    }
    return sys.coeffs(f, rnd);   // validated capture-path values as the floor
  };

  let c = stableCoeffs(fp);
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
    cTarget = stableCoeffs(nudged);
    for (let i = 0; i < 500; i++) stepOnce(); // settle back onto an attractor
  };
  let joltCount = 0;

  return {
    system: name,

    steer(newFp) { cTarget = stableCoeffs(newFp); },

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
