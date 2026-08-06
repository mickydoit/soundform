import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal duck-typed THREE stand-in covering exactly the surface
// js/density.js touches (WebGLRenderer/cameras/scene graph/geometry/
// materials/render target). DensityRenderer is otherwise untested in this
// suite because it needs a real WebGL context; this mock lets I5's
// uPeak/draw-range regression be pinned without one.
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
}
class Group {
  constructor() {
    this.children = [];
    this.scale = { x: 1, y: 1, z: 1, setScalar(s) { this.x = this.y = this.z = s; } };
    this.rotation = { set() {} };
    this.matrixWorld = {};
  }
  add(o) { this.children.push(o); }
  remove(o) { this.children = this.children.filter((c) => c !== o); }
  updateMatrixWorld() {}
}
class Scene extends Group {}
class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize;
    this.updateRange = { offset: 0, count: -1 };
  }
  setUsage() { return this; }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.drawRange = { start: 0, count: Infinity }; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  setDrawRange(start, count) { this.drawRange = { start, count }; }
  dispose() {}
}
class Material { constructor(opts = {}) { Object.assign(this, opts); this.uniforms = opts.uniforms || {}; } dispose() {} }
class ShaderMaterial extends Material {}
class PointsMaterial extends Material {}
class Points { constructor(geo, mat) { this.geometry = geo; this.material = mat; this.frustumCulled = true; } }
class Mesh { constructor(geo, mat) { this.geometry = geo; this.material = mat; } }
class PlaneGeometry { constructor() {} }
class DataTexture { constructor(data) { this.image = { data }; this.needsUpdate = false; } }
class Camera { updateProjectionMatrix() {} }
class PerspectiveCamera extends Camera {
  constructor(fov, aspect, near, far) { super(); Object.assign(this, { fov, aspect, near, far, position: { x: 0, y: 0, z: 0 } }); }
}
class OrthographicCamera extends Camera {
  constructor(l, r, t, b, near, far) {
    super();
    Object.assign(this, { left: l, right: r, top: t, bottom: b, near, far, position: { x: 0, y: 0, z: 0 }, zoom: 1 });
  }
}
class WebGLRenderTarget {
  constructor(w, h) { this.width = w; this.height = h; this.texture = {}; }
  setSize() {}
  dispose() {}
}
class Matrix4 { multiplyMatrices() { return this; } multiply() { return this; } }
class Color { constructor() {} }
const fakeGLContext = { getExtension: () => ({}) };
class WebGLRenderer {
  constructor() {
    this.domElement = { addEventListener() {}, style: {} };
    this.capabilities = { isWebGL2: true, maxTextureSize: 8192 };
    this._pixelRatio = 1;
  }
  setPixelRatio(p) { this._pixelRatio = p; }
  getPixelRatio() { return this._pixelRatio; }
  setSize() {}
  getContext() { return fakeGLContext; }
  setRenderTarget() {}
  setClearColor() {}
  clear() {}
  render() {}
  readRenderTargetPixels() {}
  dispose() {}
}

globalThis.THREE = {
  WebGLRenderer, PerspectiveCamera, OrthographicCamera, Scene, Group, BufferGeometry, BufferAttribute,
  ShaderMaterial, PointsMaterial, Points, Mesh, PlaneGeometry, DataTexture, Vector3: Vec3, Matrix4, Color,
  WebGLRenderTarget, AdditiveBlending: 'additive', DynamicDrawUsage: 'dynamic', RGBAFormat: 'rgba',
  HalfFloatType: 'half', UnsignedByteType: 'ubyte', NearestFilter: 'nearest',
};
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);
globalThis.devicePixelRatio = globalThis.devicePixelRatio ?? 1;

const { DensityRenderer } = await import('../js/density.js');

function makeRenderer(w = 1200, h = 800) {
  const container = { clientWidth: w, clientHeight: h, appendChild() {} };
  return new DensityRenderer(container);
}

