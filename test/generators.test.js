import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, registeredModes } from '../js/generators/index.js';
import { pickSystem } from '../js/generators/attractor.js';
import { sphericalY, makeValueNoise3, recipe } from '../js/generators/harmonic.js';
import { mulberry32 } from '../js/generators/common.js';
import { padStrands } from '../js/generators/radial.js';

export function testFingerprint(overrides = {}) {
  const chroma = new Float32Array(12); chroma[0] = 1; chroma[4] = 0.8; chroma[7] = 0.7;
  return Object.assign({
    pitchMedian: 0.45, pitchRange: 0.3, contour: new Float32Array(8).fill(0.45),
    pitchConfidence: 0.9, chroma, noteSet: [0, 4, 7], noteCount: 3,
    consonance: 0.8, majorLeaning: true, velocity: 0.4,
    volMean: 0.5, volVar: 0.3, attackSlope: 0.4, centroid: 0.4, spread: 0.3,
    seed: 123456789,
  }, overrides);
}

export const baseParams = { mode: 'attractor', density: 30000, complexity: 0.5, symmetry: 1, twist: 0, strandCount: 96 };

function stats(positions) {
  const n = positions.length / 3;
  let maxAbs = 0; const mean = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) {
    const v = positions[i * 3 + d];
    maxAbs = Math.max(maxAbs, Math.abs(v)); mean[d] += v / n; sq[d] += v * v / n;
  }
  return { maxAbs, std: sq.map((s, d) => Math.sqrt(Math.max(0, s - mean[d] ** 2))) };
}

export function checkGenerator(mode, fp = testFingerprint()) {
  const params = { ...baseParams, mode };
  const out = generate(fp, params);
  assert.equal(out.positions.length % 3, 0);
  assert.ok(out.positions.length / 3 >= params.density * 0.5, `${mode}: too few points`);
  assert.equal(out.attr.length, out.positions.length / 3);
  for (const v of out.attr) assert.ok(v >= 0 && v <= 1);
  const { maxAbs, std } = stats(out.positions);
  assert.ok(maxAbs <= 2.5, `${mode}: unbounded (${maxAbs})`);
  assert.ok(std[0] + std[1] + std[2] > 0.15, `${mode}: degenerate`);
  assert.ok(out.strands.length >= 24, `${mode}: needs strands`);
  for (const s of out.strands) for (let i = 0; i < s.length; i += 1) assert.ok(Number.isFinite(s[i]), `${mode}: non-finite strand value`);
  const out2 = generate(fp, params);
  assert.deepEqual([...out.positions.slice(0, 300)], [...out2.positions.slice(0, 300)], `${mode}: not deterministic`);
  return out;
}

test('attractor generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('attractor');
});

test('attractor: different fingerprints → different geometry', () => {
  const a = generate(testFingerprint(), baseParams);
  const b = generate(testFingerprint({ pitchMedian: 0.8, noteSet: [1, 2], noteCount: 2, consonance: 0.1, seed: 987 }), baseParams);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(a.positions[i] - b.positions[i]);
  assert.ok(diff > 1, 'geometry should differ');
});

test('attractor: pickSystem routing table', () => {
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 3 })), 'thomas');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 5, noteSet: [0, 2, 4, 7, 9] })), 'aizawa');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: false })), 'halvorsen');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.1 })), 'lorenz');
  assert.equal(pickSystem(testFingerprint({ pitchConfidence: 0.2 })), 'sinemap');
  assert.equal(pickSystem(testFingerprint({ velocity: 0.8 })), 'sinemap');
});

test('attractor: all five systems bounded, non-degenerate, deterministic', () => {
  const routingFingerprints = {
    thomas: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 3 }),
    aizawa: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 5, noteSet: [0, 2, 4, 7, 9] }),
    halvorsen: testFingerprint({ consonance: 0.8, majorLeaning: false }),
    lorenz: testFingerprint({ consonance: 0.1 }),
    sinemap: testFingerprint({ pitchConfidence: 0.2 }),
  };
  const seeds = [1, 123456789, 987654321];
  for (const [name, fp] of Object.entries(routingFingerprints)) {
    assert.equal(pickSystem(fp), name, `routing fixture mismatch for ${name}`);
    for (const seed of seeds) {
      checkGenerator('attractor', { ...fp, seed });
    }
  }
});

