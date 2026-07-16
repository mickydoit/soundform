import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, fitPreset, availablePresets, FrameGate, ChunkStore } from '../js/recorder.js';

test('fitPreset: preserves aspect, forces even dims, never upscales', () => {
  assert.deepEqual(fitPreset(3456, 2234, 1080), { width: 1670, height: 1080 });
  assert.deepEqual(fitPreset(1280, 720, 1080), { width: 1280, height: 720 }); // no upscale
  assert.deepEqual(fitPreset(1281, 721, null), { width: 1280, height: 720 }); // original: just even
});

test('availablePresets: hides presets at or above source height', () => {
  const ids = (h) => availablePresets(h).map(p => p.id);
  assert.deepEqual(ids(2234), ['original', '1080-high', '1080-med', '720']);
  assert.deepEqual(ids(1080), ['original', '720']);
  assert.deepEqual(ids(720), ['original']);
});

test('FrameGate: ~30 of 60 rAF ticks pass, timestamps monotonic 33.3ms apart', () => {
  const g = new FrameGate(30);
  const accepted = [];
  for (let i = 0; i < 60; i++) {
    const ts = g.accept(i * (1000 / 60));
    if (ts !== null) accepted.push(ts);
  }
  assert.ok(accepted.length >= 29 && accepted.length <= 31, `got ${accepted.length}`);
  for (let i = 1; i < accepted.length; i++) {
    const gap = accepted[i] - accepted[i - 1];
    assert.ok(Math.abs(gap - 1e6 / 30) <= 1, `gap ${gap} not ~33333µs`); // integer rounding alternates 33333/33334
  }
});

test('FrameGate: a long wall-clock gap does not flood or stall', () => {
  const g = new FrameGate(30);
  g.accept(0);
  const ts = g.accept(5000);            // tab was hidden ~5s
  assert.notEqual(ts, null);            // resumes immediately
  assert.equal(ts, Math.round(1e6 / 30)); // video time continues, gap skipped
});

test('ChunkStore: copies bytes, keeps first decoderConfig, clears', () => {
  const store = new ChunkStore();
  const fakeChunk = (n) => ({
    byteLength: 4, type: n === 0 ? 'key' : 'delta',
    timestamp: n * 33333, duration: 33333,
    copyTo: (dst) => dst.set([n, n, n, n]),
  });
  store.add(fakeChunk(0), { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array([9, 9]) } });
  store.add(fakeChunk(1), {});
  assert.equal(store.chunks.length, 2);
  assert.deepEqual([...store.chunks[1].data], [1, 1, 1, 1]);
  assert.equal(store.config.codec, 'avc1.640028');
  assert.equal(store.bytes, 8);
  assert.ok(Math.abs(store.durationSec - 0.0667) < 0.001);
  store.clear();
  assert.equal(store.chunks.length, 0);
  assert.equal(store.config, null);
});
