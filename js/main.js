import { AudioEngine }  from './audio.js?v=15';
import { SoundRenderer } from './renderer.js?v=15';
import { exportCanvas }  from './exporter.js?v=15';

const audio = new AudioEngine();
let renderer = null;

// States: 'blank' | 'recording' | 'recorded' | 'captured'
let appState         = 'blank';
let capturedAnalysis = null;
let accumState       = null;   // running weighted sum of FFT frames while recording
let trajectoryFrames = [];     // individual feature snapshots for Timbre mode
let frameCounter     = 0;      // sub-sampling counter

const params = {
  mode:           'chladni',
  complexity:     48,
  layers:         12,
  twist:          0.5,
  density:        80000,
  pointSize:      2.0,
  scale:          1.0,
  helixTurns:     2.0,
  rotSpeed:       0.3,
  reactivity:     0.7,
  smoothing:      0.5,
  autoColor:      true,
  colorPrimary:   '#00d4ff',
  colorSecondary: '#b44dff',
  colorAccent:    '#ff6644',
  brightness:     0.9,
  glow:           0.4,
};

let vuFill, vuWrap, statusEl, clearBtn, submitBtn;

window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => {
    renderer  = new SoundRenderer(document.getElementById('renderer-container'));
    vuFill    = document.getElementById('vu-fill');
    vuWrap    = document.getElementById('vu-wrap');
    statusEl  = document.getElementById('status-bar');
    clearBtn  = document.getElementById('btn-clear');
    submitBtn = document.getElementById('btn-submit');

    renderer.clear();
    bindControls();
    bindAudio();
    bindExport();
    loop();
  });
});

// ── Loop ──────────────────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  renderer.tick(params);

  if (audio.active && appState === 'recording') {
    const a = audio.getAnalysis();
    if (vuFill) vuFill.style.height = Math.min(100, a.volume * 300) + '%';
    accumulateFrame(a);
  }
}

// ── Accumulator ───────────────────────────────────────────────────
// FFT sums are weighted by volume and NOT divided back out.
// After recording, we max-normalise per-bin so the dominant frequency = 1.0
// and every other bin reflects how much energy it received relative to that.
// More words → more bins activated → richer, denser geometry in all modes.
function startAccum() {
  accumState = {
    fftSum:      new Float32Array(128),
    totalWeight: 0,
    sumBass: 0, sumSubBass: 0, sumLowMid: 0, sumHighMid: 0, sumHigh: 0, sumSpread: 0,
    frames: 0,
  };
  trajectoryFrames = [];
  frameCounter = 0;
}

function accumulateFrame(a) {
  if (!accumState) return;
  // Skip essentially silent frames — they add noise without information
  if (a.volume < 0.005) { frameCounter++; return; }

  const s = accumState;
  const w = a.volume;
  for (let i = 0; i < 128; i++) s.fftSum[i] += a.fftSnapshot[i] * w;
  s.totalWeight += w;
  s.sumBass     += a.bass    * w;
  s.sumSubBass  += a.subBass * w;
  s.sumLowMid   += a.lowMid  * w;
  s.sumHighMid  += a.highMid * w;
  s.sumHigh     += a.high          * w;
  s.sumSpread   += (a.spectralSpread || 0) * w;
  s.frames++;

  // Timbre mode: sample one frame every ~50ms (every 3rd frame at 60fps)
  frameCounter++;
  if (frameCounter % 3 === 0) {
    trajectoryFrames.push({
      spectralCentroid: a.spectralCentroid,
      spectralSpread:   a.spectralSpread,
      volume:           a.volume,
      dominantFreq:     a.dominantFreq,
      bass:             a.bass,
      high:             a.high,
    });
  }
}

