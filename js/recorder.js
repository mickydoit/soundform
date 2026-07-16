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
