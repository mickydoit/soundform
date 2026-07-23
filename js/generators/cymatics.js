import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';

// Tone quantization levels — must equal TONE_CLASSES in js/strands.js
// (generators never import versioned modules, so the constant is duplicated).
const TONE_LEVELS = 5;

// Water-mandala cymatics: standing waves on a circular membrane.
// Each detected note = one (m petals, ring wavenumber) mode; modes superpose
// into an interference field. Points survive where |amplitude| is high, so
// crests glow under the log-density tonemap. Radial profile is a damped
// cosine — a visually faithful stand-in for Bessel J_m modes.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const arch = params.liveVariance ? formArchetype(fp) : null;
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));

  const kBase = 6 + fp.pitchMedian * 10 + params.complexity * 8;
  const detune = (1 - fp.consonance) * 0.9;
  // Atonal/spoken input (low consonance) loosens the modes: wavenumber and
  // amplitude gain seeded variance, so speech reads wilder than sung tones.
  const wild = (0.5 + (1 - (fp.consonance ?? 0.5))) * (arch ? 1 + arch.wildness : 1);
  const modes = fp.noteSet.map((pc, idx) => ({
    m: 2 + (pc % 7) + Math.round(params.complexity * 3),
    kr: kBase * (0.55 + 0.45 * ((idx + 1) / fp.noteCount)) * (1 + (rnd() - 0.5) * 0.15 * wild),
    amp: Math.max(0.15, fp.chroma[pc]) * (1 + (rnd() - 0.5) * 0.4 * wild),
    phase: detune * rnd() * Math.PI * 2,
  }));
  // CymaScope intricacy: each note mode's second harmonic (finer petals,
  // half strength; reuses the base phase — no extra rnd calls), plus a
  // bullseye core of pure radial rings (m = 0).
  for (const md of [...modes]) {
    modes.push({ m: md.m, kr: md.kr * 2, amp: md.amp * 0.5, phase: md.phase });
  }
  modes.push({ m: 0, kr: kBase * 1.8, amp: 0.45, phase: 0 });

  // Prosody envelope: the utterance's pitch contour shapes the membrane from
  // centre to rim, so spoken phrases with different intonation read differently.
  const contour = fp.contour && fp.contour.length >= 8 ? fp.contour : null;
  const prosody = (r) => {
    if (!contour) return 1;
    const x = Math.min(6.999, Math.max(0, r * 7));
    const i = Math.floor(x), f2 = x - i;
    return 0.7 + (contour[i] + (contour[i + 1] - contour[i]) * f2) * 0.6;
  };

  const field = (r, th) => {
    let f = 0;
    for (const md of modes) {
      f += md.amp * (Math.cos(md.kr * r - md.m * 0.5) / Math.sqrt(1 + md.kr * r * 0.5))
                  * Math.cos(md.m * th + md.phase);
    }
    return f * prosody(r);
  };

  let fMax = 1e-6;
  for (let i = 0; i < 4000; i++) {
    const a = Math.abs(field(Math.sqrt(rnd()), rnd() * Math.PI * 2));
    if (a > fMax) fMax = a;
  }

  const relief = 0.22 + fp.volMean * 0.25;
  const spray = fp.velocity * 0.015;
  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  // Style: how the field renders. 'auto' lets the sound pick — deterministic
  // per seed — spreading designs across three physically real cymatics looks:
  //  scope  — luminous fringed crests, true-black voids (CymaScope imaging)
  //  sand   — grains gathered along the STILL nodal lines (Chladni plate)
  //  relief — the classic smooth water-mandala rendering
  const STYLES = ['scope', 'sand', 'relief'];
  const ARCH_STYLE = ['relief', 'scope', 'sand']; // tonal, bright, rough
  const style = STYLES.includes(params.cymStyle) ? params.cymStyle
              : arch ? ARCH_STYLE[arch.index]
              : STYLES[fp.seed % 3];

  const kFine = 140 + fp.pitchMedian * 80;
  const fringeAt = (r) => Math.pow(Math.abs(Math.cos(kFine * r)), 4);
  const pOf = style === 'scope' ? (af0, r) => Math.pow(af0, 2.5) * (0.15 + 0.85 * fringeAt(r))
            : style === 'sand'  ? (af0)    => Math.exp(-Math.pow(af0 / 0.12, 2))
            :                     (af0)    => Math.max(Math.pow(af0, 1.4), 0.08);
  // Sampled acceptance normalisation: keeps density healthy for the sparse
  // styles without lifting their voids (uniform scaling preserves contrast).
  let pSum = 0;
  for (let i = 0; i < 4000; i++) {
    const r = Math.sqrt(rnd());
    const af0 = Math.min(1, Math.abs(field(r, rnd() * Math.PI * 2)) / fMax);
    pSum += pOf(af0, r);
  }
  const pBoost = style === 'relief' ? 1 : Math.min(6, 0.3 / Math.max(1e-4, pSum / 4000));
  let count = 0, guard = 0;
  while (count < N && guard < N * 60) {
    guard++;
    const r = Math.sqrt(rnd());
    const th = rnd() * Math.PI * 2;
    const f = field(r, th) / fMax;
    const af0 = Math.min(1, Math.abs(f));
    if (rnd() > Math.min(1, pOf(af0, r) * pBoost)) continue;
    let x = Math.cos(th) * r, z = Math.sin(th) * r, y, a;
    if (style === 'sand') {
      x += (rnd() - 0.5) * 0.008; z += (rnd() - 0.5) * 0.008; // grain scatter
      y = (rnd() + rnd() - 1) * 0.012;                        // nodes are still: flat plate
      a = 0.7 + (rnd() - 0.5) * 0.3;                          // sandy white grain
    } else if (style === 'scope') {
      y = f * relief + (rnd() + rnd() - 1) * spray * af0;
      a = Math.min(1, af0 * (0.55 + 0.45 * fringeAt(r)) + 0.1);
    } else {
      y = f * relief + (rnd() + rnd() - 1) * spray * af0;
      a = af0;
    }
    positions[count * 3] = x;
    positions[count * 3 + 1] = y;
    positions[count * 3 + 2] = z;
    attr[count] = a;
    count++;
    if (onProgress && count % 250000 === 0) onProgress(count / N);
  }

  // Strands: one ring per bright fringe — the peaks of the same cos(kFine·r)
  // term that draws the on-screen striations — instead of uniformly spaced
  // rings. Each ring keeps the amplitude bulge and the smoothed void-gap
  // logic, and is additionally split wherever the smoothed amplitude crosses
  // a quantized tone boundary, so every exported arc carries the field
  // amplitude (tone) the raster renders as brightness, plus its radial band.
  // No rnd() calls here: the RNG stream feeding the point cloud stays intact.
  const RING_AMP_GAIN = 0.25;
  const RING_SAMPLES = 220;
  const VOID_CUTOFF = 0.12;
  const VOID_SMOOTH_WINDOW = 15; // angular samples; smooths out single-ripple
                                  // gaps so only sustained nodal regions break a ring
  const MIN_RUN = 6;              // samples; shorter tone segments merge into a neighbor
  const PATH_CAP = 4800;          // max exported arcs after symmetry replication

  const ringRadii = [];
  for (let n = 1; ; n++) {
    const r = (n * Math.PI) / kFine; // |cos(kFine·r)| peaks where kFine·r = nπ
    if (r > 0.995) break;
    ringRadii.push(r);
  }

  const ringArcs = ringRadii.map((r0) => {
    const ringPts = new Float32Array(RING_SAMPLES * 3);
    const af0 = new Float32Array(RING_SAMPLES);
    for (let i = 0; i < RING_SAMPLES; i++) {
      const th = (i / RING_SAMPLES) * Math.PI * 2;
      const f = field(r0, th) / fMax;
      const r = r0 * (1 + RING_AMP_GAIN * f);
      ringPts[i * 3] = Math.cos(th) * r;
      ringPts[i * 3 + 1] = f * relief;
      ringPts[i * 3 + 2] = Math.sin(th) * r;
      af0[i] = Math.min(1, Math.abs(f));
    }
    const smoothed = boxcarMean(af0, VOID_SMOOTH_WINDOW);
    const arcs = [];
    for (const run of toneRuns(smoothed, VOID_CUTOFF, TONE_LEVELS, MIN_RUN)) {
      if (run.indices.length < 4) continue; // sliver, not worth a stroke
      const arcPts = new Float32Array(run.indices.length * 3);
      run.indices.forEach((i, j) => {
        arcPts[j * 3] = ringPts[i * 3];
        arcPts[j * 3 + 1] = ringPts[i * 3 + 1];
        arcPts[j * 3 + 2] = ringPts[i * 3 + 2];
      });
      const closed = run.indices.length === RING_SAMPLES;
      const src = closed ? closeLoop(arcPts) : arcPts;
      const m = closed ? 200 : Math.max(6, Math.round(200 * run.indices.length / RING_SAMPLES));
      arcs.push({ pts: resamplePolyline(src, m), tone: run.tone });
    }
    return arcs;
  });

  // Path budget: k-fold symmetry replicates every arc k times — thin whole
  // rings (never individual arcs) until the estimate fits the cap.
  const totalArcs = ringArcs.reduce((a, r) => a + r.length, 0) * k;
  const ringStride = Math.max(1, Math.ceil(totalArcs / PATH_CAP));
  const strands = [];
  ringArcs.forEach((arcs, ri) => {
    if (ri % ringStride) return;
    const band = Math.min(7, Math.floor(ringRadii[ri] * 8));
    for (const a of arcs) strands.push({ pts: a.pts, tone: a.tone, band, ring: ri });
  });
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
}