// Regression repros for the strand-finiteness fix: these coefficient/seed
// combinations continue past a clean cloud into a strand-phase escape for
// polynomial flow systems — the cloud passes validateFinalized, but the
// ~134k-Euler-step strand extension goes non-finite. Before the fix:
// halvorsen-routing seed 143 → 50/96 non-finite strands; the dissonant-routing
// seed-41 fixture originally hit this on the (since-replaced) dadras system and
// now exercises the same guard on lorenz. checkGenerator asserts every strand
// value is finite, so these must pass post-fix.
test('attractor: strand-phase escape repros stay finite after retry', () => {
  const halvorsenEscape = testFingerprint({ consonance: 0.8, majorLeaning: false, pitchMedian: 0.431, seed: 143 });
  assert.equal(pickSystem(halvorsenEscape), 'halvorsen');
  checkGenerator('attractor', halvorsenEscape);

  const dissonantEscape = testFingerprint({ consonance: 0.1, pitchMedian: 1, centroid: 0, spread: 0.904, volMean: 0.03, seed: 41 });
  assert.equal(pickSystem(dissonantEscape), 'lorenz');
  checkGenerator('attractor', dissonantEscape);
});

test('attractor: low-pitch thomas routing does not collapse to a limit cycle', () => {
  // pitchMedian 0 → max damping; pre-fix this yielded a single 1D loop
  const fp = testFingerprint({ pitchMedian: 0, contour: new Float32Array(8) });
  const out = generate(fp, { ...baseParams, density: 30000 });
  const cells = new Set();
  const n = out.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const gx = Math.floor((out.positions[i*3]     + 1.3) / 2.6 * 20);
    const gy = Math.floor((out.positions[i*3 + 1] + 1.3) / 2.6 * 20);
    const gz = Math.floor((out.positions[i*3 + 2] + 1.3) / 2.6 * 20);
    cells.add((gx * 20 + gy) * 20 + gz);
  }
  assert.ok(cells.size >= 400, `occupied cells ${cells.size} — looks like a limit cycle`);
});

test('radial generator', () => {
  checkGenerator('radial');
});

// SVG export picks strands at a fixed stride (main.js: all[Math.floor(i*step)])
// from design.strands. radial.js only ever generates `shells` unique orbit
// centrelines and fills the rest of the strand budget with duplicates — if
// that padding repeats them in strict round-robin order, its period equals
// `shells`, and a stride sharing a factor with `shells` samples the same
// subset of shells forever, silently dropping the others from the export
// while the on-screen point cloud still renders all of them.
test('radial: padded strand budget survives fixed-stride export sampling', () => {
  // Sweep shell counts (even/odd/prime-sharing) and UI strandCount choices
  // (mirroring main.js's `want`), across several seeds, to prove coverage
  // holds generally rather than for one lucky case.
  for (const shells of [6, 12, 22, 30]) {
    for (const want of [24, 48, 72, 96]) {
      if (want < shells) continue; // fewer picks than shells: full coverage is impossible by definition
      const target = 96;
      const base = Array.from({ length: shells }, (_, k) => Float32Array.of(k, k, k));
      for (const seed of [1, 2, 3]) {
        const strands = padStrands(base, target, mulberry32(seed));
        assert.equal(strands.length, target);
        const step = target / want;
        const picked = [];
        for (let i = 0; i < want; i++) picked.push(strands[Math.floor(i * step)]);
        const identities = new Set(picked.map((s) => Math.round(s[0])));
        assert.equal(identities.size, shells,
          `shells=${shells} want=${want} seed=${seed}: export sample only covered ${identities.size}/${shells} shells`);
      }
    }
  }
});

test('cymatics generator', () => {
  checkGenerator('cymatics');
});

