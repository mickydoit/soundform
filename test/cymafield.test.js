import test from 'node:test';
import assert from 'node:assert/strict';
import { idleState, psi, nodalThickness, thickness, droplets, gather,
         targetFromFeatures, glide, advance, kick, makeWaterField } from '../js/cymafield.js';
import { stateFromFingerprint, stateFromFrame, stateAtTime, featuresOf,
         generate as generateLiquid } from '../js/generators/liquid.js';
import { marchingSquares, fieldOutline } from '../js/blob.js';

const grid = (fn, n = 90, span = 1.15) => {
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -span + (2 * span * i) / (n - 1);
      const y = -span + (2 * span * j) / (n - 1);
      out.push({ x, y, v: fn(x, y) });
    }
  }
  return out;
};

const loud = (o = {}) => Object.assign(idleState(), { amp: 0.8 }, o);

test('psi is finite everywhere, including the origin', () => {
  // atan2(0,0) and the 1/sqrt radial term both live at r = 0.
  const s = loud();
  for (const { v } of grid((x, y) => psi(x, y, s), 60)) {
    assert.ok(Number.isFinite(v), 'non-finite psi');
  }
  assert.ok(Number.isFinite(psi(0, 0, s)));
});

test('water gathers on the NODAL lines, not the antinodes', () => {
  // This is the whole physical premise: liquid is driven off high-amplitude
  // regions and collects where the plate is still. If it ever inverts, the
  // figure becomes the negative of a Chladni pattern.
  const s = loud();
  let onNode = 0, offNode = 0, nodeN = 0, offN = 0;
  for (const { x, y } of grid(() => 0, 70)) {
    if (Math.hypot(x, y) > 0.95) continue;
    const f = Math.abs(psi(x, y, s));
    const T = nodalThickness(x, y, s);
    if (f < 0.05) { onNode += T; nodeN++; } else if (f > 0.5) { offNode += T; offN++; }
  }
  assert.ok(nodeN > 20 && offN > 20, 'sampling did not find both regions');
  assert.ok(onNode / nodeN > 0.7, `water should stand on nodes (${onNode / nodeN})`);
  assert.ok(offNode / offN < 0.1, `antinodes should be dry (${offNode / offN})`);
});

test('the figure is CONNECTED paths, not isolated round pools', () => {
  // The failure being fixed: a handful of separate near-circular blobs. A
  // nodal figure is long connected curves, so its contour rings must be far
  // longer relative to the area they enclose than a circle's would be.
  const s = loud({ m: 5, n: 3, mix: 0.15 });
  const { rings } = fieldOutline(makeWaterField(s), { width: 1200, height: 1200, res: 420 });
  assert.ok(rings.length > 0, 'no contour at all');

  let worst = 0;
  for (const r of rings) {
    if (r.length < 12) continue;
    let per = 0, area = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
      area += a[0] * b[1] - b[0] * a[1];
    }
    area = Math.abs(area) / 2;
    if (area < 400) continue;
    // 1.0 for a perfect circle; higher means longer, more sinuous boundary.
    worst = Math.max(worst, per / (2 * Math.sqrt(Math.PI * area)));
  }
  assert.ok(worst > 1.8, `largest pool is too circular (isoperimetric ratio ${worst.toFixed(2)})`);
});

test('pitch changes the TOPOLOGY, not just a size or a colour', () => {
  // Acceptance criterion: "frequency changes alter the topology". Count the
  // separate contour rings — a different modal order gives a different number
  // of nodal cells, which a mere scale change never would.
  const at = (pitchNorm) => {
    const s = Object.assign(idleState(),
      targetFromFeatures({ pitchNorm, rms: 0.3, centroid: 0.4, spread: 0.15, pitchConf: 0.9 }));
    s.amp = 0.7;
    return marchingSquares(makeWaterField(s), { x0: -1.2, y0: -1.2, x1: 1.2, y1: 1.2 }, 300).length;
  };
  const lowN = at(0.12), highN = at(0.85);
  assert.ok(highN > lowN + 2,
    `higher pitch must give finer nodal structure (low ${lowN} vs high ${highN})`);
});

test('amplitude controls how much water is gathered into the figure', () => {
  const area = (amp) => {
    const s = Object.assign(idleState(), { m: 4, n: 3, amp });
    let a = 0;
    for (const { x, y } of grid(() => 0, 80)) {
      if (Math.hypot(x, y) < 0.95) a += nodalThickness(x, y, s);
    }
    return a;
  };
  const quiet = area(0.05), mid = area(0.4), full = area(0.95);
  assert.ok(mid > quiet * 1.5, `amplitude must widen the figure (${quiet} -> ${mid})`);
  assert.ok(full > mid, `and keep widening (${mid} -> ${full})`);
});

