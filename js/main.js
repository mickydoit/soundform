import { AudioEngine } from './audio.js?v=36';
import { buildFingerprint, buildTrajectory } from './features.js?v=36';
import { DensityRenderer } from './density.js?v=36';
import { PALETTES, buildLUT, customRamp, hexToRgb } from './palettes.js?v=36';
import { exportCanvas, exportStrandSVG, framePlan, exportMP4, loopsForDuration } from './exporter.js?v=36';
import { motionParams, displacePoint } from './motion.js?v=36';
import { LiveConductor } from './live.js?v=36';
import { LiveRecorder, MAX_RECORD_SEC } from './recorder.js?v=36';

const audio = new AudioEngine();
let renderer = null;
let worker = null;

let appState = 'blank'; // 'blank' | 'recording' | 'recorded' | 'captured' | 'live'
let frames = [];
let recordStart = 0;
let fingerprint = null;
let design = null; // { positions, attr, strands }
let mp4Busy = false, mp4Cancel = false;

const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);

let conductor = null;
let liveWorker = null;
let recorder = null;
let lastTimerSec = -1;
const LIVE_DENSITY = isMobile ? 120000 : 250000;

const params = {
  mode: 'attractor',
  complexity: 0.5, symmetry: 1, twist: 0, scale: 1.0,
  density: isMobile ? 500000 : 1500000,
  grain: 1.0, strandCount: 48, strokeWeight: 1.0,
  palette: 'nebula',
  colorPrimary: '#b8a7e0', colorSecondary: '#e8b4c8', colorAccent: '#fff2e0',
  background: '#03040a',
  exposure: 30, contrast: 1.0, autoRotate: 0.3,
  motionOn: false, motionPeriod: 8,
  exportRes: 'std', videoDur: 0, transparentBg: false,
  flatView: true, cymStyle: 'auto',
};

let statusEl, vuFill, vuWrap, clearBtn, submitBtn;

window.addEventListener('DOMContentLoaded', () => {
  renderer = new DensityRenderer(document.getElementById('renderer-container'));
  renderer.setProjection(params.flatView ? 'flat' : 'depth');
  renderer.setOrientation(-Math.PI / 2, 0); // straight-on top-down: plate/mandala view
  statusEl = document.getElementById('status-bar');
  vuFill = document.getElementById('vu-fill');
  vuWrap = document.getElementById('vu-wrap');
  clearBtn = document.getElementById('btn-clear');
  submitBtn = document.getElementById('btn-submit');
  applyColorParams();
  // Centre the design in the region not covered by chrome:
  // desktop — 300px panel + 2×16px insets = 332px on the right;
  // mobile  — the bottom sheet's height while it is open, so the design
  //           shrinks and sits above the menu instead of hiding behind it.
  const mobileMQ = window.matchMedia('(max-width: 760px)');
  const sheetCheck = document.getElementById('sheet-open');
  const applyViewInset = () => {
    if (mobileMQ.matches) {
      const sheetPx = sheetCheck && sheetCheck.checked
        ? Math.min(window.innerHeight * 0.44, 400)
        : 0;
      renderer.setViewInset(0, sheetPx);
    } else {
      renderer.setViewInset(332, 0);
    }
  };
  mobileMQ.addEventListener('change', applyViewInset);
  if (sheetCheck) sheetCheck.addEventListener('change', applyViewInset);
  window.addEventListener('resize', applyViewInset);
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
                              symmetry: params.symmetry, twist: params.twist, strandCount: 96,
                              cymStyle: params.cymStyle } };
  const onResult = (out) => {
    design = out;
    renderer.setMotion(motionParams(fingerprint.seed));
    // Every Create presents a perfect plate: re-assert top-down so prior
    // drags or stale state can't leave a new design tilted.
    if (params.flatView) renderer.setOrientation(-Math.PI / 2, 0);
    renderer.setCloud(out.positions, out.attr);
    applyRenderParams();
    setStatus('Design created — drag to rotate · adjust sliders');
  };
  try {
    if (!worker) worker = new Worker('js/worker.js?v=36', { type: 'module' });
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
  const { generate } = await import('./generators/index.js?v=36');
  onResult(generate(fingerprint, { ...params, strandCount: 96 }));
}

