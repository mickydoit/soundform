# Live Video Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the Live session's visuals (silent) into an in-memory WebCodecs master, then export that take repeatedly as mp4 at different qualities.

**Architecture:** New `js/recorder.js` owns everything codec-side: a 30 fps frame gate fed by a new post-render hook on `DensityRenderer`, an H.264 `VideoEncoder` whose encoded chunks are stored in memory (the master), direct muxing for Original quality, and a decode→rescale→re-encode pipeline for lower presets. `js/main.js` wires a record button, timer, and a "Video ready" panel into the live lifecycle.

**Tech Stack:** Vanilla ES modules, WebCodecs (`VideoEncoder`/`VideoDecoder`/`VideoFrame`), vendored `js/vendor/mp4-muxer.min.js` (`window.Mp4Muxer`, has `addVideoChunkRaw`). Tests: `node --test` (`npm test`). Spec: `docs/superpowers/specs/2026-07-16-live-video-recording-design.md`.

## Global Constraints

- Silent video — never touch mic audio.
- Live mode only; the captured-design loop MP4 export is untouched.
- Record cap: `MAX_RECORD_SEC = 300` (5 min); master bitrate 12 Mbps; 30 fps.
- Presets: `original` (direct mux) / `1080-high` 12 Mbps / `1080-med` 6 Mbps / `720` 4 Mbps; never upscale.
- H.264 codec ladder: `avc1.640028`, fallback `avc1.42001f` (same as `exportMP4`).
- Record button hidden unless `'VideoEncoder' in window`.
- `LiveRecorder` takes injected deps (defaulting to globals) so node tests can use fakes; WebCodecs classes never run in node tests.
- Cache version: bump every `?v=34` to `?v=35` in Task 4 only.
- Run `npm test` before every commit.

---

### Task 1: recorder.js pure core — presets, frame gate, chunk store

**Files:**
- Create: `js/recorder.js`
- Create: `test/recorder.test.js`

**Interfaces:**
- Produces (all exported from `js/recorder.js`):
  - `PRESETS`: array of `{ id, label, height, bitrate }` (`height: null` = original).
  - `fitPreset(srcW, srcH, height) -> { width, height }` — aspect-preserving, even dims, no upscale.
  - `availablePresets(srcH) -> PRESETS subset` (original always included).
  - `class FrameGate(fps)` — `.accept(nowMs) -> µs timestamp | null`, `.count`.
  - `class ChunkStore` — `.add(chunk, meta)`, `.chunks`, `.config`, `.bytes`, `.durationSec`, `.clear()`.

- [ ] **Step 1: Write the failing tests**

```js
// test/recorder.test.js
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
    assert.equal(accepted[i] - accepted[i - 1], Math.round(1e6 / 30));
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `js/recorder.js` does not exist.

- [ ] **Step 3: Implement** — create `js/recorder.js`:

```js
// Live session video recording: an in-memory H.264 master (encoded chunks)
// captured from the WebGL canvas at 30fps, exported as mp4 at the recorded
// quality (direct mux) or downscaled presets (decode → rescale → re-encode).
// Pure helpers live up top and are node-tested; WebCodecs classes are
// injected so tests can fake them.

export const RECORD_FPS = 30;
export const MAX_RECORD_SEC = 300;
export const MASTER_BITRATE = 12_000_000;

export const PRESETS = [
  { id: 'original', label: 'Original', height: null, bitrate: null },
  { id: '1080-high', label: '1080p · high', height: 1080, bitrate: 12_000_000 },
  { id: '1080-med', label: '1080p · medium', height: 1080, bitrate: 6_000_000 },
  { id: '720', label: '720p', height: 720, bitrate: 4_000_000 },
];

// Aspect-preserving fit to a target height; H.264 needs even dimensions.
// height null (original) or >= source: keep source size (never upscale).
export function fitPreset(srcW, srcH, height) {
  if (!height || height >= srcH) return { width: srcW & ~1, height: srcH & ~1 };
  const w = Math.round(srcW * (height / srcH));
  return { width: w & ~1, height: height & ~1 };
}

export function availablePresets(srcH) {
  return PRESETS.filter(p => p.height === null || p.height < srcH);
}

// Thins the rAF firehose (60/120Hz) to a steady RECORD_FPS. Emitted
// timestamps are pure frame counts, so a hidden-tab gap in wall time is
// simply skipped in the video rather than freezing it.
export class FrameGate {
  constructor(fps = RECORD_FPS) {
    this.fps = fps;
    this.intervalMs = 1000 / fps;
    this.nextDue = null;
    this.count = 0;
  }
  accept(nowMs) {
    if (this.nextDue !== null && nowMs < this.nextDue) return null;
    this.nextDue = (this.nextDue === null
      ? nowMs : Math.max(this.nextDue, nowMs - this.intervalMs)) + this.intervalMs;
    return Math.round(this.count++ * 1e6 / this.fps);
  }
}