function getAccumulatedAnalysis() {
  if (!accumState || accumState.frames === 0) return null;
  const s = accumState;
  const W = s.totalWeight || 1;

  // Volume-weighted average per bin, boosted by sqrt(active frames).
  // fftSum[i]/W = average FFT value for this bin when sound was present.
  // Multiplied by sqrt(frames/8) so more speech unlocks subtler frequencies:
  //   ~1 word  (10 frames) → ×1.1 boost
  //   ~4 words (50 frames) → ×2.5 boost  → quieter bins cross the visibility threshold
  //   full sentence (120f)  → ×3.9 boost  → rich, distinct design for every sentence
  const complexityBoost = Math.min(5, Math.sqrt(Math.max(1, s.frames) / 8));
  const fftResult = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    fftResult[i] = Math.min(1, (s.fftSum[i] / W) * complexityBoost);
  }

  // Dominant frequency: spectral centroid of the top-energy bins
  // (more stable than single peak — won't always lock onto the first word's vowel)
  let peakBin = 1;
  for (let i = 2; i < 100; i++) if (s.fftSum[i] > s.fftSum[peakBin]) peakBin = i;
  let wSum = 0, total = 0;
  for (let i = 0; i < 128; i++) { wSum += i * fftResult[i]; total += fftResult[i]; }

  return {
    fftSnapshot:      fftResult,
    volume:           s.totalWeight / s.frames,
    dominantFreq:     peakBin / 127,
    spectralCentroid: total > 0 ? wSum / (total * 127) : 0.3,
    bass:             s.sumBass    / W,
    subBass:          s.sumSubBass / W,
    lowMid:           s.sumLowMid  / W,
    highMid:          s.sumHighMid / W,
    high:             s.sumHigh    / W,
    spectralSpread:   s.sumSpread  / W,
    frames:           [...trajectoryFrames],  // for Timbre mode
  };
}

// ── Audio ─────────────────────────────────────────────────────────
function bindAudio() {
  const btnMic    = document.getElementById('btn-mic');
  const lblFile   = document.getElementById('lbl-file');
  const fileInput = document.getElementById('file-input');
  const btnStop   = document.getElementById('btn-stop');

  btnMic.addEventListener('click', async () => {
    // From 'recorded' state, 🎤 means re-record
    if (appState === 'recorded') audio.stop();
    try {
      setStatus('Requesting microphone…');
      await audio.startMic();
      enterRecording(btnStop);
    } catch (e) {
      setStatus(`Microphone error: ${e.message}`);
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      await audio.loadFile(file);
      enterRecording(btnStop);
      setStatus(`Recording from "${file.name}" — press ⏹ when done`);
    } catch (e) {
      setStatus(`File error: ${e.message}`);
    }
    fileInput.value = '';
  });

  btnStop.addEventListener('click', () => {
    if (appState !== 'recording') return;
    audio.stop();
    appState = 'recorded';
    btnMic.classList.remove('hidden');
    lblFile.classList.add('hidden');
    btnStop.classList.add('hidden');
    if (submitBtn) submitBtn.classList.remove('hidden');
    if (vuWrap) vuWrap.classList.add('hidden');
    setStatus('Done — press ✓ to create design, or 🎤 to re-record');
  });

  if (submitBtn) submitBtn.addEventListener('click', submitDesign);
  if (clearBtn)  clearBtn.addEventListener('click', clearCanvas);
}

function enterRecording(btnStop) {
  appState = 'recording';
  startAccum();
  document.getElementById('btn-mic').classList.add('hidden');
  document.getElementById('lbl-file').classList.add('hidden');
  btnStop.classList.remove('hidden');
  if (submitBtn) submitBtn.classList.add('hidden');
  if (clearBtn)  clearBtn.classList.add('hidden');
  if (vuWrap)    vuWrap.classList.remove('hidden');
  setStatus('Recording… press ⏹ when done');
}

function submitDesign() {
  const a = getAccumulatedAnalysis();
  if (!a) { setStatus('No audio captured — try recording again'); return; }
  capturedAnalysis = a;
  appState = 'captured';
  renderer.captureDesign(capturedAnalysis, params);
  if (submitBtn) submitBtn.classList.add('hidden');
  document.getElementById('btn-mic').classList.add('hidden');
  document.getElementById('lbl-file').classList.add('hidden');
  if (clearBtn) clearBtn.classList.remove('hidden');
  setStatus('Design created — drag to rotate · adjust sliders · 🗑️ to reset');
}