test('silence shows scattered droplets; sound pulls them into the pattern', () => {
  // The requested state machine: idle = droplets, sound = cymatic formation.
  const quiet = idleState();
  assert.equal(gather(quiet), 0, 'silence must not gather');
  let dropArea = 0;
  for (const { x, y } of grid(() => 0, 80)) dropArea += droplets(x, y, quiet);
  assert.ok(dropArea > 50, `idle should still show some water (${dropArea})`);

  const s = loud();
  assert.ok(gather(s) > 0.95, 'loud input must fully gather');
  // With sound, the droplet term is switched out entirely.
  const withDrops = thickness(0.9, 0.9, s, true);
  assert.ok(Math.abs(withDrops - nodalThickness(0.9, 0.9, s)) < 1e-6);
});

test('droplets are irregular, not a repeating grid of identical circles', () => {
  const s = idleState();
  const sizes = [];
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      let a = 0;
      for (let k = 0; k < 400; k++) {
        const x = i * 0.38 + (k % 20) * 0.019, y = j * 0.38 + Math.floor(k / 20) * 0.019;
        a += droplets(x, y, s);
      }
      sizes.push(a);
    }
  }
  const mean = sizes.reduce((p, c) => p + c, 0) / sizes.length;
  const sd = Math.sqrt(sizes.reduce((p, c) => p + (c - mean) ** 2, 0) / sizes.length);
  assert.ok(sd > mean * 0.25, `droplet field is too uniform (sd ${sd.toFixed(1)} vs mean ${mean.toFixed(1)})`);
});

test('a transient adds an outward ripple that decays', () => {
  const s = loud();
  const before = psi(0.5, 0, s);
  kick(s, 1);
  assert.ok(s.ripAmt > 0);
  const during = psi(0.5, 0, s);
  assert.notEqual(before, during, 'a transient must disturb the surface');
  for (let i = 0; i < 100; i++) advance(s, 0.05);
  assert.ok(s.ripAmt < 0.01, `ripple must decay (${s.ripAmt})`);
});

test('glide morphs continuously — no snap between figures', () => {
  const s = idleState();
  const target = targetFromFeatures({ pitchNorm: 0.9, rms: 0.5, centroid: 0.8, spread: 0.2, pitchConf: 0.9 });
  let prev = { ...s }, maxStep = 0;
  // 2.5s at tau=0.5 is ~99% of the way; 1s would only be 86% and the
  // "arrived" assertion would be measuring the tolerance, not the glide.
  for (let i = 0; i < 150; i++) {
    glide(s, target, 1 / 60, 0.5);
    maxStep = Math.max(maxStep, Math.abs(s.m - prev.m), Math.abs(s.kr - prev.kr));
    prev = { ...s };
  }
  assert.ok(maxStep < 0.6, `parameters jumped by ${maxStep} in one frame`);
  assert.ok(Math.abs(s.m - target.m) < 0.5, 'glide never arrived');
});

test('field parameters stay finite under sustained glide from any features', () => {
  const s = idleState();
  for (const pitchNorm of [0, 0.5, 1]) {
    for (const rms of [0, 1]) {
      for (const spread of [0, 1]) {
        const t = targetFromFeatures({ pitchNorm, rms, centroid: 0.5, spread, pitchConf: 0.2 });
        for (let i = 0; i < 40; i++) { glide(s, t, 1 / 60); advance(s, 1 / 60); }
        for (const k of ['m', 'n', 'kr', 'ma', 'mix', 'amp', 'fine', 'chaos']) {
          assert.ok(Number.isFinite(s[k]), `${k} went non-finite`);
        }
        assert.ok(s.mix >= 0 && s.mix <= 1, `mix out of range: ${s.mix}`);
      }
    }
  }
});

// ── generator ──────────────────────────────────────────────────────────
test('liquid generate returns a field state, never circles or a cloud', () => {
  const fp = { pitchMedian: 0.5, volMean: 0.4, centroid: 0.4, spread: 0.3,
               pitchConfidence: 0.8, seed: 12345 };
  const out = generateLiquid(fp, { complexity: 0.5 });
  assert.equal(out.kind, 'field');
  assert.ok(out.state && Number.isFinite(out.state.m));
  assert.equal(out.circles, undefined, 'the circle model must be gone');
  assert.equal(out.positions.length, 0);
});

