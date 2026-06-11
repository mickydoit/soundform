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

    // 44100 Hz, fftSize=1024 → 512 bins, each ≈ 43 Hz wide
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i]; return s / ((b - a) * 255); };

    const subBass = avg(0,   3);
    const bass    = avg(3,   12);
    const lowMid  = avg(12,  47);
    const highMid = avg(47,  140);
    const high    = avg(140, 300);
    const volume  = avg(0,   200);

    let maxIdx = 1, maxVal = 0;
    for (let i = 1; i < 300; i++) if (d[i] > maxVal) { maxVal = d[i]; maxIdx = i; }

    let wSum = 0, total = 0;
    for (let i = 0; i < 300; i++) { wSum += i * d[i]; total += d[i]; }
    const centroidBin = total > 0 ? wSum / total : 90;

    // Spectral spread: std dev of the frequency distribution (0 = pure tone, 1 = white noise)
    let spreadSq = 0;
    for (let i = 0; i < 300; i++) spreadSq += (i - centroidBin) ** 2 * d[i];
    const spectralSpread = total > 0 ? Math.min(1, Math.sqrt(spreadSq / total) / 120) : 0.2;

    // Full 128-bin snapshot for the radial visualizer
    const fftSnapshot = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      // Average 4 bins per snapshot bin
      fftSnapshot[i] = (d[i*4] + d[i*4+1] + d[i*4+2] + d[i*4+3]) / (4 * 255);
    }

    return {
      subBass, bass, lowMid, highMid, high, volume,
      dominantFreq:     maxIdx / 300,
      spectralCentroid: centroidBin / 300,
      spectralSpread,
      fftSnapshot,
    };
  }

  async _init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    this.ctx                            = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser                       = this.ctx.createAnalyser();
    this.analyser.fftSize               = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.fftData                        = new Uint8Array(this.analyser.frequencyBinCount);
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