// The master: encoded H.264 chunks copied to plain bytes (+ the first
// decoderConfig, needed to mux and to re-decode for scaled exports).
export class ChunkStore {
  constructor() { this.clear(); }
  add(chunk, meta) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.chunks.push({ data, type: chunk.type, timestamp: chunk.timestamp,
                       duration: chunk.duration ?? Math.round(1e6 / RECORD_FPS) });
    this.bytes += chunk.byteLength;
    if (meta?.decoderConfig && !this.config) {
      this.config = { ...meta.decoderConfig };
      if (this.config.description) {
        this.config.description = new Uint8Array(this.config.description).slice();
      }
    }
  }
  get durationSec() {
    const last = this.chunks[this.chunks.length - 1];
    return last ? (last.timestamp + (last.duration || 0)) / 1e6 : 0;
  }
  clear() { this.chunks = []; this.config = null; this.bytes = 0; }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add js/recorder.js test/recorder.test.js
git commit -m "feat(video): recorder pure core — presets, frame gate, chunk store"
```

---

### Task 2: LiveRecorder — record, direct mux, re-encode

**Files:**
- Modify: `js/recorder.js` (append)
- Test: `test/recorder.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `FrameGate`, `ChunkStore`, `fitPreset`, `availablePresets`, `PRESETS`, constants.
- Produces: `class LiveRecorder(deps?)` with:
  - `start(canvas) -> Promise<void>` (discards any prior master first)
  - `captureTick(nowMs)` — call every rendered frame while recording
  - `stop() -> Promise<void>` — flushes; master kept
  - `recording: bool`, `hasMaster: bool`, `elapsedSec: number`
  - `onLimit`, `onError` — optional callbacks
  - `availableQualities() -> presets for the recorded size`
  - `exportAt(presetId, { onProgress, shouldCancel }) -> Promise<bool>` (false = cancelled)
  - `discard()`
  - deps: `{ VideoEncoder, VideoDecoder, VideoFrame, EncodedVideoChunk, getMuxer, download, createCanvas }`, each defaulting to the browser global.

- [ ] **Step 1: Write the failing tests** (append to `test/recorder.test.js`)

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `LiveRecorder` is not exported.

- [ ] **Step 3: Implement** — append to `js/recorder.js`:

