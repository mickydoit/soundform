import { idleState, targetFromFeatures, clamp01 } from '../cymafield.js?v=56';

// Liquid: a cymatic water layer.
//
// This mode does NOT produce a point cloud, and it no longer places circles.
// The geometry is a modal standing-wave field (js/cymafield.js) evaluated per
// pixel by the shader; what the generator returns is the FIELD STATE — a
// dozen floats — which the renderer and the exporters both work from.
//
// Because the state is continuous in every parameter, live audio can glide it
// frame by frame and the pattern morphs rather than being regenerated.

export function stateFromFingerprint(fp, params = {}) {
  const s = idleState();
  Object.assign(s, targetFromFeatures({
    pitchNorm: fp.pitchMedian,
    rms: (fp.volMean ?? 0.3) * 0.6,
    centroid: fp.centroid,
    spread: fp.spread,
    pitchConf: fp.pitchConfidence,
  }));
  // Complexity biases the modal order without breaking the pitch mapping —
  // the slider should refine the same figure, not select a different one.
  const comp = Number.isFinite(params.complexity) ? clamp01(params.complexity) : 0.5;
  s.m = Math.max(1.2, s.m + (comp - 0.5) * 3.4);
  s.n = Math.max(1.0, s.n + (comp - 0.5) * 2.2);
  s.kr = Math.max(2, s.kr + (comp - 0.5) * 6);
  const twist = Number.isFinite(params.twist) ? params.twist : 0;
  s.phase += twist * 0.9;
  return s;
}

// Musical frames carry pitch in Hz; the field wants it normalised over the
// same 6-octave span the rest of the app uses (55 Hz – 3520 Hz).
export function featuresOf(f) {
  const hz = f.pitchHz ?? 0;
  const pitchNorm = hz > 20 ? clamp01(Math.log2(hz / 55) / 6) : 0.35;
  return {
    pitchNorm,
    rms: f.rms ?? 0,
    centroid: f.centroid ?? 0.3,
    spread: f.spread ?? 0.3,
    pitchConf: f.pitchConf ?? 0.5,
  };
}

export function stateFromFrame(f, params = {}) {
  const s = idleState();
  Object.assign(s, targetFromFeatures(featuresOf(f)));
  const comp = Number.isFinite(params.complexity) ? clamp01(params.complexity) : 0.5;
  s.m = Math.max(1.2, s.m + (comp - 0.5) * 3.4);
  s.n = Math.max(1.0, s.n + (comp - 0.5) * 2.2);
  return s;
}

// A recording is a TIMELINE, not a single figure. Collapsing it to one
// fingerprint made playback a still image; sampling the frames lets the same
// recording animate the same way every time.
export function stateAtTime(frames, tSec, params = {}) {
  if (!frames || !frames.length) return idleState();
  const t0 = frames[0].t;
  let i = 0;
  while (i < frames.length - 1 && frames[i].t - t0 < tSec) i++;
  return stateFromFrame(frames[i], params);
}

export function generate(fp, params = {}, onProgress) {
  const state = stateFromFingerprint(fp, params);
  if (onProgress) onProgress(1);
  return {
    kind: 'field',
    state,
    // Contract stubs — the worker transfers these buffers, and every consumer
    // checks `kind` before handing them to the point-cloud renderer.
    positions: new Float32Array(0),
    attr: new Float32Array(0),
    strands: [],
  };
}
