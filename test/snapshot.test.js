import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../js/generators/index.js';
import { testFingerprint, baseParams } from './generators.test.js';

// Order-sensitive rolling hash over strided samples of a Float32Array.
// Floats are IEEE-deterministic across runs, so this pins exact output.
function checksum(arr) {
  let h = 0;
  const step = Math.max(1, Math.floor(arr.length / 20000));
  for (let i = 0; i < arr.length; i += step) {
    h = (Math.imul(h, 31) + Math.round(arr[i] * 1e5)) | 0;
  }
  return h;
}

export function modeChecksum(mode) {
  const out = generate(testFingerprint(), { ...baseParams, mode, density: 20000 });
  return [checksum(out.positions), checksum(out.attr)].join(':');
}

// GOLDEN values captured from the pre-form-families code. If a change to a
// generator breaks one of these, non-live output has drifted — that is a bug.
const GOLDEN = {
  attractor: '1621501298:1536358715',
  radial: '1167620147:542659216',
  cymatics: '-155424434:2017808997',
  oscillo: '1015603296:1361149440',
  harmonic: '-720626616:-207032249',
};

for (const mode of Object.keys(GOLDEN)) {
  test(`snapshot: ${mode} output unchanged without liveVariance`, () => {
    assert.equal(modeChecksum(mode), GOLDEN[mode]);
  });
}