```js
function defaultDownload(buffer, name = 'soundform-live.mp4') {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export class LiveRecorder {
  constructor(deps = {}) {
    this.deps = {
      VideoEncoder: deps.VideoEncoder ?? globalThis.VideoEncoder,
      VideoDecoder: deps.VideoDecoder ?? globalThis.VideoDecoder,
      VideoFrame: deps.VideoFrame ?? globalThis.VideoFrame,
      EncodedVideoChunk: deps.EncodedVideoChunk ?? globalThis.EncodedVideoChunk,
      getMuxer: deps.getMuxer ?? (() => globalThis.Mp4Muxer),
      download: deps.download ?? defaultDownload,
      createCanvas: deps.createCanvas ??
        ((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })),
    };
    this.store = new ChunkStore();
    this.recording = false;
    this.encoder = null;
    this.gate = null;
    this.canvas = null;
    this.width = 0; this.height = 0;
    this.onLimit = null;
    this.onError = null;
  }

  get hasMaster() { return !this.recording && this.store.chunks.length > 0; }
  get elapsedSec() { return this.gate ? this.gate.count / RECORD_FPS : 0; }

  async start(canvas) {
    this.discard();
    this.canvas = canvas;
    this.width = canvas.width & ~1;
    this.height = canvas.height & ~1;
    this.gate = new FrameGate(RECORD_FPS);
    const { VideoEncoder } = this.deps;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.store.add(chunk, meta),
      error: (e) => this._abort(e),
    });
    let cfg = { codec: 'avc1.640028', width: this.width, height: this.height,
                bitrate: MASTER_BITRATE, framerate: RECORD_FPS };
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg = { ...cfg, codec: 'avc1.42001f' };
    this.encoder.configure(cfg);
    this.recording = true;
  }

  captureTick(nowMs) {
    if (!this.recording) return;
    const ts = this.gate.accept(nowMs);
    if (ts === null) return;
    if (this.encoder.encodeQueueSize > 4) return;      // behind: drop, don't stall the render loop
    const frame = new this.deps.VideoFrame(this.canvas,
      { timestamp: ts, duration: Math.round(1e6 / RECORD_FPS) });
    this.encoder.encode(frame, { keyFrame: (this.gate.count - 1) % (RECORD_FPS * 2) === 0 });
    frame.close();
    if (this.elapsedSec >= MAX_RECORD_SEC) { this.stop(); if (this.onLimit) this.onLimit(); }
  }

  async stop() {
    if (!this.recording) return;
    this.recording = false;
    try { await this.encoder.flush(); } catch { /* aborted */ }
    try { this.encoder.close(); } catch { /* already closed */ }
    this.encoder = null;
  }

  _abort(e) {
    this.recording = false;
    try { this.encoder?.close(); } catch { /* already closed */ }
    this.encoder = null;
    this.store.clear();
    if (this.onError) this.onError(e);
  }

  discard() { this.store.clear(); this.gate = null; }

  availableQualities() { return availablePresets(this.height); }

  async exportAt(presetId, { onProgress, shouldCancel } = {}) {
    const preset = PRESETS.find(p => p.id === presetId);
    if (!preset || !this.hasMaster) return false;
    if (preset.height === null || preset.height >= this.height) return this._muxOriginal();
    return this._reencode(preset, onProgress, shouldCancel);
  }

  // Original quality: the stored chunks ARE the video — mux, no re-encode.
  _muxOriginal() {
    const { Muxer, ArrayBufferTarget } = this.deps.getMuxer();
    const muxer = new Muxer({ target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: this.width, height: this.height }, fastStart: 'in-memory' });
    this.store.chunks.forEach((c, i) => muxer.addVideoChunkRaw(
      c.data, c.type, c.timestamp, c.duration,
      i === 0 ? { decoderConfig: this.store.config } : undefined));
    muxer.finalize();
    this.deps.download(muxer.target.buffer);
    return true;
  }

  // Scaled preset: master chunks → VideoDecoder → draw scaled → VideoEncoder → mux.
  async _reencode(preset, onProgress, shouldCancel) {
    const { width, height } = fitPreset(this.width, this.height, preset.height);
    const { VideoDecoder, VideoEncoder, VideoFrame, EncodedVideoChunk } = this.deps;
    const stage = this.deps.createCanvas(width, height);
    const ctx = stage.getContext('2d');
    const { Muxer, ArrayBufferTarget } = this.deps.getMuxer();
    const muxer = new Muxer({ target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
    let pipeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { pipeError = e; },
    });
    let cfg = { codec: 'avc1.640028', width, height, bitrate: preset.bitrate, framerate: RECORD_FPS };
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg = { ...cfg, codec: 'avc1.42001f' };
    encoder.configure(cfg);
    const total = this.store.chunks.length;
    let done = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        ctx.drawImage(frame, 0, 0, width, height);
        const out = new VideoFrame(stage,
          { timestamp: frame.timestamp, duration: frame.duration ?? Math.round(1e6 / RECORD_FPS) });
        frame.close();
        encoder.encode(out, { keyFrame: done % (RECORD_FPS * 2) === 0 });
        out.close();
        done++;
        if (onProgress) onProgress(done / total);
      },
      error: (e) => { pipeError = e; },
    });
    decoder.configure(this.store.config);
    let cancelled = false;
    for (const c of this.store.chunks) {
      if (shouldCancel && shouldCancel()) { cancelled = true; break; }
      if (pipeError) break;
      decoder.decode(new EncodedVideoChunk(
        { type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data }));
      while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) {
        await new Promise(r => setTimeout(r, 10));
      }
    }
    if (!cancelled && !pipeError) {
      await decoder.flush();
      await encoder.flush();
    }
    try { decoder.close(); } catch { /* already closed */ }
    try { encoder.close(); } catch { /* already closed */ }
    if (pipeError) throw pipeError;
    if (cancelled) return false;
    muxer.finalize();
    this.deps.download(muxer.target.buffer);
    return true;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (3 more tests).

- [ ] **Step 5: Commit**

```bash
git add js/recorder.js test/recorder.test.js
git commit -m "feat(video): LiveRecorder — master record, direct mux, re-encode exports"
```

---

### Task 3: Renderer frame sink + record button and timer

**Files:**
- Modify: `js/density.js` (constructor area + `_loop` tail + one getter)
- Modify: `js/main.js` (imports, state, `bindAudio` area, `enterLive`, `stopLive`, clear handler)
- Modify: `index.html` (record button)
- Modify: `style.css` (recording pulse)

*(DOM/WebGL code — verified by the manual acceptance pass; `npm test` still guards everything else.)*

**Interfaces:**
- Consumes: `LiveRecorder`, `MAX_RECORD_SEC` from `js/recorder.js`.
- Produces: `renderer.setFrameSink(cb|null)` (cb gets `performance.now()` after every drawn frame); `renderer.canvas` getter; `#btn-record` element; `recorder` module-level variable in `main.js`; `stopRecording()` function used by Task 4.