// I5: setVisibleFraction sets uPeak from the VISIBLE point count and the
// draw range, but crossfadeTo used to open the new cloud at full draw range
// and estimate uPeak from the full (not visible) point count — a mismatch of
// up to ~1/visibleFraction, snapped in permanently by _disposeFading once the
// fade completed. Fixed by carrying `_visibleFraction` into crossfadeTo.
test('crossfadeTo carries the current visibleFraction onto the new cloud (draw range + uPeak)', () => {
  const r = makeRenderer();
  const N = 250000;
  r.setCloud(new Float32Array(N * 3).fill(0.1), new Float32Array(N).fill(0.5));
  r.setVisibleFraction(0.4);
  const visibleN = Math.round(N * 0.4);
  const peakAtQuietVolume = r.toneMat.uniforms.uPeak.value;
  assert.equal(r.points.geometry.drawRange.count, visibleN);

  const M = 250000;
  r.crossfadeTo(new Float32Array(M * 3).fill(0.2), new Float32Array(M).fill(0.5), 0.15);

  // The new cloud must open at the SAME visible fraction, not full draw range.
  const expectedNewVisible = Math.round(M * 0.4);
  assert.equal(r.points.geometry.drawRange.count, expectedNewVisible,
    'new cloud must open at the current visibleFraction, not the full buffer');

  // _peakFrom must equal what setVisibleFraction had just set (continuity at
  // the start of the fade); _peakTo must be scaled by the SAME fraction as
  // the draw range, not the full new point count.
  assert.equal(r._peakFrom, peakAtQuietVolume);
  const [w, h] = [1200, 800];
  const expectedPeakTo = Math.max(8, (expectedNewVisible / (w * h)) * 550);
  assert.ok(Math.abs(r._peakTo - expectedPeakTo) < 1e-6,
    `_peakTo ${r._peakTo} should be scaled by visibleFraction, not the full ${M}-point count`);

  // Once the fade completes, uPeak snaps to _peakTo — must still be the
  // fraction-scaled value, not a ~2.5x-too-bright full-count estimate.
  r._disposeFading();
  assert.ok(Math.abs(r.toneMat.uniforms.uPeak.value - expectedPeakTo) < 1e-6);
});

test('crossfadeTo without a prior setVisibleFraction defaults to full visibility', () => {
  const r = makeRenderer();
  const N = 1000;
  r.setCloud(new Float32Array(N * 3).fill(0.1), new Float32Array(N).fill(0.5));
  // No setVisibleFraction call — _visibleFraction is undefined.
  const M = 2000;
  r.crossfadeTo(new Float32Array(M * 3).fill(0.2), new Float32Array(M).fill(0.5), 0.15);
  assert.equal(r.points.geometry.drawRange.count, M,
    'with no visibleFraction set yet, the new cloud should default to fully visible');
});

// Regression guard for the bug as originally measured: at a 0.35 visibleFraction
// floor (this project's minimum), the pre-fix mismatch was up to ~2.9x.
test('crossfadeTo peak mismatch is eliminated at the visibleFraction floor (0.35)', () => {
  const r = makeRenderer();
  const N = 250000;
  r.setCloud(new Float32Array(N * 3).fill(0.1), new Float32Array(N).fill(0.5));
  r.setVisibleFraction(0.35);
  const peakBeforeFade = r.toneMat.uniforms.uPeak.value;
  r.crossfadeTo(new Float32Array(N * 3).fill(0.2), new Float32Array(N).fill(0.5), 0.15);
  const ratio = r._peakTo / r._peakFrom;
  assert.ok(Math.abs(ratio - 1) < 0.05,
    `same point count, same visibleFraction should carry an almost-unchanged peak estimate (ratio ${ratio.toFixed(3)})`);
  assert.ok(Math.abs(r._peakFrom - peakBeforeFade) < 1e-6);
});