test('cymatics strands: field-following arcs, gaps in nodal voids, no straight radial spokes', () => {
  const params = { ...baseParams, mode: 'cymatics', strandCount: 48 };
  const out = generate(testFingerprint(), params);
  assert.ok(out.strands.length >= 1, 'some strand geometry must survive');

  let bulgingCount = 0, fullRingCount = 0;
  for (const s of out.strands) {
    const n = s.length / 3;
    assert.ok(n >= 4, 'every strand must have enough points to be a real arc, not a sliver');

    let minR = Infinity, maxR = -Infinity;
    const angles = [];
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], z = s[i + 2];
      const r = Math.hypot(x, z);
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      angles.push(Math.atan2(z, x));
    }
    if (maxR - minR > minR * 0.02) bulgingCount++;

    // A degenerate radial spoke has ~zero angular spread; a real arc — full
    // ring or partial — sweeps a real range of angles as it walks outward.
    let spread = 0;
    for (let i = 1; i < angles.length; i++) {
      let d = angles[i] - angles[i - 1];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      spread += Math.abs(d);
    }
    assert.ok(spread > 0.05, 'a spoke would have near-zero angular sweep — this must be a real arc');

    // A ring whose start and end points coincide is a full closed loop (no
    // gap survived it) — those must still sweep all four quadrants, exactly
    // like an unbroken ring always has.
    const dx = s[0] - s[s.length - 3], dz = s[2] - s[s.length - 1];
    if (Math.hypot(dx, dz) < minR * 0.05) {
      fullRingCount++;
      let hasPosX = false, hasNegX = false, hasPosZ = false, hasNegZ = false;
      for (let i = 0; i < s.length; i += 3) {
        if (s[i] > 0) hasPosX = true; if (s[i] < 0) hasNegX = true;
        if (s[i + 2] > 0) hasPosZ = true; if (s[i + 2] < 0) hasNegZ = true;
      }
      assert.ok(hasPosX && hasNegX && hasPosZ && hasNegZ,
        'a full closed ring must sweep through all four quadrants');
    }
  }
  // Radius modulation (petal bulge) depends on the field's local amplitude
  // variance at each ring's radius — require most (not all) arcs to bulge
  // rather than a strict per-strand guarantee.
  assert.ok(bulgingCount >= out.strands.length * 0.5,
    `most arcs should be amplitude-modulated (petal bulge), not perfect circles: ${bulgingCount}/${out.strands.length}`);
  // The whole point of this fix: rings crossing a nodal void must actually
  // break into separate arcs, not stay unbroken loops regardless of the field.
  assert.ok(fullRingCount < out.strands.length,
    'at least some rings should break into arcs at nodal voids, not all stay full loops');
});

test('harmonic generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('harmonic');
});

test('harmonic: sphericalY known values', () => {
  // Y_0^0 = 1/(2√pI) everywhere
  assert.ok(Math.abs(sphericalY(0, 0, 1.1, 2.2, 0) - 0.28209479) < 1e-6);
  // m > l clamps to l, stays finite
  assert.ok(Number.isFinite(sphericalY(3, 7, 0.5, 0.5, 0)));
});

test('harmonic: pitch changes dominant degree → different geometry', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const a = generate(testFingerprint({ pitchMedian: 0.1 }), params);
  const b = generate(testFingerprint({ pitchMedian: 0.9 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(a.positions[i] - b.positions[i]);
  assert.ok(diff > 1, 'pitch should change the form');
});

test('harmonic: registered in mode registry', () => {
  assert.ok(registeredModes().includes('harmonic'));
});

test('chladni mode is removed', () => {
  assert.ok(!registeredModes().includes('chladni'));
});

test('harmonic value noise: deterministic, bounded, finite at negatives', () => {
  const a = makeValueNoise3(mulberry32(7));
  const b = makeValueNoise3(mulberry32(7));
  for (const [x, y, z] of [[0.3, 1.7, -2.4], [-9.1, 0.01, 4.4], [100.5, -50.2, 0]]) {
    const v = a.fractal(x, y, z);
    assert.equal(v, b.fractal(x, y, z), 'seeded noise must be deterministic');
    assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), `out of range: ${v}`);
  }
  const c = makeValueNoise3(mulberry32(8));
  assert.notEqual(a.fractal(0.3, 1.7, -2.4), c.fractal(0.3, 1.7, -2.4), 'different seeds differ');
});

test('harmonic recipe: percussive audio gets rays, sustained gets none', () => {
  const perc = recipe(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), baseParams);
  assert.ok(perc.nRays > 20, `expected rays, got ${perc.nRays}`);
  const hum = recipe(testFingerprint({ velocity: 0.05, attackSlope: 0.1 }), baseParams);
  assert.equal(hum.nRays, 0, 'sustained hum must have no rays');
});