test('recorded playback is a TIME SEQUENCE and is deterministic', () => {
  // Acceptance criterion: the same recording animates the same way, and is
  // not reduced to one static fingerprint.
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ t: i * 0.05, pitchHz: 110 + i * 40, rms: 0.05 + i * 0.01,
                  centroid: 0.2 + i * 0.015, spread: 0.3, pitchConf: 0.9 });
  }
  const a1 = stateAtTime(frames, 0.1, {}), a2 = stateAtTime(frames, 0.1, {});
  assert.deepEqual(a1, a2, 'same recording, same time → same state');
  const late = stateAtTime(frames, 1.8, {});
  assert.ok(Math.abs(late.m - a1.m) > 0.5,
    `the figure must change over the recording (${a1.m} vs ${late.m})`);
});

test('featuresOf normalises pitch over the app-wide 6 octaves', () => {
  assert.ok(Math.abs(featuresOf({ pitchHz: 55 }).pitchNorm - 0) < 1e-9);
  assert.ok(Math.abs(featuresOf({ pitchHz: 3520 }).pitchNorm - 1) < 1e-9);
  // Unvoiced frames must not read as "lowest possible note".
  assert.ok(featuresOf({ pitchHz: 0 }).pitchNorm > 0.2);
});

test('stateFromFingerprint and stateFromFrame produce usable, finite states', () => {
  const s1 = stateFromFingerprint({ pitchMedian: 0.7, volMean: 0.5, centroid: 0.6,
                                    spread: 0.2, pitchConfidence: 0.9 }, { complexity: 0.9 });
  const s2 = stateFromFrame({ pitchHz: 440, rms: 0.2, centroid: 0.5, spread: 0.2, pitchConf: 0.8 }, {});
  for (const s of [s1, s2]) {
    for (const k of ['m', 'n', 'kr', 'ma', 'mix', 'amp']) assert.ok(Number.isFinite(s[k]), k);
    assert.ok(s.m >= 1.2 && s.n >= 1.0, 'modal orders must stay in a drawable range');
  }
});

test('no seam along the atan branch cut', () => {
  // cos(ma*theta) is periodic only for integer ma. With ma continuous (which
  // it must be, so the angular order can morph) a naive term draws a hard
  // line straight across the figure at theta = +-pi.
  for (const ma of [2.0, 2.5, 3.3, 4.7]) {
    const s = Object.assign(idleState(), { ma, amp: 0.7, mix: 1 });
    for (const r of [0.3, 0.6, 0.9]) {
      const above = psi(-r, +1e-5, s);
      const below = psi(-r, -1e-5, s);
      assert.ok(Math.abs(above - below) < 1e-3,
        `seam at ma=${ma}, r=${r}: ${above} vs ${below}`);
    }
  }
});

test('idle droplets differ in SHAPE, not merely in position and rotation', () => {
  // Fixed wobble harmonics gave every droplet the same silhouette rotated —
  // repeated identical forms, which is the circle failure in another costume.
  // Compare radial signatures: congruent shapes would match after alignment,
  // so their sorted radius profiles would be near-identical.
  const s = idleState();
  const sig = (cx, cy) => {
    const prof = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      let hit = 0;
      for (let r = 0.01; r < 0.5; r += 0.006) {
        if (droplets(cx + Math.cos(a) * r, cy + Math.sin(a) * r, s) > 0.2) hit = r;
      }
      prof.push(hit);
    }
    return prof.sort((a, b) => a - b);   // rotation-invariant
  };
  // Droplets sit on a jittered 1/2.6 lattice, so probe a dense grid and keep
  // well-separated peaks rather than assuming where the centres landed.
  const peaks = [];
  for (let y = -0.95; y <= 0.95; y += 0.03) {
    for (let x = -0.95; x <= 0.95; x += 0.03) {
      if (droplets(x, y, s) < 0.62) continue;   // idle water peaks at 0.7
      if (peaks.some(([px, py]) => Math.hypot(px - x, py - y) < 0.30)) continue;
      peaks.push([x, y]);
    }
  }
  const found = peaks.slice(0, 4).map(([cx, cy]) => sig(cx, cy));
  assert.ok(found.length >= 3, `needed several droplets, found ${found.length}`);
  let maxDiff = 0;
  for (let a = 0; a < found.length; a++) {
    for (let b = a + 1; b < found.length; b++) {
      let d = 0;
      for (let k = 0; k < found[a].length; k++) d += Math.abs(found[a][k] - found[b][k]);
      maxDiff = Math.max(maxDiff, d / found[a].length);
    }
  }
  assert.ok(maxDiff > 0.02, `droplets are congruent (mean profile diff ${maxDiff.toFixed(4)})`);
});
