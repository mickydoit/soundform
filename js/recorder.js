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