// Promise wrapper around a dedicated live worker (regenerate() owns the other
// one and rebinds onmessage per call — sharing would clobber handlers).
function workerGenerate(fingerprint, params) {
  return new Promise((resolve) => {
    try {
      if (!liveWorker) liveWorker = new Worker('js/worker.js?v=36', { type: 'module' });
      liveWorker.onmessage = (e) => {
        if (e.data.done) resolve(e.data);
        else if (e.data.error) resolve(null);
      };
      liveWorker.onerror = () => { liveWorker = null; resolve(null); };
      liveWorker.postMessage({ fingerprint: { ...fingerprint, chroma: fingerprint.chroma, contour: fingerprint.contour }, params });
    } catch { resolve(null); }
  });
}

async function liveGenerate(fp, p) {
  const out = await workerGenerate(fp, p);
  if (out) return out;
  const { generate } = await import('./generators/index.js?v=36');
  return generate(fp, p);
}

function makeConductor() {
  return new LiveConductor({
    audio, renderer,
    generate: liveGenerate,
    applyStops: (stops) => renderer.setPalette(buildLUT(stops)),
    getParams: () => ({ mode: params.mode, complexity: params.complexity,
                        symmetry: params.symmetry, twist: params.twist,
                        cymStyle: params.cymStyle, liveDensity: LIVE_DENSITY,
                        exposure: params.exposure, scale: params.scale, grain: params.grain }),
    onVu: (rms) => { if (vuFill) vuFill.style.height = Math.min(100, rms * 300) + '%'; },
  });
}

// Palette + exposure are sound-driven while live; suspend their controls.
function setLiveSuspended(on) {
  for (const id of ['sel-palette', 'manual-colors', 'sl-exposure', 'col-background', 'btn-motion', 'sl-motion-period']) {
    document.getElementById(id).classList.toggle('live-suspended', on);
  }
}

function stopLive() {
  if (!conductor) return;
  if (recorder && recorder.recording) { recorder.stop(); finishRecordingUI(); showVideoReady(); }
  document.getElementById('btn-record').classList.add('hidden');
  conductor.stop();
  conductor = null;
  audio.stop();
  setLiveSuspended(false);
  renderer.setWave(0, 5);
  renderer.setLoopPeriod(params.motionPeriod);
  renderer.setPlaying(params.motionOn);
  if (liveWorker) { liveWorker.terminate(); liveWorker = null; }
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

  const btnLive = document.getElementById('btn-live');
  btnLive.addEventListener('click', async () => {
    try {
      setStatus('Requesting microphone…');
      await audio.startMic();
      enterLive();
    } catch (e) { setStatus(`Microphone error: ${e.message}`); }
  });

  const btnRecord = document.getElementById('btn-record');
  btnRecord.addEventListener('click', async () => {
    if (appState !== 'live') return;
    if (recorder && recorder.recording) { await stopRecording(); return; }
    recorder = recorder || new LiveRecorder();
    recorder.onLimit = () => { finishRecordingUI(); showVideoReady(); setStatus('Recording stopped — 5 minute limit'); };
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

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      await audio.loadFile(file);
      enterRecording(btnStop);
      setStatus(`Recording "${file.name}" — press stop when done`);
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
    document.getElementById('btn-live').classList.remove('hidden');
    setStatus('Done — tap the check to create, or the mic to re-record');
  });

  submitBtn.addEventListener('click', () => {
    if (appState === 'live') {
      const out = conductor ? conductor.freeze() : null;
      // freeze() returns null (before stopping itself) when there is too
      // little sound — the conductor is still running, so just report and stay live.
      if (!out) { setStatus('Not enough sound yet — keep going'); return; }
      stopLive();
      fingerprint = out.fingerprint;
      params.palette = 'custom';
      params.background     = out.stops[0][1];
      params.colorPrimary   = out.stops[1][1];
      params.colorSecondary = out.stops[2][1];
      params.colorAccent    = out.stops[3][1];
      document.getElementById('sel-palette').value = 'custom';
      document.getElementById('col-background').value = params.background;
      document.getElementById('col-primary').value = params.colorPrimary;
      document.getElementById('col-secondary').value = params.colorSecondary;
      document.getElementById('col-accent').value = params.colorAccent;
      document.getElementById('manual-colors').classList.remove('faded');
      appState = 'captured';
      submitBtn.classList.add('hidden');
      vuWrap.classList.add('hidden');
      applyColorParams();     // restores user exposure/scale/grain too (applyRenderParams)
      regenerate();
      return;
    }
    if (frames.length === 0) { setStatus('No audio captured — try recording again'); return; }
    fingerprint = buildFingerprint(frames, (performance.now() - recordStart) / 1000);
    fingerprint.trajectory = buildTrajectory(frames);
    fingerprint.trajectoryChannels = 4;
    appState = 'captured';
    submitBtn.classList.add('hidden');
    document.getElementById('btn-mic').classList.add('hidden');
    document.getElementById('lbl-file').classList.add('hidden');
    document.getElementById('btn-live').classList.add('hidden');
    clearBtn.classList.remove('hidden');
    regenerate();
  });

  clearBtn.addEventListener('click', () => {
    stopLive();
    if (recorder) recorder.discard();
    hideVideoReady();
    document.getElementById('btn-live').classList.remove('hidden');
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
    setStatus('Ready — record or upload a sound');
  });
}

