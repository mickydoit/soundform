# Flat View + Speech-Unique Harmonics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orthographic flat top-down default view (toggleable) across render + all exports; prosody/consonance-driven uniqueness for spoken-word harmonic designs.

**Architecture:** `js/density.js` gains `setProjection`, `setOrientation`, and a `_setAspect` helper replacing the four perspective-specific `camera.aspect` sites (constructor stays perspective-built, then main.js switches). Harmonic deformation gains a contour envelope + consonance-scaled wave irregularity.

**Tech Stack:** THREE r134, vanilla ES modules, node:test.

**Spec:** `docs/superpowers/specs/2026-07-14-flat-view-speech-design.md`

## Global Constraints

- Branch `flat-view-speech`. `js/density.js` additive: perspective ('depth') mode pixel-identical to today. Attractor/Cymatics untouched. Deterministic. Bump v=29 → v=30 at ship. Autonomous ship (user-granted).

---

### Task 1: Speech-unique harmonic deformation (TDD)

**Files:** Modify `js/generators/harmonic.js` (deformation); Test `test/generators.test.js` (append).

**Interfaces:** No signature changes; `generate(fp, params)` consumes `fp.contour` (Float32Array(8), may be missing) and `fp.consonance`.

- [ ] **Step 1: Failing tests** — append:

```js
test('harmonic: speech prosody (contour) shapes the form', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const speech = generate(testFingerprint({ contour: Float32Array.from([0.1, 0.9, 0.2, 0.8, 0.1, 0.9, 0.2, 0.8]) }), params);
  const flat = generate(testFingerprint({ contour: new Float32Array(8).fill(0.45) }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(speech.positions[i] - flat.positions[i]);
  assert.ok(diff > 1, `contour must shape the form (diff=${diff})`);
});

test('harmonic: atonal input (low consonance) → different wave character', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const atonal = generate(testFingerprint({ consonance: 0.05 }), params);
  const tonal = generate(testFingerprint({ consonance: 0.95 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(atonal.positions[i] - tonal.positions[i]);
  assert.ok(diff > 1, `consonance must change wave character (diff=${diff})`);
});
```

- [ ] **Step 2:** `npm test` → both FAIL (contour/consonance currently unused by harmonic).
- [ ] **Step 3: Implement** — in `generate()`:

After the `waves` loop setup, change wave construction to:

```js
  const wild = 0.5 + (1 - (fp.consonance ?? 0.5)); // 0.5 (consonant) .. 1.5 (atonal/speech)
  const waves = [];
  for (let w = 0; w < nWaves; w++) {
    waves.push({
      f: (w + 1) * 0.5 + (rnd() - 0.5) * 0.8 * wild,
      phase: rnd() * Math.PI * 2,
      amp: (0.9 / (w + 2)) * (1 + (rnd() - 0.5) * 0.6 * wild),
    });
  }
```

Add the contour envelope before `disp`:

```js
  const contour = fp.contour && fp.contour.length >= 8 ? fp.contour : null;
  const prosody = (theta) => {
    if (!contour) return 1;
    const x = Math.min(6.999, Math.max(0, (theta / Math.PI) * 7));
    const i = Math.floor(x), f = x - i;
    return 0.7 + (contour[i] + (contour[i + 1] - contour[i]) * f) * 0.6;
  };
```

and change `disp`'s return to `return d * A * prosody(theta);`.

- [ ] **Step 4:** `npm test` → PASS (59). Existing harmonic contract/asymmetry tests must still pass.
- [ ] **Step 5:** Commit: `feat(harmonic): prosody banding + consonance-scaled wave irregularity`

---

### Task 2: Flat projection (renderer, additive)

**Files:** Modify `js/density.js` — `_setAspect` helper; replace aspect sites in `_onResize`, `_applyViewOffset`, `renderHiRes`, `getMVP`; ortho zoom branch in `_renderFrame`; new `setProjection(mode)` + `setOrientation(rx, ry)`.

**Interfaces:** Produces `setProjection('flat'|'depth')`, `setOrientation(rx, ry)`. Perspective path pixel-identical.

- [ ] **Step 1:** Add methods after `setViewInset`/`_applyViewOffset` region:

```js
  _setAspect(aspect) {
    if (this.camera.isOrthographicCamera) {
      const s = 1.325; // matches perspective framing: 3.2·tan(22.5°)
      this.camera.left = -s * aspect; this.camera.right = s * aspect;
      this.camera.top = s; this.camera.bottom = -s;
    } else {
      this.camera.aspect = aspect;
    }
  }

  // Flat (orthographic) vs depth (perspective) projection. Additive: 'depth'
  // rebuilds the exact constructor camera, so perspective output is unchanged.
  setProjection(mode) {
    const [w, h] = this._size();
    if (mode === 'flat') {
      const s = 1.325, aspect = w / h;
      this.camera = new THREE.OrthographicCamera(-s * aspect, s * aspect, s, -s, 0.01, 50);
    } else {
      this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    }
    this.camera.position.z = 3.2;
    this._projection = mode;
    this._applyViewOffset();
    this._dirty = true;
  }

  setOrientation(rx, ry) { this._rotX = rx; this._rotY = ry; this._dirty = true; }
```

- [ ] **Step 2:** Replace the two `this.camera.aspect = …` lines in `_applyViewOffset` with `this._setAspect(…)` (same arguments). Replace `this.camera.aspect = w / h;` in `_onResize` and in `renderHiRes`'s `hadOffset` block and `getMVP`'s `hadOffset` block with `this._setAspect(w / h)` (keep the `updateProjectionMatrix()` calls that follow).

- [ ] **Step 3:** In `_renderFrame`, replace the camera-distance line with:

```js
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = this._zoom / (this._insetZoomOut || 1);
      this.camera.updateProjectionMatrix();
      this.camera.position.z = 3.2;
    } else {
      this.camera.position.z = (3.2 / this._zoom) * (this._insetZoomOut || 1);
    }
```

- [ ] **Step 4:** `node --check js/density.js` + `npm test` → PASS.
- [ ] **Step 5:** Commit: `feat(density): orthographic flat projection + orientation setter (additive)`

---

### Task 3: UI + defaults + ship

**Files:** `index.html` (Motion section), `js/main.js` (param, init, binding).

- [ ] **Step 1:** Motion section, after the Loop(s) row:

```html
      <label class="color-pick-label"><input type="checkbox" id="chk-flat" checked> Flat view (2D)</label>
```

- [ ] **Step 2:** `js/main.js` — params: `flatView: true,`. After `renderer = new DensityRenderer(...)`:

```js
  renderer.setProjection(params.flatView ? 'flat' : 'depth');
  renderer.setOrientation(-Math.PI / 2, 0); // straight-on top-down: plate/mandala view
```

Binding (with the other export/motion bindings):

```js
  document.getElementById('chk-flat').addEventListener('change', (e) => {
    params.flatView = e.target.checked;
    renderer.setProjection(params.flatView ? 'flat' : 'depth');
  });
```

- [ ] **Step 3:** `node --check js/main.js` + `npm test` → PASS.
- [ ] **Step 4: Ship** — bump v=29 → v=30, commit, merge `flat-view-speech` → main, `npm test`, push, verify live `v=30`, delete branch.

## Final verification

- [ ] 59 tests green on merged main; live serves v=30 with `chk-flat` present.
