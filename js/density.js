// GPU density pipeline: additive gaussian splats into a float target,
// then log-density tonemap through a palette LUT. Global THREE (r134).

const SPLAT_VERT = `
attribute float attrv;
attribute float aWeight;
varying float vAttr;
varying float vW;
uniform float uSize;
uniform float uTime, uFreq, uAmp;
uniform vec3 uDir;
void main() {
  vec3 p = position;
  float s = uAmp * sin(uFreq * dot(p, uDir) + 6.28318530718 * uTime);
  p += (p / max(length(p), 1e-6)) * s;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(0.1, -mv.z);
  vAttr = attrv;
  vW = aWeight;
}`;

const SPLAT_FRAG = `
precision highp float;
varying float vAttr;
varying float vW;
uniform float uWeight;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float w = exp(-r2 * 10.0) * uWeight * vW;
  gl_FragColor = vec4(w, w * vAttr, 0.0, 1.0);
}`;

const TONE_FRAG = `
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
}`;

const TONE_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class DensityRenderer {
  constructor(container) {
    this.container = container;
    this.fallback = false;
    this._dirty = true;
    this._rotY = 0; this._rotX = -0.2; this._zoom = 1;
    this._params = { exposure: 30, contrast: 1.0, grain: 1.0, background: [0.012, 0.016, 0.04], scale: 1, autoRotate: 0.3 };
    this._playing = false;
    this._loopPeriod = 8;
    this._motion = null;
    this._lastTick = 0;
    this._frameSink = null;
    this._initGL();
    this._initDrag();
    this._loop();
  }

  _size() {
    return [this.container.clientWidth || 800, this.container.clientHeight || 600];
  }

  // Per-cloud splat material. Copies current uniform values (size, motion,
  // phase) so a crossfade's incoming cloud moves in step with the outgoing.
  _makeSplatMat() {
    const src = this.splatMat ? this.splatMat.uniforms : null;
    return new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
      uniforms: {
        uSize: { value: src ? src.uSize.value : 3.0 },
        uTime: { value: src ? src.uTime.value : 0 },
        uFreq: { value: src ? src.uFreq.value : 5 },
        uAmp:  { value: src ? src.uAmp.value : 0 },
        uDir:  { value: src ? src.uDir.value.clone() : new THREE.Vector3(0, 1, 0) },
        uWeight: { value: 1 },
      },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
  }

  _splatMats() {
    return this._fading ? [this.splatMat, this._fading.mat] : [this.splatMat];
  }

  // Shared all-ones aWeight buffer (grown lazily) so non-grow clouds render
  // exactly as before the attribute existed.
  _unitWeights(n) {
    if (!this._unit || this._unit.length < n) this._unit = new Float32Array(n).fill(1);
    return this._unit.subarray(0, n);
  }

  _initGL() {
    const [w, h] = this._size();
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    this.camera.position.z = 3.2;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Capability probe: THREE r134 doesn't throw when a float render target is
    // unsupported — it just renders broken. Check the extensions ourselves
    // before attempting to create the target, keeping the try/catch as a
    // second net for anything the probe misses.
    const gl = this.renderer.getContext();
    const hasFloatSupport = this.renderer.capabilities.isWebGL2
      ? !!gl.getExtension('EXT_color_buffer_float')
      : !!(gl.getExtension('OES_texture_half_float') && gl.getExtension('EXT_color_buffer_half_float'));

    if (!hasFloatSupport) {
      this.fallback = true;
    } else {
      try {
        this.target = this._makeTarget(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio(), THREE.HalfFloatType);
        this.renderer.setRenderTarget(this.target);
        this.renderer.setRenderTarget(null);
      } catch (e) {
        this.fallback = true;
      }
    }

    this.splatMat = this._makeSplatMat();

    this.lutTex = new THREE.DataTexture(new Uint8Array(256 * 4).fill(255), 256, 1, THREE.RGBAFormat);
    this.lutTex.needsUpdate = true;

    this.toneScene = new THREE.Scene();
    this.toneCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.toneMat = new THREE.ShaderMaterial({
      vertexShader: TONE_VERT, fragmentShader: TONE_FRAG,
      uniforms: {
        tDensity: { value: this.target ? this.target.texture : null },
        tLUT: { value: this.lutTex },
        uExposure: { value: 30 }, uContrast: { value: 1.0 }, uPeak: { value: 60 },
        uTransparent: { value: 0 },
        uBackground: { value: new THREE.Vector3(0.012, 0.016, 0.04) },
      },
    });
    this.toneScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.toneMat));

    window.addEventListener('resize', () => this._onResize());
  }

  _makeTarget(w, h, type) {
    return new THREE.WebGLRenderTarget(Math.floor(w), Math.floor(h), {
      type, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _onResize() {
    const [w, h] = this._size();
    this._setAspect(w / h);
    this.camera.updateProjectionMatrix();
    this._applyViewOffset();
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    if (this.target) this.target.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this._dirty = true;
  }

  // Shift the projection so the design centres in the region NOT covered by
  // floating chrome (right control panel / bottom sheet). Pure camera offset —
  // no distortion, canvas stays full-bleed for the glass blur.
  setViewInset(right = 0, bottom = 0) {
    this._insetR = right;
    this._insetB = bottom;
    this._applyViewOffset();
    this._dirty = true;
  }

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

  _applyViewOffset() {
    const [w, h] = this._size();
    const r = this._insetR || 0, b = this._insetB || 0;
    if (r > 0 || b > 0) {
      // With a view offset, aspect must match the VIRTUAL canvas or the
      // sub-view is squeezed.
      this._setAspect((w + r) / (h + b));
      this.camera.setViewOffset(w + r, h + b, r, b, w, h);
    } else {
      if (this.camera.view) this.camera.clearViewOffset();
      this._setAspect(w / h);
    }
    // A bottom inset magnifies vertically by (h+b)/h; pull the camera back to
    // compensate, plus a touch extra so the design sits comfortably above the
    // sheet rather than clipping its edges.
    this._insetZoomOut = b > 0 ? ((h + b) / h) * 1.12 : 1;
    this.camera.updateProjectionMatrix();
  }

  setCloud(positions, attr) {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    this._paintPos = null; this._paintAttr = null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    // Peak estimate: average points per pixel in the covered region, ×concentration
    const n = positions.length / 3;
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }

  // ── Paint mode: one preallocated buffer painted incrementally ──
  // beginPaint allocates; writePaintPoints copies chunks in (streaming brush
  // appends AND remainder splices); setPaintCount reveals via drawRange.
  beginPaint(maxPoints) {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    this._paintPos = new Float32Array(maxPoints * 3);
    this._paintAttr = new Float32Array(maxPoints);
    const geo = new THREE.BufferGeometry();
    const posA = new THREE.BufferAttribute(this._paintPos, 3);
    const attrA = new THREE.BufferAttribute(this._paintAttr, 1);
    posA.setUsage(THREE.DynamicDrawUsage);
    attrA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posA);
    geo.setAttribute('attrv', attrA);
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(maxPoints), 1));
    geo.setDrawRange(0, 0);
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._paintDirty = null;
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }

  writePaintPoints(offset, positions, attr) {
    if (!this._paintPos) return;
    this._paintPos.set(positions, offset * 3);
    this._paintAttr.set(attr, offset);
    const end = offset + attr.length;
    this._paintDirty = this._paintDirty
      ? { min: Math.min(this._paintDirty.min, offset), max: Math.max(this._paintDirty.max, end) }
      : { min: offset, max: end };
    const geo = this.points.geometry;
    const posA = geo.getAttribute('position');
    const attrA = geo.getAttribute('attrv');
    posA.updateRange = { offset: this._paintDirty.min * 3, count: (this._paintDirty.max - this._paintDirty.min) * 3 };
    attrA.updateRange = { offset: this._paintDirty.min, count: this._paintDirty.max - this._paintDirty.min };
    posA.needsUpdate = true;
    attrA.needsUpdate = true;
    this._dirty = true;
  }

  setPaintCount(n) {
    if (!this.points) return;
    this.points.geometry.setDrawRange(0, n);
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._paintDirty = null; // consumed by the upcoming render
    this._dirty = true;
  }

  // Painted region as standalone copies (freeze/capture).
  getPaintSlice(n) {
    return {
      positions: this._paintPos ? this._paintPos.slice(0, n * 3) : new Float32Array(0),
      attr: this._paintAttr ? this._paintAttr.slice(0, n) : new Float32Array(0),
    };
  }

  setPalette(lutBytes) {
    this.lutTex.image.data.set(lutBytes);
    this.lutTex.needsUpdate = true;
    this._dirty = true;
  }

  setParams(p) {
    Object.assign(this._params, p);
    this.toneMat.uniforms.uExposure.value = this._params.exposure;
    this.toneMat.uniforms.uContrast.value = this._params.contrast;
    const bg = this._params.background;
    this.toneMat.uniforms.uBackground.value.set(bg[0], bg[1], bg[2]);
    for (const m of this._splatMats()) m.uniforms.uSize.value = 3.0 * this._params.grain;
    this.group.scale.setScalar(this._params.scale);
    this._dirty = true;
  }

  clear() {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points = null; }
    this._paintPos = null; this._paintAttr = null;
    this._dirty = true;
  }

  // ── Motion (seamless loop) — displacement mirrors js/motion.js ──
  setMotion(mp) {
    this._motion = mp;
    for (const m of this._splatMats()) {
      m.uniforms.uDir.value.set(mp.dir[0], mp.dir[1], mp.dir[2]);
      m.uniforms.uFreq.value = mp.freq;
      if (m.uniforms.uAmp.value > 0) m.uniforms.uAmp.value = mp.amp;
    }
    this._dirty = true;
  }
  activateMotion() {
    if (this._motion) {
      for (const m of this._splatMats()) m.uniforms.uAmp.value = this._motion.amp;
    }
    this._dirty = true;
  }
  setPlaying(on) {
    this._playing = !!on;
    if (on) this.activateMotion();
    this._dirty = true;
  }
  setLoopPeriod(sec) { this._loopPeriod = Math.max(1, sec); }
  setFrameSink(cb) { this._frameSink = cb; }
  get canvas() { return this.renderer.domElement; }
  setLoopPhase(t) {
    const v = t - Math.floor(t);
    for (const m of this._splatMats()) m.uniforms.uTime.value = v;
    this._dirty = true;
  }
  getLoopPhase() { return this.splatMat.uniforms.uTime.value; }
  getActiveMotion() { return this.splatMat.uniforms.uAmp.value > 0 ? this._motion : null; }

  // Live drive: direct wave amplitude/frequency, bypassing motionParams.
  setWave(amp, freq) {
    for (const m of this._splatMats()) {
      m.uniforms.uAmp.value = amp;
      m.uniforms.uFreq.value = freq;
    }
    this._dirty = true;
  }

  // Dissolve the current cloud into a new one over dur seconds.
  crossfadeTo(positions, attr, dur = 1.0) {
    if (!this.points || this.fallback) { this.setCloud(positions, attr); return; }
    this._disposeFading();                       // a still-running fade completes instantly
    this._fading = { points: this.points, mat: this.points.material, t: 0, dur };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
    const mat = this._makeSplatMat();
    mat.uniforms.uWeight.value = 0;
    this.splatMat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._peakFrom = this.toneMat.uniforms.uPeak.value;
    const n = positions.length / 3;
    const [w, h] = this._size();
    this._peakTo = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
  }

  _disposeFading() {
    if (!this._fading) return;
    this.group.remove(this._fading.points);
    this._fading.points.geometry.dispose();
    this._fading.mat.dispose();
    this._fading = null;
    if (this.points) this.points.material.uniforms.uWeight.value = 1;
    if (this._peakTo !== undefined) this.toneMat.uniforms.uPeak.value = this._peakTo;
  }

  requestRender() { this._dirty = true; }

  getMVP() {
    // Exports must be centred: compute the matrix with the chrome view-offset
    // cleared, then restore it for on-screen rendering.
    const hadOffset = !!(this.camera.view && this.camera.view.enabled);
    if (hadOffset) {
      this.camera.clearViewOffset();
      const [vw, vh] = this._size();
      this._setAspect(vw / vh);
      this.camera.updateProjectionMatrix();
    }
    this.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);
    if (hadOffset) this._applyViewOffset();
    return mvp;
  }

  _renderFrame(target = null) {
    if (this.camera.isOrthographicCamera) {
      // Ortho scale comes from the frustum, not distance: map zoom to camera.zoom.
      this.camera.zoom = this._zoom / (this._insetZoomOut || 1);
      this.camera.updateProjectionMatrix();
      this.camera.position.z = 3.2;
    } else {
      this.camera.position.z = (3.2 / this._zoom) * (this._insetZoomOut || 1);
    }
    this.group.rotation.set(this._rotX, this._rotY, 0);
    if (this.fallback || !this.points) {
      this.renderer.setClearColor(new THREE.Color(...this._params.background), 1);
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      return;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.toneScene, this.toneCam);
    this.renderer.setRenderTarget(null);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    if (this._params.autoRotate > 0 && this.points) {
      this._rotY += this._params.autoRotate * 0.004;
      this._dirty = true;
    }
    if (this._playing) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, this._lastTick ? now - this._lastTick : 0);
      this._lastTick = now;
      this.setLoopPhase(this.splatMat.uniforms.uTime.value + dt / this._loopPeriod);
    } else {
      this._lastTick = 0;
    }
    if (this._fading) {
      const nowF = performance.now() / 1000;
      const dtF = Math.min(0.1, this._fadeTick ? nowF - this._fadeTick : 0.016);
      this._fadeTick = nowF;
      this._fading.t += dtF;
      const k = Math.min(1, this._fading.t / this._fading.dur);
      this._fading.mat.uniforms.uWeight.value = 1 - k;
      this.splatMat.uniforms.uWeight.value = k;
      this.toneMat.uniforms.uPeak.value = this._peakFrom + (this._peakTo - this._peakFrom) * k;
      this._dirty = true;
      if (k >= 1) this._disposeFading();
    } else {
      this._fadeTick = 0;
    }
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
    // Post-render hook (live video recording): the WebGL buffer is only
    // valid in the same task as the draw, so capture must happen here.
    if (this._frameSink) this._frameSink(performance.now());
  }

  // Hi-res export: render both passes into an offscreen RGBA8 target and read back.
  renderHiRes(scaleFactor = 3, { transparent = false } = {}) {
    this.exportNote = null;
    const [w, h] = this._size();
    const maxTex = this.renderer.capabilities.maxTextureSize || 8192;
    let W = Math.floor(w * scaleFactor), H = Math.floor(h * scaleFactor);
    if (Math.max(W, H) > maxTex) {
      const clamp = maxTex / Math.max(w, h);
      W = Math.floor(w * clamp); H = Math.floor(h * clamp);
      this.exportNote = `Requested size exceeds this GPU (max ${maxTex}px) — exported at ${Math.max(W, H)}px`;
    }
    // Exports are centred: drop the chrome view-offset for the export render.
    const hadOffset = !!(this.camera.view && this.camera.view.enabled);
    const savedInsetZoom = this._insetZoomOut;
    if (hadOffset) {
      this.camera.clearViewOffset();
      this._setAspect(w / h);
      this.camera.updateProjectionMatrix();
      this._insetZoomOut = 1;
    }
    let bigDensity = null, bigOut = null;
    for (;;) {
      try {
        bigDensity = this.fallback ? null : this._makeTarget(W, H, THREE.HalfFloatType);
        bigOut = this._makeTarget(W, H, THREE.UnsignedByteType);
        break;
      } catch (e) {
        if (bigDensity) { bigDensity.dispose(); bigDensity = null; }
        if (Math.max(W, H) <= 2000) throw e;
        W = Math.floor(W / 2); H = Math.floor(H / 2);
        this.exportNote = `High-res allocation failed — exported at ${Math.max(W, H)}px`;
      }
    }
    if (transparent && !this.fallback) this.toneMat.uniforms.uTransparent.value = 1;
    const effScale = W / Math.max(1, w);
    const savedTarget = this.target;
    if (bigDensity) {
      this.target = bigDensity;
      this.toneMat.uniforms.tDensity.value = bigDensity.texture;
      // splat count per pixel drops with area → compensate peak
      const savedPeak = this.toneMat.uniforms.uPeak.value;
      this.toneMat.uniforms.uPeak.value = savedPeak / (effScale * effScale);
      const savedSize = this.splatMat.uniforms.uSize.value;
      for (const m of this._splatMats()) m.uniforms.uSize.value = savedSize * effScale;
      this._renderFrame(bigOut);
      this.toneMat.uniforms.uPeak.value = savedPeak;
      for (const m of this._splatMats()) m.uniforms.uSize.value = savedSize;
    } else {
      this._renderFrame(bigOut);
    }
    this.toneMat.uniforms.uTransparent.value = 0;
    const pixels = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(bigOut, 0, 0, W, H, pixels);
    this.target = savedTarget;
    if (this.target) this.toneMat.uniforms.tDensity.value = this.target.texture;
    if (bigDensity) bigDensity.dispose();
    bigOut.dispose();
    if (hadOffset) { this._insetZoomOut = savedInsetZoom; this._applyViewOffset(); }
    // Flip Y into a 2D canvas
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      img.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    this._dirty = true;
    return canvas;
  }

  _initDrag() {
    const el = this.renderer.domElement;
    let down = false, ox = 0, oy = 0, pinch0 = 0;
    const start = (x, y) => { down = true; ox = x; oy = y; };
    const move = (x, y) => {
      if (!down) return;
      this._rotY += (x - ox) * 0.007;
      this._rotX += (y - oy) * 0.005;
      ox = x; oy = y;
      this._dirty = true;
    };
    el.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => { down = false; });
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        down = false;
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', e => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this._zoom = Math.max(0.3, Math.min(4, this._zoom * (d / (pinch0 || d))));
        pinch0 = d;
        this._dirty = true;
      }
    });
    window.addEventListener('touchend', () => { down = false; });
    el.addEventListener('wheel', e => {
      this._zoom = Math.max(0.3, Math.min(4, this._zoom * (1 - e.deltaY * 0.001)));
      this._dirty = true;
      e.preventDefault();
    }, { passive: false });
  }

  dispose() { this.renderer.dispose(); }
}
