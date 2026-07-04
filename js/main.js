import { AudioEngine } from './audio.js?v=18';
import { buildFingerprint } from './features.js?v=18';
import { DensityRenderer } from './density.js?v=18';
import { PALETTES, buildLUT, customRamp, hexToRgb } from './palettes.js?v=18';
import { exportCanvas, exportStrandSVG } from './exporter.js?v=18';

const audio = new AudioEngine();
let renderer = null;
let worker = null;

let appState = 'blank'; // 'blank' | 'recording' | 'recorded' | 'captured'
let frames = [];
let recordStart = 0;
let fingerprint = null;
let design = null; // { positions, attr, strands }

const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);

const params = {
  mode: 'attractor',
  complexity: 0.5, symmetry: 1, twist: 0, scale: 1.0,
  density: isMobile ? 500000 : 1500000,
  grain: 1.0, strandCount: 48, strokeWeight: 1.0,
  palette: 'nebula',
  colorPrimary: '#b8a7e0', colorSecondary: '#e8b4c8', colorAccent: '#fff2e0',
  background: '#03040a',
  exposure: 30, contrast: 1.0, autoRotate: 0.3,
};

let statusEl, vuFill, vuWrap, clearBtn, submitBtn;

window.addEventListener('DOMContentLoaded', () => {
  renderer = new DensityRenderer(document.getElementById('renderer-container'));
  statusEl = document.getElementById('status-bar');
  vuFill = document.getElementById('vu-fill');
  vuWrap = document.getElementById('vu-wrap');
  clearBtn = document.getElementById('btn-clear');
  submitBtn = document.getElementById('btn-submit');
  applyColorParams();
  // Centre the design in the region not covered by the floating control panel
  // (desktop: 300px panel + 2×16px insets = 332px). Mobile uses the full screen.
  const mobileMQ = window.matchMedia('(max-width: 760px)');
  const applyViewInset = () => renderer.setViewInset(mobileMQ.matches ? 0 : 332, 0);
  mobileMQ.addEventListener('change', applyViewInset);
  applyViewInset();
  bindAudio();
  bindControls();
  bindExport();
  if (renderer.fallback) setStatus('Note: reduced quality mode (float buffers unsupported)');
  captureLoop();
  window.__soundform = { params, getState: () => ({ appState, fingerprint, design }) };
});

function captureLoop() {
  requestAnimationFrame(captureLoop);
  if (audio.active && appState === 'recording') {
    const f = audio.getMusicalFrame();
    if (f) {
      if (vuFill) vuFill.style.height = Math.min(100, f.rms * 300) + '%';
      if (f.rms > 0.005) frames.push(f);
    }
  }
}

// ── Generation ────────────────────────────────────────────────────
function regenerate() {
  if (!fingerprint) return;
  setStatus('Generating…');
  const payload = { fingerprint: { ...fingerprint, chroma: fingerprint.chroma, contour: fingerprint.contour },
                    params: { mode: params.mode, density: params.density, complexity: params.complexity,
                              symmetry: params.symmetry, twist: params.twist, strandCount: 96 } };
  const onResult = (out) => {
    design = out;
    renderer.setCloud(out.positions, out.attr);
    applyRenderParams();
    setStatus('Design created — drag to rotate · adjust sliders · 🗑️ to reset');
  };
  try {
    if (!worker) worker = new Worker('js/worker.js?v=18', { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) setStatus(`Generating… ${Math.round(e.data.progress * 100)}%`);
      else if (e.data.error) setStatus(`Generation error: ${e.data.error}`);
      else if (e.data.done) onResult(e.data);
    };
    worker.onerror = () => { worker = null; fallbackGenerate(onResult); };
    worker.postMessage(payload);
  } catch {
    fallbackGenerate(onResult);
  }
}

async function fallbackGenerate(onResult) {
  const { generate } = await import('./generators/index.js?v=18');
  onResult(generate(fingerprint, { ...params, strandCount: 96 }));
}

// ── Params → renderer ─────────────────────────────────────────────
function activeStops() {
  return params.palette === 'custom'
    ? customRamp(params.background, params.colorPrimary, params.colorSecondary, params.colorAccent)
    : PALETTES[params.palette].stops;
}

function applyColorParams() {
  renderer.setPalette(buildLUT(activeStops()));
  applyRenderParams();
}

function applyRenderParams() {
  renderer.setParams({
    exposure: params.exposure, contrast: params.contrast, grain: params.grain,
    background: hexToRgb(params.background), scale: params.scale, autoRotate: params.autoRotate,
  });
}