test('harmonic recipe: noisy timbre gets dashes, pure tone stays mesh', () => {
  const noisy = recipe(testFingerprint({ spread: 0.8 }), baseParams);
  assert.ok(noisy.nDashes > 50, `expected dashes, got ${noisy.nDashes}`);
  const pure = recipe(testFingerprint({ spread: 0.05 }), baseParams);
  assert.equal(pure.nDashes, 0, 'pure tone must have no dashes');
});

test('harmonic recipe: mesh always keeps >=55% of the point budget', () => {
  const worst = recipe(testFingerprint({ velocity: 1, attackSlope: 1, spread: 1 }), baseParams);
  assert.ok(worst.meshPts >= baseParams.density * 0.55, `mesh starved: ${worst.meshPts}`);
  assert.ok(worst.rings >= 24 && worst.rings <= 48);
  assert.ok(worst.lons >= 16 && worst.lons <= 32);
});

test('harmonic generate: percussive fp emits ray strands beyond the mesh', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const perc = generate(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  const hum = generate(testFingerprint({ velocity: 0.05, attackSlope: 0.1 }), params);
  const plan = recipe(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  assert.equal(perc.strands.length - hum.strands.length >= plan.nRays - 5, true,
    `ray strands missing: perc=${perc.strands.length} hum=${hum.strands.length} rays=${plan.nRays}`);
});

test('harmonic generate: organic — no rotational symmetry', () => {
  // The old vase was near-symmetric under phi -> phi + pi. Interference + noise
  // must break that: sample the displacement via strand radii at opposite phi.
  const out = generate(testFingerprint(), { ...baseParams, mode: 'harmonic' });
  const s = out.strands[Math.floor(out.strands.length / 4)]; // a mid-latitude ring
  const n = s.length / 3;
  let asym = 0;
  for (let i = 0; i < n / 2; i++) {
    const j = i + Math.floor(n / 2);
    const ri = Math.hypot(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
    const rj = Math.hypot(s[j * 3], s[j * 3 + 1], s[j * 3 + 2]);
    asym += Math.abs(ri - rj);
  }
  assert.ok(asym / (n / 2) > 0.02, `form too symmetric (asym=${(asym / (n / 2)).toFixed(4)})`);
});

function testTrajectory({ rms = 0.2, pitch = 0.5, n = 120 } = {}) {
  const t = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { t[i * 4] = 0.4; t[i * 4 + 1] = rms; t[i * 4 + 2] = 0.15; t[i * 4 + 3] = pitch; }
  return t;
}

test('oscillo generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('oscillo', testFingerprint({ trajectory: testTrajectory(), trajectoryChannels: 4 }));
});

test('oscillo: loud vs quiet trajectory → different geometry', () => {
  const params = { ...baseParams, mode: 'oscillo' };
  const loud = generate(testFingerprint({ trajectory: testTrajectory({ rms: 0.35 }), trajectoryChannels: 4 }), params);
  const quiet = generate(testFingerprint({ trajectory: testTrajectory({ rms: 0.02 }), trajectoryChannels: 4 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(loud.positions[i] - quiet.positions[i]);
  assert.ok(diff > 0.5, `loudness must shape the rings (diff=${diff})`);
});

test('oscillo: pitch changes ring wave count → different geometry', () => {
  const params = { ...baseParams, mode: 'oscillo' };
  const lo = generate(testFingerprint({ trajectory: testTrajectory({ pitch: 0.1 }), trajectoryChannels: 4 }), params);
  const hi = generate(testFingerprint({ trajectory: testTrajectory({ pitch: 0.9 }), trajectoryChannels: 4 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(lo.positions[i] - hi.positions[i]);
  assert.ok(diff > 0.5, 'pitch must change the wave pattern');
});

test('oscillo: missing trajectory → finite smooth circles, no crash', () => {
  const out = generate(testFingerprint(), { ...baseParams, mode: 'oscillo' });
  for (let i = 0; i < 300; i++) assert.ok(Number.isFinite(out.positions[i]));
  assert.ok(out.strands.length >= 24);
});

test('timbre removed, oscillo registered', () => {
  assert.ok(!registeredModes().includes('timbre'));
  assert.ok(registeredModes().includes('oscillo'));
});

test('cymatics: speech prosody (contour) shapes the membrane radially', () => {
  const params = { ...baseParams, mode: 'cymatics' };
  const speech = generate(testFingerprint({ contour: Float32Array.from([0.1, 0.9, 0.2, 0.8, 0.1, 0.9, 0.2, 0.8]) }), params);
  const flat = generate(testFingerprint({ contour: new Float32Array(8).fill(0.45) }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(speech.positions[i] - flat.positions[i]);
  assert.ok(diff > 1, `contour must shape the field (diff=${diff})`);
});

test('cymatics: atonal input (low consonance) → different mode character', () => {
  const params = { ...baseParams, mode: 'cymatics' };
  const atonal = generate(testFingerprint({ consonance: 0.05 }), params);
  const tonal = generate(testFingerprint({ consonance: 0.95 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(atonal.positions[i] - tonal.positions[i]);
  assert.ok(diff > 1, `consonance must change mode character (diff=${diff})`);
});

test('cymatics styles: scope/sand/relief are completely different, all valid', () => {
  const fp = testFingerprint();
  const outs = {};
  for (const style of ['scope', 'sand', 'relief']) {
    const out = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: style });
    assert.ok(out.positions.length / 3 >= baseParams.density * 0.5, `${style}: too few points`);
    for (let i = 0; i < 300; i++) assert.ok(Number.isFinite(out.positions[i]), `${style}: non-finite`);
    for (const v of out.attr.slice(0, 300)) assert.ok(v >= 0 && v <= 1, `${style}: attr out of range`);
    outs[style] = out;
  }
  const pairs = [['scope', 'sand'], ['sand', 'relief'], ['scope', 'relief']];
  for (const [a, b] of pairs) {
    let diff = 0;
    for (let i = 0; i < 300; i++) diff += Math.abs(outs[a].positions[i] - outs[b].positions[i]);
    assert.ok(diff > 1, `${a} vs ${b} must differ (diff=${diff})`);
  }
});

test('cymatics style auto: deterministic seed-based pick', () => {
  const fp = testFingerprint();
  const a = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: 'auto' });
  const b = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: 'auto' });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)]);
});

// ── Live form families ────────────────────────────────────────────
import { formArchetype } from '../js/generators/common.js';

// Character fixtures: a sung major chord, a whistle, and plain speech.
const FP_MUSIC = () => testFingerprint(); // defaults: consonant, mid centroid
const FP_WHISTLE = () => testFingerprint({
  pitchMedian: 0.85, centroid: 0.75, spread: 0.1, consonance: 0.8,
  velocity: 0.2, noteSet: [9], noteCount: 1,
});
const FP_SPEECH = () => testFingerprint({
  pitchMedian: 0.3, centroid: 0.5, spread: 0.45, consonance: 0.3,
  velocity: 0.5, pitchConfidence: 0.3,
});

test('formArchetype: deterministic and seed-independent', () => {
  const a = formArchetype(FP_MUSIC());
  const b = formArchetype(testFingerprint({ seed: 42 })); // only seed differs
  assert.deepEqual(a, b);
});

test('formArchetype: music, whistle, speech land in distinct archetypes', () => {
  assert.equal(formArchetype(FP_MUSIC()).index, 0);   // tonal-smooth
  assert.equal(formArchetype(FP_WHISTLE()).index, 1); // bright-piercing
  assert.equal(formArchetype(FP_SPEECH()).index, 2);  // rough-noisy
});

test('formArchetype: wildness bounded and rises with dissonance', () => {
  const calm = formArchetype(FP_MUSIC()).wildness;
  const wild = formArchetype(FP_SPEECH()).wildness;
  assert.ok(calm >= 0 && calm <= 1 && wild >= 0 && wild <= 1);
  assert.ok(wild > calm);
});

// Shared helper: mean L1 distance between two clouds' radial histograms —
// a cheap "different shape" metric for the live-variance tests.
export function shapeDistance(mode, fpA, fpB) {
  const params = { ...baseParams, mode, density: 30000, liveVariance: true };
  const a = generate(fpA, params), b = generate(fpB, params);
  const hist = (out) => {
    const h = new Float64Array(16); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]);
      h[Math.min(15, Math.floor(r / 1.5 * 16))] += 1 / n;
    }
    return h;
  };
  const ha = hist(a), hb = hist(b);
  let d = 0; for (let i = 0; i < 16; i++) d += Math.abs(ha[i] - hb[i]);
  return d;
}