- [ ] **Step 1: density.js — frame sink.** In `_loop` (js/density.js:389), the render happens at the tail:

```js
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
```

Change to:

```js
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
    // Post-render hook (live video recording): the WebGL buffer is only
    // valid in the same task as the draw, so capture must happen here.
    if (this._frameSink) this._frameSink(performance.now());
```

In the constructor (near `this._loopPeriod = 8;`) add `this._frameSink = null;`, and add alongside the other small setters (near `setLoopPeriod`):

```js
  setFrameSink(cb) { this._frameSink = cb; }
  get canvas() { return this.renderer.domElement; }
```

- [ ] **Step 2: index.html — record button.** After the `#btn-live` button inside `#audio-controls`:

```html
        <button id="btn-record" class="btn-icon hidden" title="Record video" aria-label="Record video">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>
        </button>
```

- [ ] **Step 3: style.css — pulse.** Append:

```css
/* Live video recording */
#btn-record.recording { color: #e8b4c8; animation: rec-pulse 1.4s ease-in-out infinite; }
@keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
```

- [ ] **Step 4: main.js — record wiring.** Add to the imports:

```js
import { LiveRecorder, MAX_RECORD_SEC } from './recorder.js?v=34';
```

(v=34 now; Task 4's bump rewrites it to v=35.)

Near `let conductor = null;` add:

```js
let recorder = null;
let lastTimerSec = -1;
```

In `bindAudio()` (after the `btnLive` handler) add:

```js
  const btnRecord = document.getElementById('btn-record');
  btnRecord.addEventListener('click', async () => {
    if (appState !== 'live') return;
    if (recorder && recorder.recording) { await stopRecording(); return; }
    recorder = recorder || new LiveRecorder();
    recorder.onLimit = () => { finishRecordingUI(); setStatus('Recording stopped — 5 minute limit'); };
    recorder.onError = (e) => { finishRecordingUI(); setStatus(`Recording error: ${e.message}`); };
    try {
      await recorder.start(renderer.canvas);
    } catch (e) { setStatus(`Recording error: ${e.message}`); return; }
    lastTimerSec = -1;
    btnRecord.classList.add('recording');
    renderer.setFrameSink((now) => {
      recorder.captureTick(now);
      const s = Math.floor(recorder.elapsedSec);
      if (s !== lastTimerSec && recorder.recording) {
        lastTimerSec = s;
        setStatus(`Recording — ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      }
    });
  });
```

And these two functions after `stopLive()`:

```js
// Tear down recording UI state; the master (if any) stays in `recorder`.
function finishRecordingUI() {
  renderer.setFrameSink(null);
  document.getElementById('btn-record').classList.remove('recording');
}

async function stopRecording() {
  if (!recorder || !recorder.recording) return;
  await recorder.stop();
  finishRecordingUI();
  setStatus('Live — listening');
  showVideoReady();   // defined in Task 4
}
```

For this task only, add a stub so the file runs before Task 4 exists:

```js
function showVideoReady() {}
```

Lifecycle edits:
- `enterLive()` — after `vuWrap.classList.remove('hidden');` add:
  ```js
  if ('VideoEncoder' in window) document.getElementById('btn-record').classList.remove('hidden');
  ```
- `stopLive()` — at the top, after the `if (!conductor) return;` guard, add:
  ```js
  if (recorder && recorder.recording) { recorder.stop(); finishRecordingUI(); }
  document.getElementById('btn-record').classList.add('hidden');
  ```
- Clear handler (the `clearBtn.addEventListener` in `bindAudio`) — after `stopLive();` add:
  ```js
  if (recorder) { recorder.discard(); }
  ```

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: PASS (unchanged — DOM code isn't node-tested).

```bash
git add js/density.js js/main.js index.html style.css
git commit -m "feat(video): record button, frame sink, recording timer"
```

---

### Task 4: Video-ready panel, quality exports, cache bump

**Files:**
- Modify: `index.html` (panel markup)
- Modify: `style.css` (panel styles)
- Modify: `js/main.js` (replace stub `showVideoReady`, export/discard handlers)
- Modify: all `?v=34` refs → `?v=35`

**Interfaces:**
- Consumes: `recorder.hasMaster`, `recorder.availableQualities()`, `recorder.exportAt(presetId, { onProgress, shouldCancel })`, `recorder.discard()`; `#video-ready` panel.
- Produces: complete feature.

