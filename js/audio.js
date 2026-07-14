import { detectPitch, chromaFromFFT, spectralFlux } from './features.js?v=31';

export class AudioEngine {
  constructor() {
    this.ctx      = null;
    this.analyser = null;
    this.source   = null;
    this.stream   = null;
    this.fftData  = null;
    this.active   = false;
    this.mode     = null;
  }

  async startMic() {
    await this._init();
    this._stopSource();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.active = true;
    this.mode   = 'mic';
  }

  async loadFile(file) {
    await this._init();
    this._stopSource();
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    const buf     = await file.arrayBuffer();
    const decoded = await this.ctx.decodeAudioData(buf);
    this.source        = this.ctx.createBufferSource();
    this.source.buffer = decoded;
    this.source.loop   = true;
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.source.start(0);
    this.active = true;
    this.mode   = 'file';
    return decoded.duration;
  }

  stop() {
    this._stopSource();
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.active = false;
    this.mode   = null;
  }

  setSmoothing(v) {
    if (this.analyser) this.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, v));
  }

  getAnalysis() {
    if (!this.analyser || !this.active) return SILENCE;
    this.analyser.getByteFrequencyData(this.fftData);
    const d = this.fftData;

    // 44100 Hz, fftSize=2048 → 1024 bins, each ≈ 21.5 Hz wide
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i]; return s / ((b - a) * 255); };

    const subBass = avg(0,   6);
    const bass    = avg(6,   24);
    const lowMid  = avg(24,  94);
    const highMid = avg(94,  280);
    const high    = avg(280, 600);
    const volume  = avg(0,   400);

    let maxIdx = 1, maxVal = 0;
    for (let i = 1; i < 600; i++) if (d[i] > maxVal) { maxVal = d[i]; maxIdx = i; }

    let wSum = 0, total = 0;
    for (let i = 0; i < 600; i++) { wSum += i * d[i]; total += d[i]; }
    const centroidBin = total > 0 ? wSum / total : 180;

    // Spectral spread: std dev of the frequency distribution (0 = pure tone, 1 = white noise)
    let spreadSq = 0;
    for (let i = 0; i < 600; i++) spreadSq += (i - centroidBin) ** 2 * d[i];
    const spectralSpread = total > 0 ? Math.min(1, Math.sqrt(spreadSq / total) / 240) : 0.2;

    // Full 128-bin snapshot for the radial visualizer
    const fftSnapshot = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      // Average 8 bins per snapshot bin
      fftSnapshot[i] = (d[i*8] + d[i*8+1] + d[i*8+2] + d[i*8+3] + d[i*8+4] + d[i*8+5] + d[i*8+6] + d[i*8+7]) / (8 * 255);
    }

    return {
      subBass, bass, lowMid, highMid, high, volume,
      dominantFreq:     maxIdx / 600,
      spectralCentroid: centroidBin / 600,
      spectralSpread,
      fftSnapshot,
    };
  }

  // One musical-feature frame. Pitch runs every 2nd call (it's the heavy one).
  getMusicalFrame() {
    if (!this.analyser || !this.active) return null;
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getFloatFrequencyData(this.magData);

    // dB → linear magnitude
    const mag = new Float32Array(this.magData.length);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.pow(10, this.magData[i] / 20);

    let rms = 0;
    for (let i = 0; i < this.timeData.length; i++) rms += this.timeData[i] ** 2;
    rms = Math.sqrt(rms / this.timeData.length);

    if (this._frameNo++ % 2 === 0) {
      this._lastPitch = detectPitch(this.timeData, this.ctx.sampleRate);
    }
    const chroma = chromaFromFFT(mag, this.ctx.sampleRate, this.analyser.fftSize);
    const flux = spectralFlux(mag, this._prevMag);
    this._prevMag.set(mag);

    let wSum = 0, total = 0, spreadSq = 0;
    for (let i = 0; i < 600 && i < mag.length; i++) { wSum += i * mag[i]; total += mag[i]; }
    const cBin = total > 0 ? wSum / total : 180;
    for (let i = 0; i < 600 && i < mag.length; i++) spreadSq += (i - cBin) ** 2 * mag[i];

    return {
      pitchHz: this._lastPitch.freq,
      pitchConf: this._lastPitch.confidence,
      chroma, flux, rms,
      centroid: Math.min(1, cBin / 600),
      spread: total > 0 ? Math.min(1, Math.sqrt(spreadSq / total) / 240) : 0.2,
    };
  }

  async _init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    this.ctx                            = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser                       = this.ctx.createAnalyser();
    this.analyser.fftSize               = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.fftData                        = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData                       = new Float32Array(2048);
    this.magData                        = new Float32Array(this.analyser.frequencyBinCount);
    this._prevMag                       = new Float32Array(this.analyser.frequencyBinCount);
    this._frameNo                       = 0;
    this._lastPitch                     = { freq: 0, confidence: 0 };
  }

  _stopSource() {
    if (!this.source) return;
    try { this.source.stop?.(); }     catch {}
    try { this.source.disconnect(); } catch {}
    this.source = null;
  }
}

const SILENCE = {
  subBass: 0, bass: 0, lowMid: 0, highMid: 0, high: 0, volume: 0,
  dominantFreq: 0.1, spectralCentroid: 0.3, spectralSpread: 0.2,
  fftSnapshot: new Float32Array(128),
};