test('radial: live archetypes produce measurably different geometry', () => {
  assert.ok(shapeDistance('radial', FP_MUSIC(), FP_SPEECH()) > 0.15);
  assert.ok(shapeDistance('radial', FP_MUSIC(), FP_WHISTLE()) > 0.15);
  checkGenerator('radial', testFingerprint()); // sanity: no flag still valid
});

test('harmonic recipe: live archetypes reshape the treatment mix', () => {
  const params = { ...baseParams, mode: 'harmonic', density: 20000, liveVariance: true };
  const spiky = recipe(FP_WHISTLE(), params);
  assert.ok(spiky.nRays >= 80, 'bright archetype forces burst rays');
  const net = recipe(FP_SPEECH(), params);
  const base = recipe(FP_SPEECH(), { ...params, liveVariance: false });
  assert.ok(net.rings < base.rings && net.lons < base.lons, 'rough archetype sparsifies the net');
});

test('harmonic: live archetypes produce measurably different geometry', () => {
  assert.ok(shapeDistance('harmonic', FP_MUSIC(), FP_WHISTLE()) > 0.12);
  checkGenerator('harmonic', testFingerprint());
});

test('oscillo: live archetypes produce measurably different geometry', () => {
  // Ribbon (whistle/bright) vs mandala (music/tonal) vs arcs (speech/rough).
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_WHISTLE()) > 0.15);
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_SPEECH()) > 0.12);
  checkGenerator('oscillo', testFingerprint());
});

