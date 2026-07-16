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

import { LiveRecorder, RECORD_FPS } from '../js/recorder.js';

// ── fakes ─────────────────────────────────────────────────────────
class FakeEncoder {
  constructor({ output, error }) { this.output = output; this.err = error; this.encodeQueueSize = 0; this.encoded = []; FakeEncoder.last = this; }
  static async isConfigSupported() { return { supported: true }; }
  configure(cfg) { this.cfg = cfg; }
  encode(frame, opts) {
    this.encoded.push({ ts: frame.timestamp, key: !!opts?.keyFrame });
    this.output(
      { byteLength: 3, type: opts?.keyFrame ? 'key' : 'delta', timestamp: frame.timestamp,
        duration: frame.duration, copyTo: (d) => d.set([7, 7, 7]) },
      this.encoded.length === 1 ? { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array([1]) } } : {},
    );
  }
  async flush() {}
  close() {}
}
class FakeFrame {
  constructor(src, { timestamp, duration }) { this.timestamp = timestamp; this.duration = duration; }
  close() {}
}
class FakeMuxer {
  constructor(opts) { this.opts = opts; this.raw = []; this.finalized = false; this.target = { buffer: new ArrayBuffer(1) }; FakeMuxer.last = this; }
  addVideoChunkRaw(data, type, ts, dur, meta) { this.raw.push({ data, type, ts, dur, meta }); }
  addVideoChunk() {}
  finalize() { this.finalized = true; }
}
const fakeDeps = (downloads) => ({
  VideoEncoder: FakeEncoder,
  VideoFrame: FakeFrame,
  getMuxer: () => ({ Muxer: FakeMuxer, ArrayBufferTarget: class {} }),
  download: (buf) => downloads.push(buf),
});

test('LiveRecorder: record → stop → original export muxes stored chunks', async () => {
  const downloads = [];
  const rec = new LiveRecorder(fakeDeps(downloads));
  await rec.start({ width: 1281, height: 721 });
  assert.equal(rec.recording, true);
  assert.equal(FakeEncoder.last.cfg.width, 1280);   // even dims
  for (let i = 0; i < 60; i++) rec.captureTick(i * (1000 / 60)); // 1s of rAF
  await rec.stop();
  assert.equal(rec.recording, false);
  assert.ok(rec.hasMaster);
  assert.ok(rec.store.chunks.length >= 29 && rec.store.chunks.length <= 31);
  assert.ok(Math.abs(rec.elapsedSec - rec.store.chunks.length / RECORD_FPS) < 0.05);

  const ok = await rec.exportAt('original', {});
  assert.equal(ok, true);
  const m = FakeMuxer.last;
  assert.equal(m.raw.length, rec.store.chunks.length);
  assert.ok(m.raw[0].meta?.decoderConfig, 'first raw chunk carries decoderConfig');
  assert.equal(m.raw[1].meta, undefined);
  assert.ok(m.finalized);
  assert.equal(downloads.length, 1);

  await rec.exportAt('original', {});               // export many times
  assert.equal(downloads.length, 2);

  rec.discard();
  assert.equal(rec.hasMaster, false);
});

test('LiveRecorder: starting a new recording discards the old master', async () => {
  const rec = new LiveRecorder(fakeDeps([]));
  await rec.start({ width: 640, height: 480 });
  for (let i = 0; i < 30; i++) rec.captureTick(i * 33.4);
  await rec.stop();
  const before = rec.store.chunks.length;
  assert.ok(before > 0);
  await rec.start({ width: 640, height: 480 });
  assert.equal(rec.store.chunks.length, 0);
  await rec.stop();
});

test('LiveRecorder: availableQualities reflects recorded height', async () => {
  const rec = new LiveRecorder(fakeDeps([]));
  await rec.start({ width: 1280, height: 720 });
  await rec.stop();
  assert.deepEqual(rec.availableQualities().map(p => p.id), ['original']);
});