function levelOf(a, levels) {
  return Math.max(0, Math.min(levels - 1, Math.floor(a * levels)));
}

// Splits a circular per-sample amplitude array into contiguous runs that are
// (a) above the void cutoff and (b) within a single quantized tone level.
// Segments shorter than minRun merge into their larger neighbor, and adjacent
// same-level segments coalesce, so tone boundaries never fragment an arc into
// slivers. Returns [{ indices, tone }], tone = the run's mean amplitude.
export function toneRuns(smoothed, cutoff, levels, minRun) {
  const n = smoothed.length;
  const visible = new Uint8Array(n);
  for (let i = 0; i < n; i++) visible[i] = smoothed[i] >= cutoff ? 1 : 0;
  const out = [];
  for (const vis of visibleRuns(visible)) {
    const sub = [];
    for (const idx of vis) {
      const lv = levelOf(smoothed[idx], levels);
      const last = sub[sub.length - 1];
      if (last && last.level === lv) last.indices.push(idx);
      else sub.push({ level: lv, indices: [idx] });
    }
    for (let i = 0; i < sub.length; ) {
      if (sub.length === 1 || sub[i].indices.length >= minRun) { i++; continue; }
      const prev = sub[i - 1], next = sub[i + 1];
      if (prev && (!next || prev.indices.length >= next.indices.length)) {
        prev.indices.push(...sub[i].indices);
      } else {
        next.indices.unshift(...sub[i].indices);
      }
      sub.splice(i, 1);
    }
    for (let i = 1; i < sub.length; ) {
      if (sub[i].level === sub[i - 1].level) {
        sub[i - 1].indices.push(...sub[i].indices);
        sub.splice(i, 1);
      } else i++;
    }
    for (const seg of sub) {
      let sum = 0;
      for (const idx of seg.indices) sum += smoothed[idx];
      out.push({ indices: seg.indices, tone: sum / seg.indices.length });
    }
  }
  return out;
}