// ── Audio flow (same UX as before) ────────────────────────────────
function bindAudio() {
  const btnMic = document.getElementById('btn-mic');
  const lblFile = document.getElementById('lbl-file');
  const fileInput = document.getElementById('file-input');
  const btnStop = document.getElementById('btn-stop');

  btnMic.addEventListener('click', async () => {
    if (appState === 'recorded') audio.stop();
    try {
      setStatus('Requesting microphone…');
      await audio.startMic();
      enterRecording(btnStop);
    } catch (e) { setStatus(`Microphone error: ${e.message}`); }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      await audio.loadFile(file);
      enterRecording(btnStop);
      setStatus(`Recording from "${file.name}" — press ⏹ when done`);
    } catch (e) { setStatus(`File error: ${e.message}`); }
    fileInput.value = '';
  });

  btnStop.addEventListener('click', () => {
    if (appState !== 'recording') return;
    audio.stop();
    appState = 'recorded';
    btnMic.classList.remove('hidden');
    lblFile.classList.add('hidden');
    btnStop.classList.add('hidden');
    submitBtn.classList.remove('hidden');
    vuWrap.classList.add('hidden');
    setStatus('Done — press ✓ to create design, or 🎤 to re-record');
  });

  submitBtn.addEventListener('click', () => {
    if (frames.length === 0) { setStatus('No audio captured — try recording again'); return; }
    fingerprint = buildFingerprint(frames, (performance.now() - recordStart) / 1000);
    fingerprint.trajectory = new Float32Array(frames.length * 3);
    frames.forEach((f, i) => {
      fingerprint.trajectory[i * 3] = f.centroid;
      fingerprint.trajectory[i * 3 + 1] = f.rms;
      fingerprint.trajectory[i * 3 + 2] = f.spread;
    });
    appState = 'captured';
    submitBtn.classList.add('hidden');
    document.getElementById('btn-mic').classList.add('hidden');
    document.getElementById('lbl-file').classList.add('hidden');
    clearBtn.classList.remove('hidden');
    regenerate();
  });

  clearBtn.addEventListener('click', () => {
    fingerprint = null; design = null; frames = [];
    appState = 'blank';
    audio.stop();
    renderer.clear();
    document.getElementById('btn-mic').classList.remove('hidden');
    document.getElementById('lbl-file').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    submitBtn.classList.add('hidden');
    clearBtn.classList.add('hidden');
    vuWrap.classList.add('hidden');
    setStatus('Ready — press 🎤 to record or 📁 to upload');
  });
}

function enterRecording(btnStop) {
  appState = 'recording';
  frames = [];
  recordStart = performance.now();
  document.getElementById('btn-mic').classList.add('hidden');
  document.getElementById('lbl-file').classList.add('hidden');
  btnStop.classList.remove('hidden');
  submitBtn.classList.add('hidden');
  clearBtn.classList.add('hidden');
  vuWrap.classList.remove('hidden');
  setStatus('Recording… press ⏹ when done');
}

// ── Controls ──────────────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      params.mode = btn.dataset.mode;
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.toggle('active', b === btn));
      if (appState === 'captured') regenerate();
    });
  });

  // [id, param key, parse, needsRegen]
  const sliders = [
    ['sl-complexity', 'complexity', parseFloat, true],
    ['sl-symmetry', 'symmetry', parseInt, true],
    ['sl-twist', 'twist', parseFloat, true],
    ['sl-scale', 'scale', parseFloat, false],
    ['sl-density', 'density', parseInt, true],
    ['sl-grain', 'grain', parseFloat, false],
    ['sl-strands', 'strandCount', parseInt, false],
    ['sl-weight', 'strokeWeight', parseFloat, false],
    ['sl-exposure', 'exposure', parseFloat, false],
    ['sl-contrast', 'contrast', parseFloat, false],
    ['sl-rot-speed', 'autoRotate', parseFloat, false],
  ];
  sliders.forEach(([id, key, parse, regen]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id.replace('sl-', 'val-'));
    el.addEventListener('input', () => {
      params[key] = parse(el.value);
      if (valEl) valEl.textContent = el.value;
      if (!regen) applyRenderParams();
    });
    // regen sliders rebuild geometry only on release (change), not on drag
    if (regen) el.addEventListener('change', () => { if (appState === 'captured') regenerate(); });
  });

  document.getElementById('sel-palette').addEventListener('change', (e) => {
    params.palette = e.target.value;
    document.getElementById('manual-colors').classList.toggle('faded', params.palette !== 'custom');
    applyColorParams();
  });
  [['col-primary', 'colorPrimary'], ['col-secondary', 'colorSecondary'],
   ['col-accent', 'colorAccent'], ['col-background', 'background']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', (e) => {
      params[key] = e.target.value;
      applyColorParams();
    });
  });
}

// ── Export ────────────────────────────────────────────────────────
function bindExport() {
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const fmt = btn.dataset.fmt;
        if (fmt === 'svg') {
          if (!design) { setStatus('Create a design first'); return; }
          const all = design.strands;
          const want = Math.min(params.strandCount * Math.max(1, Math.round(all.length / 96)), all.length);
          const step = all.length / want;
          const picked = [];
          for (let i = 0; i < want; i++) picked.push(all[Math.floor(i * step)]);
          const svg = exportStrandSVG({
            strands: picked,
            positions: design.positions,
            mvp: renderer.getMVP().elements,
            width: 1600, height: 1200,
            stops: activeStops(), background: params.background,
            weight: params.strokeWeight,
          });
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform.svg' });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else {
          const canvas = renderer.renderHiRes(fmt === 'pdf' ? 2 : 3);
          await exportCanvas(canvas, fmt);
        }
      } catch (e) { setStatus(`Export error: ${e.message}`); }
    });
  });
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
