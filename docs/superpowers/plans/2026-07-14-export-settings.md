# Export Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-facing export settings — image resolution picker (Standard/2K/4K/8K), MP4 duration picker (whole seamless loops), transparent-background export for PNG/WebP/SVG.

**Architecture:** A new "Export" panel section writes three params; export buttons read them at click time. `renderHiRes` gains an options bag (`{ transparent }`) and an 8K-safety clamp; the tonemap shader gains an additive `uTransparent` uniform (0 = pixel-identical to today). `loopsForDuration` in exporter.js multiplies the seamless-loop frame plan.

**Tech Stack:** Vanilla ES modules, node:test, THREE r134, WebCodecs.

**Spec:** `docs/superpowers/specs/2026-07-14-export-settings-design.md`

## Global Constraints

- Branch `export-settings`. Defaults (Standard / 1 loop / transparency off) must reproduce today's outputs exactly.
- `js/density.js` additive only: `uTransparent` default 0 → shader output pixel-identical; live canvas never renders transparent.
- Attractor/Cymatics generators untouched. Cache bump v=27 → v=28 at ship. All tests green before merge.
- User waived manual gates (2026-07-14): ship after automated verification.

---

### Task 1: loopsForDuration + transparent SVG (pure, node-tested)

**Files:**
- Modify: `js/exporter.js` (append `loopsForDuration`; guard background rect in `exportStrandSVG` ~line 97; add `bitrate` option to `exportMP4`)
- Test: `test/exporter.test.js` (append)

**Interfaces:**
- Produces: `loopsForDuration(targetSec, periodSec)` → int ≥ 1 (0/undefined targetSec → 1). `exportStrandSVG({ ..., background: null })` → omits `<rect id="background">`. `exportMP4({ ..., bitrate })` — optional, defaults to 12 Mbps.

- [ ] **Step 1: Failing tests** — append to `test/exporter.test.js`:

```js
test('loopsForDuration: rounds to whole loops, min 1, 0 means one loop', () => {
  assert.equal(loopsForDuration(0, 8), 1);
  assert.equal(loopsForDuration(undefined, 8), 1);
  assert.equal(loopsForDuration(5, 8), 1);
  assert.equal(loopsForDuration(30, 8), 4);   // 32s
  assert.equal(loopsForDuration(60, 8), 8);   // 64s
  assert.equal(loopsForDuration(10, 4), 3);   // 12s? no: 10/4=2.5 → round → 2... expected 2
});

test('exportStrandSVG: null background omits the rect, keeps paths', () => {
  const { strands, positions } = fixture();
  const svg = exportStrandSVG({ strands, positions, mvp: IDENTITY, width: 800, height: 600,
    stops: [[0, '#000000'], [1, '#ffffff']], background: null, weight: 1 });
  assert.ok(!svg.includes('id="background"'), 'background rect must be absent');
  assert.ok(svg.includes('<path'), 'paths must remain');
});
```

(Fix the inline arithmetic before committing: `loopsForDuration(10, 4)` expects `2` and `(30, 8)` expects `4`; delete the stray comment.)

Add `loopsForDuration` to the existing import from `../js/exporter.js`.

- [ ] **Step 2:** Run `npm test` → the two new tests FAIL (not exported / rect present).

- [ ] **Step 3: Implement** — in `js/exporter.js`:

Append:
```js
// Whole seamless loops that best match a requested duration (0 → one loop).
export function loopsForDuration(targetSec, periodSec) {
  if (!targetSec) return 1;
  return Math.max(1, Math.round(targetSec / Math.max(0.5, periodSec)));
}
```

In `exportStrandSVG`, replace the background rect line (~97) with:
```js
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
```
(Adapt to the surrounding array-literal structure: the rect line is one element of the lines array — make it conditional.)

In `exportMP4`, change the signature to `({ renderFrame, fps, frames, onProgress, shouldCancel, bitrate })` and the config line to use it:
```js
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: bitrate || 12_000_000, framerate: fps };
```

- [ ] **Step 4:** `npm test` → PASS (54 tests).
- [ ] **Step 5:** Commit: `feat(export): loopsForDuration, transparent SVG, bitrate option`

---

### Task 2: Renderer — uTransparent + renderHiRes options + 8K clamp

**Files:**
- Modify: `js/density.js` — TONE_FRAG (~line 26), toneMat uniforms (~line 108), `renderHiRes` (~line 264)

**Interfaces:**
- Produces: `renderHiRes(scaleFactor, { transparent = false } = {})` → canvas (alpha preserved when transparent); `this.exportNote` → `null | string` set per call ("8K unavailable on this GPU — exported at 4K").

- [ ] **Step 1: Shader** — TONE_FRAG becomes:

```glsl
precision highp float;
varying vec2 vUv;
uniform sampler2D tDensity;
uniform sampler2D tLUT;
uniform float uExposure, uContrast, uPeak, uTransparent;
uniform vec3 uBackground;
void main() {
  vec4 s = texture2D(tDensity, vUv);
  float d = s.r;
  float t = log(1.0 + d * uExposure) / log(1.0 + max(uPeak, 1.0) * uExposure);
  t = pow(clamp(t, 0.0, 1.0), uContrast);
  float attr = s.g / max(s.r, 1e-5);
  vec3 col = texture2D(tLUT, vec2(clamp(t * 0.88 + attr * 0.12, 0.0, 1.0), 0.5)).rgb;
  float cov = smoothstep(0.0, 0.08, t) * min(t * 1.4 + 0.25, 1.0);
  gl_FragColor = mix(vec4(mix(uBackground, col, cov), 1.0), vec4(col, cov), uTransparent);
}
```
(At `uTransparent = 0.0` this is algebraically identical to the current shader.)

