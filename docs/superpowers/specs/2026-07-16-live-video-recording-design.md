# Live video recording — design

**Date:** 2026-07-16 · **Cache:** bump to `?v=35`

## What

Record the Live session's visuals (silent — no mic audio, user decision) as a
video **master**, then export that one take repeatedly at different qualities
(user decision: record once, export many). Live mode only (user decision);
captured designs keep the existing seamless-loop MP4 export.

## UX

- While Live runs, a **record button (◉)** joins the audio-controls row
  (hidden unless `'VideoEncoder' in window`, same guard as MP4 export).
- Tap → button pulses red; status bar shows `Recording — m:ss`.
- Tap again, or hit the **5-minute cap**, → recording stops; **live keeps
  running**; a **"Video ready" panel** appears with a quality select,
  **Export**, and **Discard**.
- Export any number of times at different qualities from the same master.
- Master lifetime: kept until Discard, a new recording starts, or Clear.
  Freeze keeps the master (the take may be wanted); Clear drops it.
- Export shows progress in the status bar and is cancellable (existing MP4
  export pattern). Original-quality export is near-instant.

## Architecture

### 1. `js/recorder.js` — `LiveRecorder` (new module)

- `start(canvas)` — records source dimensions (rounded down to even, H.264
  requirement), configures a `VideoEncoder` (H.264 `avc1.640028` with
  `avc1.42001f` fallback — same ladder as `exportMP4`), canvas resolution,
  12 Mbps, 30 fps.
- `captureTick(nowMs)` — called from the renderer's post-render hook every
  drawn frame; a **30 fps timestamp gate** (pure helper) decides which frames
  to keep. Kept frames: `new VideoFrame(canvas, { timestamp })` → encoder.
  Timestamps are monotonic from the gate, so a hidden tab simply skips time.
- Encoded output: each `EncodedVideoChunk` is copied to bytes (`copyTo`) and
  stored with `{ type, timestamp, duration }`; the first `decoderConfig`
  metadata is stored once. This chunk store **is the master**
  (~2.5 MB/s ⇒ ≤ ~750 MB at the 5-min cap).
- `stop()` — flushes the encoder, closes it, keeps the store.
- `exportAt(preset, onProgress, shouldCancel)`:
  - `original` → mux stored chunks directly via vendored mp4-muxer
    `addVideoChunkRaw` (no re-encode).
  - scaled presets → stored bytes → `EncodedVideoChunk` → `VideoDecoder` →
    each `VideoFrame` drawn scaled onto a stage canvas → new `VideoEncoder`
    at the preset's bitrate → mux. Decoder/encoder queue back-pressure like
    `exportMP4` (`encodeQueueSize > 4` → wait).
  - Download via the exporter's existing object-URL pattern
    (`soundform-live.mp4`).
- `discard()` — frees the store.
- Pure, node-tested helpers: `fitPreset(srcW, srcH, preset)` (aspect-preserving
  fit, even dims, never upscale) and the 30 fps gate.

### 2. Quality presets

| Preset | Target | Bitrate |
|---|---|---|
| `original` | recorded size | stored bits, no re-encode |
| `1080-high` | fit within 1080 px height | 12 Mbps |
| `1080-med` | fit within 1080 px height | 6 Mbps |
| `720` | fit within 720 px height | 4 Mbps |

Presets whose target height ≥ recorded height are hidden except `original`
(no upscaling).

### 3. `js/density.js` — post-render frame sink

`setFrameSink(cb)` / `cb(nowMs)` invoked immediately after the `_loop` render
call. Needed because the WebGL context has no `preserveDrawingBuffer`; the
canvas must be wrapped in a `VideoFrame` in the same task as the draw. Null
sink = zero overhead.

### 4. `js/main.js`, `index.html`, `style.css` — wiring

- `#btn-record` in the audio-controls row (shown on entering live, hidden on
  leaving); pulsing red `.recording` state; timer via the existing status bar.
- `#video-ready` panel (quality `<select>` + Export + Discard), pastel accent
  consistent with existing chrome.
- Lifecycle: `enterLive` shows the button; `stopLive` stops any active
  recording; Freeze keeps the master; Clear discards it. Export allowed while
  live continues (re-encode is CPU-heavy but off the render path's critical
  budget; acceptable).

## Error handling

- Encoder `error` callback mid-recording → abort recording, discard partial
  master, status message (existing pattern).
- `exportAt` failure → status message; master retained so the user can retry
  another preset.
- Unsupported browser → record button never rendered.

## Testing

Node tests (`test/recorder.test.js`): `fitPreset` aspect/even-dims/no-upscale;
30 fps gate (accepts ~30 of 60 rAF ticks, monotonic timestamps, gap skip);
chunk-store bookkeeping (bytes + metadata round-trip, discard frees);
preset filtering by source size.

Browser acceptance: record a live take; export Original and 720p and verify
both play in QuickTime/Chrome; hit the 5-min cap; Discard; re-record;
Freeze keeps master; Clear drops it.

## Decisions log

| Question | Decision |
|---|---|
| Audio | Visuals only, silent |
| Quality flow | Record once, export many (review panel) |
| Scope | Live mode only |
| Approach | A: WebCodecs master (in-memory chunk store) + direct-mux / decode-rescale-re-encode exports |
| True 4K+ | Out of scope (needs feature-stream replay; master is canvas-resolution) |