function enterLive() {
  appState = 'live';
  frames = []; fingerprint = null; design = null;
  renderer.clear();
  ['btn-mic', 'lbl-file', 'btn-stop', 'btn-live'].forEach(id =>
    document.getElementById(id).classList.add('hidden'));
  submitBtn.classList.remove('hidden');
  clearBtn.classList.remove('hidden');
  vuWrap.classList.remove('hidden');
  if ('VideoEncoder' in window) document.getElementById('btn-record').classList.remove('hidden');
  setLiveSuspended(true);
  conductor = makeConductor();
  conductor.start();
  setStatus('Live — listening');
}

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
  showVideoReady();
}

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

function enterRecording(btnStop) {
  appState = 'recording';
  frames = [];
  recordStart = performance.now();
  document.getElementById('btn-mic').classList.add('hidden');
  document.getElementById('lbl-file').classList.add('hidden');
  document.getElementById('btn-live').classList.add('hidden');
  btnStop.classList.remove('hidden');
  submitBtn.classList.add('hidden');
  clearBtn.classList.add('hidden');
  vuWrap.classList.remove('hidden');
  setStatus('Recording — press stop when done');
}

// ── Controls ──────────────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      params.mode = btn.dataset.mode;
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('row-cym-style').style.display =
        params.mode === 'cymatics' ? '' : 'none';
      if (appState === 'captured') regenerate();
      else if (appState === 'live' && conductor) conductor.forceMorph();
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
  document.getElementById('btn-motion').addEventListener('click', () => {
    params.motionOn = !params.motionOn;
    renderer.setPlaying(params.motionOn);
    document.getElementById('btn-motion').innerHTML = params.motionOn ? '&#10074;&#10074; Pause' : '&#9654; Play';
  });
  document.getElementById('sl-motion-period').addEventListener('input', (e) => {
    params.motionPeriod = parseFloat(e.target.value);
    document.getElementById('val-motion-period').textContent = params.motionPeriod;
    renderer.setLoopPeriod(params.motionPeriod);
  });
  document.getElementById('sel-export-res').addEventListener('change', (e) => { params.exportRes = e.target.value; });
  document.getElementById('sel-video-dur').addEventListener('change', (e) => { params.videoDur = parseInt(e.target.value, 10); });
  document.getElementById('chk-transparent').addEventListener('change', (e) => { params.transparentBg = e.target.checked; });
  document.getElementById('chk-flat').addEventListener('change', (e) => {
    params.flatView = e.target.checked;
    renderer.setProjection(params.flatView ? 'flat' : 'depth');
  });
  document.getElementById('sel-cym-style').addEventListener('change', (e) => {
    params.cymStyle = e.target.value;
    if (appState === 'captured' && params.mode === 'cymatics') regenerate();
  });
  sliders.forEach(([id, key, parse, regen]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id.replace('sl-', 'val-'));
    el.addEventListener('input', () => {
      params[key] = parse(el.value);
      if (valEl) valEl.textContent = el.value;
      if (!regen) applyRenderParams();
    });
    // regen sliders rebuild geometry only on release (change), not on drag
    if (regen) el.addEventListener('change', () => {
      if (appState === 'captured') regenerate();
      else if (appState === 'live' && conductor) conductor.forceMorph();
    });
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
          // Frame-accurate export: apply the shader's motion displacement
          // (mirrored in js/motion.js) so the SVG matches the visible frame.
          let expStrands = picked, expPositions = design.positions;
          const mp = renderer.getActiveMotion();
          if (mp) {
            const t = renderer.getLoopPhase();
            const displaceArr = (src) => {
              const c = new Float32Array(src.length);
              for (let i = 0; i < src.length; i += 3) {
                const [x, y, z] = displacePoint(src[i], src[i + 1], src[i + 2], mp, t);
                c[i] = x; c[i + 1] = y; c[i + 2] = z;
              }
              return c;
            };
            expStrands = picked.map(displaceArr);
            expPositions = displaceArr(design.positions);
          }
          const svg = exportStrandSVG({
            strands: expStrands,
            positions: expPositions,
            mvp: renderer.getMVP().elements,
            width: 1600, height: 1200,
            stops: activeStops(), background: params.transparentBg ? null : params.background,
            weight: params.strokeWeight,
          });
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform.svg' });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else if (fmt === 'mp4') {
          if (!('VideoEncoder' in window)) { setStatus('MP4 export not supported in this browser'); return; }
          if (!design) { setStatus('Create a design first'); return; }
          if (mp4Busy) { mp4Cancel = true; setStatus('Cancelling…'); return; }
          mp4Busy = true; mp4Cancel = false;
          const wasPlaying = params.motionOn;
          renderer.setPlaying(false);
          renderer.activateMotion();
          const savedPhase = renderer.getLoopPhase();
          try {
            const RES_PX = { std: null, '2k': 2400, '4k': 3840, '8k': 7680 };
            const vidPx = Math.min(RES_PX[params.exportRes] || 1080, 3840);
            const probe = renderer.renderHiRes(1);
            const scale = vidPx / Math.max(probe.width, probe.height);
            const plan = framePlan(params.motionPeriod, 30);
            const loops = loopsForDuration(params.videoDur, params.motionPeriod);
            const ok = await exportMP4({
              renderFrame: (i) => { renderer.setLoopPhase(plan.phase(i)); return renderer.renderHiRes(scale); },
              fps: plan.fps, frames: plan.frames * loops,
              bitrate: Math.min(50_000_000, Math.round(12_000_000 * (vidPx * vidPx) / (1920 * 1080))),
              onProgress: (p) => setStatus(`MP4 ${Math.round(p * 100)}% — click MP4 again to cancel`),
              shouldCancel: () => mp4Cancel,
            });
            setStatus(ok ? 'MP4 saved' : 'MP4 export cancelled');
          } finally {
            mp4Busy = false;
            renderer.setLoopPhase(savedPhase);
            renderer.setPlaying(wasPlaying);
          }
        } else {
          const RES_PX = { std: null, '2k': 2400, '4k': 3840, '8k': 7680 };
          const container = document.getElementById('renderer-container');
          const target = RES_PX[params.exportRes];
          const scale = fmt === 'pdf' ? 2
            : (target ? target / Math.max(container.clientWidth || 800, container.clientHeight || 600) : 3);
          const transparent = params.transparentBg && (fmt === 'png' || fmt === 'webp');
          const canvas = renderer.renderHiRes(scale, { transparent });
          if (renderer.exportNote) setStatus(renderer.exportNote);
          await exportCanvas(canvas, fmt);
        }
      } catch (e) { setStatus(`Export error: ${e.message}`); }
    });
  });
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