function clearCanvas() {
  capturedAnalysis = null;
  accumState = null;
  trajectoryFrames = [];
  frameCounter = 0;
  appState = 'blank';
  audio.stop();
  renderer.clear();
  document.getElementById('btn-mic').classList.remove('hidden');
  document.getElementById('lbl-file').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  if (submitBtn) submitBtn.classList.add('hidden');
  if (clearBtn)  clearBtn.classList.add('hidden');
  if (vuWrap)    vuWrap.classList.add('hidden');
  setStatus('Ready — press 🎤 to record or 📁 to upload');
}

// ── Controls ──────────────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      params.mode = btn.dataset.mode;
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.chladni-only').forEach(el => {
        el.style.display = params.mode === 'chladni' ? '' : 'none';
      });
      document.querySelectorAll('.radial-only').forEach(el => {
        el.style.display = params.mode === 'radial' ? '' : 'none';
      });
      document.querySelectorAll('.spectral-only').forEach(el => {
        el.style.display = params.mode === 'spectral' ? '' : 'none';
      });
      document.querySelectorAll('.timbre-only').forEach(el => {
        el.style.display = params.mode === 'timbre' ? '' : 'none';
      });
      document.querySelectorAll('.points-mode').forEach(el => {
        const pm = params.mode;
        el.style.display = (pm === 'chladni' || pm === 'spectral' || pm === 'timbre' || pm === 'attractor') ? '' : 'none';
      });
      rerenderIfCaptured();
    });
  });

  const chkAuto = document.getElementById('chk-auto-color');
  const manualColors = document.getElementById('manual-colors');
  chkAuto.addEventListener('change', () => {
    params.autoColor = chkAuto.checked;
    manualColors.classList.toggle('faded', params.autoColor);
    rerenderIfCaptured();
  });

  ['primary', 'secondary', 'accent'].forEach(key => {
    document.getElementById(`col-${key}`).addEventListener('input', e => {
      params[`color${key[0].toUpperCase() + key.slice(1)}`] = e.target.value;
      rerenderIfCaptured();
    });
  });

  const sliders = [
    ['sl-complexity',  'complexity',  parseInt,   true],
    ['sl-layers',      'layers',      parseInt,   true],
    ['sl-twist',       'twist',       parseFloat, true],
    ['sl-density',     'density',     parseInt,   true],
    ['sl-point-size',  'pointSize',   parseFloat, true],
    ['sl-scale',       'scale',       parseFloat, true],
    ['sl-helix',       'helixTurns',  parseFloat, true],
    ['sl-rot-speed',   'rotSpeed',    parseFloat, false],
    ['sl-reactivity',  'reactivity',  parseFloat, true],
    ['sl-smoothing',   'smoothing',   parseFloat, false],
    ['sl-brightness',  'brightness',  parseFloat, true],
    ['sl-glow',        'glow',        parseFloat, true],
  ];

  sliders.forEach(([id, key, parse, rerender]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const valEl = document.getElementById(id.replace('sl-', 'val-'));
    el.addEventListener('input', () => {
      params[key] = parse(el.value);
      if (valEl) valEl.textContent = params[key];
      if (key === 'smoothing') audio.setSmoothing(params[key]);
      if (rerender) rerenderIfCaptured();
    });
  });
}

function rerenderIfCaptured() {
  if (appState === 'captured' && capturedAnalysis) {
    renderer.captureDesign(capturedAnalysis, params);
  }
}

// ── Export ────────────────────────────────────────────────────────
function bindExport() {
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await exportCanvas(renderer.getCanvas(), btn.dataset.fmt);
      } catch (e) {
        setStatus(`Export error: ${e.message}`);
      }
    });
  });
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}