- [ ] **Step 1: index.html — panel.** Inside `#canvas-wrap`, after the `#vu-wrap` block:

```html
    <!-- Video recording review: export the last take at any quality -->
    <div id="video-ready" class="hidden">
      <span class="vr-label">Video ready</span>
      <select id="sel-video-quality"></select>
      <button id="btn-video-export" class="vr-btn">Export</button>
      <button id="btn-video-discard" class="vr-btn vr-discard">Discard</button>
    </div>
```

- [ ] **Step 2: style.css — panel.** Append (matches the frosted chrome used by `#status-bar`/`#vu-wrap`; soft pastel accents):

```css
#video-ready {
  position: absolute; bottom: 60px; left: 16px;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 12px;
  background: rgba(20, 22, 30, 0.7); backdrop-filter: blur(12px);
  border: 1px solid rgba(184, 167, 224, 0.25);
  font-size: 12px; color: #cfc9e0; z-index: 5;
}
#video-ready.hidden { display: none; }
#video-ready .vr-label { color: #b8a7e0; }
#video-ready select { font-size: 12px; }
#video-ready .vr-btn {
  padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(184, 167, 224, 0.35);
  background: rgba(184, 167, 224, 0.15); color: #e8e4f4; cursor: pointer; font-size: 12px;
}
#video-ready .vr-discard { border-color: rgba(232, 180, 200, 0.35); background: rgba(232, 180, 200, 0.12); }
```

- [ ] **Step 3: main.js — panel logic.** Replace the Task 3 stub `function showVideoReady() {}` with:

```js
let videoBusy = false, videoCancel = false;

function showVideoReady() {
  if (!recorder || !recorder.hasMaster) return;
  const sel = document.getElementById('sel-video-quality');
  sel.innerHTML = '';
  for (const p of recorder.availableQualities()) {
    sel.appendChild(Object.assign(document.createElement('option'), { value: p.id, textContent: p.label }));
  }
  document.getElementById('video-ready').classList.remove('hidden');
}

function hideVideoReady() {
  document.getElementById('video-ready').classList.add('hidden');
}
```

In `bindAudio()` (after the `btnRecord` handler) add:

```js
  document.getElementById('btn-video-export').addEventListener('click', async () => {
    if (!recorder || !recorder.hasMaster) return;
    if (videoBusy) { videoCancel = true; setStatus('Cancelling…'); return; }
    videoBusy = true; videoCancel = false;
    const preset = document.getElementById('sel-video-quality').value;
    try {
      const ok = await recorder.exportAt(preset, {
        onProgress: (p) => setStatus(`Video export ${Math.round(p * 100)}% — Export again to cancel`),
        shouldCancel: () => videoCancel,
      });
      setStatus(ok ? 'Video saved' : 'Video export cancelled');
    } catch (e) {
      setStatus(`Video export error: ${e.message}`);
    } finally { videoBusy = false; }
  });

  document.getElementById('btn-video-discard').addEventListener('click', () => {
    if (recorder) recorder.discard();
    hideVideoReady();
    if (appState === 'live') setStatus('Live — listening');
  });
```

Lifecycle: in the clear handler, next to the Task 3 `recorder.discard()` line, add `hideVideoReady();`. (Freeze keeps the master and the panel — no change needed: `stopLive` only stops an *active* recording.)

- [ ] **Step 4: Cache bump.**

Run:
```bash
cd ~/Documents/Github/soundform && grep -rl 'v=34' index.html js/ | xargs sed -i '' 's/v=34/v=35/g' && grep -rn 'v=34' index.html js/ | wc -l
```
Expected: final count `0`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: PASS.

```bash
git add index.html style.css js/
git commit -m "feat(video): video-ready panel with quality exports; bump cache to v=35"
```

---

## Manual browser acceptance (after all tasks)

Serve locally (`python3 -m http.server` in the repo root) or deploy, then:

1. Enter Live → record button appears; tap → pulses red, timer counts in the status bar.
2. Make sound for ~20s, tap record again → "Video ready" panel; live keeps morphing.
3. Export **Original** → mp4 downloads near-instantly and plays (QuickTime + Chrome).
4. Export **720p** → progress %, downloads, plays, visibly smaller file.
5. Export again (any preset) — same take exports repeatedly.
6. Discard → panel gone. Record again → new take replaces old.
7. Freeze (✓) during a master-held state → captured design normal, panel still there.
8. Clear → panel gone, master dropped.
9. DevTools Network: no `v=34` requests.
