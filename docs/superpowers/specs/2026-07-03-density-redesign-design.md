# Soundform Density Redesign — Design Spec

**Date:** 2026-07-03
**Status:** Approved pending user review
**Reference look:** kaustav.py-style density-rendered 3D attractors (log-density colour mapping, silky translucent structure on near-black navy).

## 1. Goals

1. All five modes redesigned to the density-rendered quality of the reference images.
2. Deterministic sound→form mapping driven by musical features: pitch, notes, harmony, velocity (onsets), volume dynamics, timbre. Same recording → identical design, always.
3. Every editing control does something visible. Categories: Form, Colour & palette, Texture & weight. Dead controls removed.
4. SVG export is structured vector art: editable bezier strand paths that faithfully represent the design's geometry, working in Illustrator and Figma (Photoshop places SVG as a smart object; hi-res PNG covers pixel work).
5. Fix broken raster export (`getHighResCanvas` is called but doesn't exist).

## 2. Non-goals

- Pixel-perfect vector reproduction of the raster glow (agreed: structured vector interpretation instead).
- Composition/camera controls (aspect ratio, camera presets) — not selected by user.
- A "variation" seed dial — user chose plain deterministic.
- Live always-animating visuals; designs are static after capture (rotation/interaction only).
- Build tooling. The app stays a no-build static site (GitHub Pages).

## 3. Architecture

```
js/
  audio.js         mic/file capture + per-frame analysis (adds pitch, chroma, onset)
  features.js      frames → one deterministic sound fingerprint (pure)
  generators/
    attractor.js   each: (fingerprint, params) → { pointCloud, strands } (pure)
    chladni.js
    radial.js
    spectral.js
    timbre.js
  density.js       GPU density renderer: splat → log tonemap → screen / hi-res target
  strands.js       strand simplification (RDP) + Catmull-Rom→bezier fitting (pure)
  palettes.js      colour ramps shared by tonemap LUT and SVG gradients (pure)
  exporter.js      SVG builder + hi-res PNG/JPG/WebP/PDF
  main.js          app state machine + UI bindings
  worker.js        generation worker (attractor iteration off the main thread)
```

Every generator produces two representations of the same geometry:
- **pointCloud**: Float32 positions + per-point scalar attribute (e.g. local speed), 0.5M–4M points, for the screen density render.
- **strands**: 24–96 ordered trajectories (arrays of 3D points) for vector export and an optional on-screen strand overlay.

Three.js r134 (existing CDN) stays; the density pipeline is custom ShaderMaterial + WebGLRenderTarget.

## 4. Sound fingerprint (features.js)

Per-frame during recording (~60 fps):
- **Pitch**: autocorrelation (YIN-style) on time-domain buffer → f0 + confidence.
- **Chroma**: FFT magnitudes folded into 12 pitch classes.
- **Onset strength**: positive spectral flux vs previous frame.
- **RMS volume**, spectral centroid, spectral spread (existing).

On ✓ submit, frames collapse into one fingerprint:

| Feature | Derived as | Drives |
|---|---|---|
| pitchMedian, pitchRange, contour (8 samples) | confidence-weighted stats over voiced frames | core coefficients of the chosen system — overall form |
| noteSet (which pitch classes), noteCount | thresholded chroma histogram | symmetry order, lobe/strand counts |
| harmony: consonance score, major/minor leaning | chroma correlation with triad templates + interval dissonance | palette relationships (consonant → analogous hues; dissonant → clashing accent) |
| velocity: onsetsPerSec, meanOnsetStrength | onset stats | texture: grain sharpness, turbulence |
| dynamics: volMean, volVariance, attackSlope | volume stats | density, weight, contrast |
| timbre: centroidMean, spreadMean | spectral stats | base hue, brightness balance |
| seed | 64-bit hash of the quantised fingerprint | any pseudo-random choice (fully reproducible) |

**Confidence weighting:** each musical feature carries confidence; low-confidence features (noisy/polyphonic audio) transfer influence to robust spectral/dynamics features so degradation is graceful.

**Determinism:** identical audio buffer → identical fingerprint → identical geometry on the same browser/device. Cross-browser trig differences may cause slight (equally valid) divergence — accepted.

## 5. Density renderer (density.js)

1. **Accumulate:** point cloud drawn as small gaussian splats with additive blending into an RGBA16F render target (density in R; palette-position attribute in G).
2. **Tonemap:** fullscreen pass maps density d → `log(1 + d·exposure) / log(1 + exposure·dMax)` → colour ramp LUT. Contrast applies gamma on the normalised value.
3. **Present:** composite over background colour.

- Hi-res image export renders the same pipeline at 3–4× into an offscreen target (fixes the PNG/JPG/WebP path).
- **Render-on-demand:** redraw only on rotation/drag/zoom/param change/auto-rotate. Idle = no draw calls (battery win).
- **Fallbacks:** RGBA16F unsupported → RGBA8 with scaled accumulation; worst case → current additive PointsMaterial look + status note.
- **Device scaling:** default point count 1.5M desktop / 0.5M mobile (by `devicePixelRatio` + a quick GPU timing probe); Density slider caps accordingly.
- Generation (map iteration) runs in `worker.js` with progress status; typical 0.5–2 s on ✓.

## 6. The five modes

Each is a generator over the shared pipeline. Fingerprint mapping per §4 table; per-mode notes:

1. **Attractor** (flagship): family = { Thomas, Aizawa, Halvorsen, Clifford-3D, sine-map (as in reference images 2–3) }. Harmony class + noteCount select the system; pitch sets coefficients within the system's interesting (chaotic) range — coefficient ranges pre-validated per system so output never collapses to a fixed point. Velocity → per-point jitter/turbulence. Speed attribute → palette position.
2. **Chladni**: 3D standing-wave interference density — Monte Carlo samples weighted toward nodal surfaces of superposed modes; noteSet maps directly to (m, n) wave modes (the "truest" musical mode). Silky bands replace the dotty sphere.
3. **Radial**: orbital ribbon shells; each shell a tilted deformed orbit splatted densely; harmony sets interleaving angles; overlaps build luminous cores.
4. **Spectral**: harmonic helix; each detected note spirals a filament at its pitch-class angle/octave height; chords braid into columns.
5. **Timbre**: recording's trajectory through (centroid, volume, spread) space as a ribbon bundle thickened by dwell time — a signature of the performance over time.

## 7. Strand system & SVG export (strands.js, exporter.js)

- Each generator emits strands (ordered trajectories) from the same maths as the cloud.
- Export: project strands with the current camera/rotation → RDP-simplify to ≤300 anchors → fit cubic beziers (Catmull-Rom conversion) → per-path stroke width & opacity from local cloud density (coarse 3D grid lookup) → stroke `linearGradient` sampled from the active palette along the path.
- SVG structure: background rect; one named group per strand (`strand-01`…), depth-sorted (painter's order); real bezier `<path>` elements. Target < 1 MB so Figma keeps vectors (it rasterises very large SVGs).
- Strand count & stroke weight controlled by Texture sliders. PDF export continues to wrap the raster image (unchanged).

## 8. Controls

| Section | Controls | Effect |
|---|---|---|
| Mode | 5 mode buttons | choose generator |
| Form | Complexity, Symmetry, Twist, Scale | coefficient excursion / enforced symmetry order / rotational shear / size |
| Colour | Palette preset dropdown (incl. reference "Nebula" purples, an ember ramp, and pastel lavender/rose/mint options), custom 2–3 stop ramp, Background colour, Exposure, Contrast | tonemap LUT + SVG gradients (shared source in palettes.js) |
| Texture | Density (points), Grain (splat size soft↔crisp), Strands (count), Weight (stroke width) | screen texture + export richness |
| Motion | Auto-rotate speed | unchanged |

Removed: Glow (never worked), Reactivity (superseded by fingerprint mapping), Smoothing slider (only affected live analysis), Detail/Rings/Ring Twist/Helix Turns (superseded by Form controls). Colour pickers' pastel defaults per user preference.

Workflow unchanged: 🎤/📁 → ⏹ → ✓ → design; drag rotate, wheel zoom; 🗑️ reset.

## 9. Verification & testing

- Pure modules (features.js, generators/*, strands.js, palettes.js) get a small `node --test` suite in `test/`: fingerprint correctness on synthetic signals (pure tone → correct pitch class; chord → correct noteSet), generator sanity (bounded output, non-degenerate spread), determinism (same input → byte-identical output), strand fitting error bounds.
- Rendering verified by eye against the three reference images; exports verified by opening SVGs in Figma and Illustrator before completion.
- Performance check: 60 fps rotation at default density on the dev machine; generation < 3 s.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pitch/harmony unreliable on noisy or polyphonic audio | confidence weighting shifts influence to robust features |
| Float render target unsupported | RGBA8 fallback, then legacy additive look |
| Chaotic systems collapsing to fixed points for some coefficients | pre-validated coefficient ranges per system |
| Figma rasterising large SVGs | < 1 MB budget, strand/anchor caps |
| Cross-browser trig divergence breaks pixel-identical determinism | accepted; per-device determinism guaranteed |
| Big rewrite destabilises live site | work on branch `density-redesign`; main/Pages untouched until verified |

## 11. Milestones (implementation order)

1. Branch + scaffolding; density pipeline rendering the existing attractor cloud (visual leap first).
2. features.js fingerprint + worker generation + new Attractor family.
3. Remaining four generators.
4. Controls overhaul (remove dead, add Form/Colour/Texture).
5. Strand system + SVG export; fix hi-res raster export.
6. Test suite, cross-device pass, verification against references.