test('cymatics: live auto style follows the sound character', () => {
  const params = { ...baseParams, mode: 'cymatics', density: 15000,
                   liveVariance: true, cymStyle: 'auto' };
  const ySpan = (out) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < out.positions.length; i += 3) {
      lo = Math.min(lo, out.positions[i]); hi = Math.max(hi, out.positions[i]);
    }
    return hi - lo;
  };
  const sandy = generate(FP_SPEECH(), params);   // rough → sand: flat plate
  const relief = generate(FP_MUSIC(), params);   // tonal → relief: raised
  assert.ok(ySpan(sandy) < ySpan(relief) * 0.6, 'sand is flat, relief is raised');
  // Explicit style still wins over the archetype.
  const forced = generate(FP_SPEECH(), { ...params, cymStyle: 'relief' });
  assert.ok(ySpan(forced) > ySpan(sandy), 'explicit cymStyle overrides archetype');
});

test('attractor: liveVariance output valid and differs from non-live', () => {
  const fp = FP_SPEECH(); // high wildness
  const live = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
  const base = generate(fp, { ...baseParams, density: 30000 });
  let maxAbs = 0, s = 0;
  const n = live.positions.length / 3;
  for (let i = 0; i < live.positions.length; i++) maxAbs = Math.max(maxAbs, Math.abs(live.positions[i]));
  for (let i = 0; i < n; i++) s += live.positions[i * 3] ** 2 / n;
  assert.ok(maxAbs <= 2.5 && Math.sqrt(s) > 0.05, 'live attractor stays valid');
  let diff = 0;
  const m = Math.min(live.positions.length, base.positions.length);
  for (let i = 0; i < m; i += 300) diff += Math.abs(live.positions[i] - base.positions[i]);
  assert.ok(diff > 0.5, 'live coefficients actually shift the trajectory');
});

// Live attractor variety: speech-like and percussive windows must not
// collapse into the same sinemap web (root cause of "two designs swapping").
test('attractor live: percussive vs speech windows differ in shape', () => {
  // Same system (sinemap), so radial histograms are blind to the difference —
  // compare 3D cell occupancy instead. Steady-sound pairs overlap ~0.95;
  // genuinely different characters must fall well below that.
  const cellsOf = (fp) => {
    const out = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
    const s = new Set(); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const gx = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3] + 1.3) / 2.6 * 20)));
      const gy = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + 1] + 1.3) / 2.6 * 20)));
      const gz = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + 2] + 1.3) / 2.6 * 20)));
      s.add((gx * 20 + gy) * 20 + gz);
    }
    return s;
  };
  const talk = testFingerprint({ pitchConfidence: 0.3, consonance: 0.3, pitchMedian: 0.3,
                                 centroid: 0.5, spread: 0.45, velocity: 0.5, seed: 111 });
  const claps = testFingerprint({ pitchConfidence: 0.2, consonance: 0.4, velocity: 0.85,
                                  centroid: 0.6, spread: 0.5, seed: 666 });
  const a = cellsOf(talk), b = cellsOf(claps);
  let inter = 0; for (const v of a) if (b.has(v)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  assert.ok(jaccard < 0.85, `talk and claps webs overlap too much (jaccard ${jaccard.toFixed(3)})`);
});