// Circular boxcar average — smooths a per-angle sample array over `window`
// neighbors (wrapping), so an isolated single-sample dip doesn't register
// on its own.
function boxcarMean(arr, window) {
  const n = arr.length;
  const half = Math.floor(window / 2);
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = -half; i <= half; i++) sum += arr[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    out[i] = sum / (half * 2 + 1);
    const drop = ((i - half) % n + n) % n;
    const add = ((i + half + 1) % n + n) % n;
    sum += arr[add] - arr[drop];
  }
  return out;
}

// Contiguous index runs where visible[i] is truthy, treating the array as a
// circular ring (a run may wrap past the end back to the start). Returns
// one full-length run if every sample is visible.
function visibleRuns(visible) {
  const n = visible.length;
  let allVisible = true, anyVisible = false;
  for (let i = 0; i < n; i++) {
    if (visible[i]) anyVisible = true; else allVisible = false;
  }
  if (allVisible) return [Array.from({ length: n }, (_, k) => k)];
  if (!anyVisible) return []; // whole ring sits in a node — no arcs survive

  let start = 0;
  while (!visible[start]) start++; // first visible index (anyVisible, so this halts)
  while (visible[(start - 1 + n) % n]) start = (start - 1 + n) % n; // walk back to run start

  const runs = [];
  let cur = null;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    if (visible[idx]) {
      if (!cur) cur = [];
      cur.push(idx);
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

// Appends the first point to the end so a fully-visible ring still closes
// visually (matches the old fixed 220-sample duplicate-endpoint behavior).
function closeLoop(pts) {
  const out = new Float32Array(pts.length + 3);
  out.set(pts);
  out[pts.length] = pts[0];
  out[pts.length + 1] = pts[1];
  out[pts.length + 2] = pts[2];
  return out;
}