Add `uTransparent: { value: 0 }` to toneMat uniforms.

- [ ] **Step 2: renderHiRes** — new signature `renderHiRes(scaleFactor = 3, { transparent = false } = {})`. At the top:

```js
    this.exportNote = null;
    const [w, h] = this._size();
    const maxTex = this.renderer.capabilities.maxTextureSize || 8192;
    let W = Math.floor(w * scaleFactor), H = Math.floor(h * scaleFactor);
    if (Math.max(W, H) > maxTex) {
      const clamp = maxTex / Math.max(w, h);
      W = Math.floor(w * clamp); H = Math.floor(h * clamp);
      this.exportNote = `Requested size exceeds this GPU (max ${maxTex}px) — exported at ${Math.max(W, H)}px`;
    }
    if (transparent && !this.fallback) this.toneMat.uniforms.uTransparent.value = 1;
```
Wrap the render-target allocations in try/catch: on exception, halve W/H once, set `this.exportNote = 'High-res allocation failed — exported at ' + Math.max(W, H) + 'px'`, retry; rethrow on second failure. In the cleanup section (where saved uniforms restore), add `this.toneMat.uniforms.uTransparent.value = 0;`.

- [ ] **Step 3:** `npm test` → all pass (no GPU tests; syntax check `node --check js/density.js`).
- [ ] **Step 4:** Commit: `feat(density): transparent export uniform, renderHiRes options, GPU-size clamp`

---

### Task 3: UI + wiring + ship

**Files:**
- Modify: `index.html` (Export section after Motion, ~line 137), `js/main.js` (params ~30, bindings ~250, export handler ~280)

**Interfaces:**
- Consumes: `loopsForDuration`, `renderHiRes(scale, { transparent })`, `renderer.exportNote`.
- Produces: params `exportRes: 'std'|'2k'|'4k'|'8k'`, `videoDur: 0|5|10|30|60`, `transparentBg: boolean`; UI ids `sel-export-res`, `sel-video-dur`, `chk-transparent`.

- [ ] **Step 1: Markup** — after the Motion section's closing `</div>`:

```html
    <div class="panel-section">
      <div class="section-title">Export</div>
      <div class="sl-row">
        <select id="sel-export-res">
          <option value="std" selected>Standard res</option>
          <option value="2k">2K (2400px)</option>
          <option value="4k">4K (3840px)</option>
          <option value="8k">8K Print (7680px)</option>
        </select>
      </div>
      <div class="sl-row">
        <select id="sel-video-dur">
          <option value="0" selected>Video: 1 loop</option>
          <option value="5">Video: ~5 s</option>
          <option value="10">Video: ~10 s</option>
          <option value="30">Video: ~30 s</option>
          <option value="60">Video: ~60 s</option>
        </select>
      </div>
      <label class="color-pick-label"><input type="checkbox" id="chk-transparent"> Transparent background</label>
    </div>
```

- [ ] **Step 2: main.js** — params additions: `exportRes: 'std', videoDur: 0, transparentBg: false,`. Import `loopsForDuration` alongside the other exporter imports. Bindings next to sel-palette:

```js
  document.getElementById('sel-export-res').addEventListener('change', (e) => { params.exportRes = e.target.value; });
  document.getElementById('sel-video-dur').addEventListener('change', (e) => { params.videoDur = parseInt(e.target.value, 10); });
  document.getElementById('chk-transparent').addEventListener('change', (e) => { params.transparentBg = e.target.checked; });
```

Export handler changes:
```js
        const RES_PX = { std: null, '2k': 2400, '4k': 3840, '8k': 7680 };
        const container = document.getElementById('renderer-container');
        const resScale = (targetPx) => targetPx / Math.max(container.clientWidth || 800, container.clientHeight || 600);
```
- SVG branch: `background: params.transparentBg ? null : params.background` (in the exportStrandSVG call).
- MP4 branch: video target `const vidPx = Math.min(RES_PX[params.exportRes] || 1080, 3840);` → `const scale = vidPx / Math.max(probe.width, probe.height);`; frames multiplied: `const loops = loopsForDuration(params.videoDur, params.motionPeriod); const totalFrames = plan.frames * loops;` (pass `frames: totalFrames`; `plan.phase(i)` already wraps). Bitrate: `bitrate: Math.min(50_000_000, Math.round(12_000_000 * (vidPx * vidPx) / (1920 * 1080)))`.
- Image branch (`else`): 
```js
          const target = RES_PX[params.exportRes];
          const scale = fmt === 'pdf' ? 2 : (target ? resScale(target) : 3);
          const transparent = params.transparentBg && (fmt === 'png' || fmt === 'webp');
          const canvas = renderer.renderHiRes(scale, { transparent });
          if (renderer.exportNote) setStatus(renderer.exportNote);
          await exportCanvas(canvas, fmt);
```

- [ ] **Step 3:** `npm test` + `node --check js/main.js` → all pass.
- [ ] **Step 4: Ship** — bump `v=27`→`v=28` (`grep -rl 'v=27' index.html style.css js | xargs sed -i '' 's/v=27/v=28/g'`), commit, merge to main, `npm test`, push, verify live `curl … | grep v=28`, delete branch.

---

## Final verification

- [ ] 54 tests pass on merged main; live site serves v=28.
- [ ] Default-settings export code path identical (std → `renderHiRes(3)`, videoDur 0 → 1 loop, transparency off).