test('attractor live: five distinct sound characters produce five distinct shapes', () => {
  // Five genuinely different characters (speech, high whistle, low minor hum,
  // percussion, bright complex chord). Similar sounds looking similar is the
  // POINT of the smooth mapping — so every fixture here differs in character,
  // and every pair must differ visibly.
  const fps = [
    testFingerprint({ pitchConfidence: 0.3, pitchMedian: 0.3, centroid: 0.5, spread: 0.45, consonance: 0.3, velocity: 0.5, seed: 1 }),
    testFingerprint({ pitchConfidence: 0.9, pitchMedian: 0.85, centroid: 0.7, spread: 0.1, consonance: 0.8, velocity: 0.2, noteSet: [9], noteCount: 1, seed: 2 }),
    testFingerprint({ pitchConfidence: 0.85, pitchMedian: 0.2, centroid: 0.2, spread: 0.15, consonance: 0.7, majorLeaning: false, velocity: 0.2, seed: 3 }),
    testFingerprint({ pitchConfidence: 0.2, velocity: 0.85, centroid: 0.65, spread: 0.5, consonance: 0.4, volMean: 0.75, seed: 4 }),
    testFingerprint({ pitchConfidence: 0.9, pitchMedian: 0.55, centroid: 0.45, spread: 0.3, consonance: 0.85, velocity: 0.45,
                      noteSet: [0, 2, 4, 7, 9], noteCount: 5, seed: 5 }),
  ];
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      assert.ok(shapeDistance('attractor', fps[i], fps[j]) > 0.12,
        `characters ${i} and ${j} produced near-identical attractors`);
    }
  }
});

test('attractor live: loudness drives size', () => {
  const quiet = testFingerprint({ volMean: 0.1 });
  const loud = testFingerprint({ volMean: 0.95 });
  const r95 = (fp) => {
    const out = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
    const radii = [];
    for (let i = 0; i < out.positions.length; i += 3) {
      radii.push(Math.hypot(out.positions[i], out.positions[i + 1], out.positions[i + 2]));
    }
    radii.sort((a, b) => a - b);
    return radii[Math.floor(radii.length * 0.95)];
  };
  assert.ok(r95(loud) > r95(quiet) * 1.25, 'loud designs should be visibly larger');
});

// Regression: the sound→design map must be LOCAL — consecutive windows of a
// steady sound (tiny feature drift) may not jump to a different design.
// (The v=34 liveMix hash broke this: ±2% drift teleported across systems.)
test('attractor live: steady sound keeps a stable design across morphs', () => {
  const drift = (i, amp = 0.02) => amp * Math.sin(i * 2.399);
  const params = { ...baseParams, density: 30000, liveVariance: true };
  const hist = (out) => {
    const h = new Float64Array(16); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]);
      h[Math.min(15, Math.floor(r / 1.5 * 16))] += 1 / n;
    }
    return h;
  };
  let prev = null, maxD = 0;
  for (let i = 0; i < 6; i++) {
    const fp = testFingerprint({
      pitchConfidence: 0.3, consonance: 0.32 + drift(i), pitchMedian: 0.3 + drift(i + 1),
      centroid: 0.5 + drift(i + 2), spread: 0.45 + drift(i + 3), velocity: 0.5 + drift(i + 4),
      seed: 1000 + i,
    });
    const h = hist(generate(fp, params));
    if (prev) {
      let d = 0; for (let k = 0; k < 16; k++) d += Math.abs(prev[k] - h[k]);
      maxD = Math.max(maxD, d);
    }
    prev = h;
  }
  assert.ok(maxD < 0.15, `steady sound jumped designs (max consecutive distance ${maxD.toFixed(3)})`);
});
