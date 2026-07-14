// GPU density pipeline: additive gaussian splats into a float target,
// then log-density tonemap through a palette LUT. Global THREE (r134).

const SPLAT_VERT = `
attribute float attrv;
varying float vAttr;
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
}`;

const SPLAT_FRAG = `
precision highp float;
varying float vAttr;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float w = exp(-r2 * 10.0);
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
    this._initGL();
    this._initDrag();
    this._loop();
  }

  _size() {
    return [this.container.clientWidth || 800, this.container.clientHeight || 600];
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

    this.splatMat = new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
      uniforms: {
        uSize: { value: 3.0 },
        uTime: { value: 0 }, uFreq: { value: 5 }, uAmp: { value: 0 },
        uDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });

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
    this.camera.aspect = w / h;
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

  _applyViewOffset() {
    const [w, h] = this._size();
    const r = this._insetR || 0, b = this._insetB || 0;
    if (r > 0 || b > 0) {
      // With a view offset, aspect must match the VIRTUAL canvas or the
      // sub-view is squeezed.
      this.camera.aspect = (w + r) / (h + b);
      this.camera.setViewOffset(w + r, h + b, r, b, w, h);
    } else {
      if (this.camera.view) this.camera.clearViewOffset();
      this.camera.aspect = w / h;
    }
    // A bottom inset magnifies vertically by (h+b)/h; pull the camera back to
    // compensate, plus a touch extra so the design sits comfortably above the
    // sheet rather than clipping its edges.
    this._insetZoomOut = b > 0 ? ((h + b) / h) * 1.12 : 1;
    this.camera.updateProjectionMatrix();
  }

  setCloud(positions, attr) {
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
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
    this.splatMat.uniforms.uSize.value = 3.0 * this._params.grain;
    this.group.scale.setScalar(this._params.scale);
    this._dirty = true;
  }

  clear() {
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points = null; }
    this._dirty = true;
  }

  // ── Motion (seamless loop) — displacement mirrors js/motion.js ──
  setMotion(mp) {
    this._motion = mp;
    this.splatMat.uniforms.uDir.value.set(mp.dir[0], mp.dir[1], mp.dir[2]);
    this.splatMat.uniforms.uFreq.value = mp.freq;
    if (this.splatMat.uniforms.uAmp.value > 0) this.splatMat.uniforms.uAmp.value = mp.amp;
    this._dirty = true;
  }
  activateMotion() {
    if (this._motion) this.splatMat.uniforms.uAmp.value = this._motion.amp;
    this._dirty = true;
  }
  setPlaying(on) {
    this._playing = !!on;
    if (on) this.activateMotion();
    this._dirty = true;
  }
  setLoopPeriod(sec) { this._loopPeriod = Math.max(1, sec); }
  setLoopPhase(t) { this.splatMat.uniforms.uTime.value = t - Math.floor(t); this._dirty = true; }
  getLoopPhase() { return this.splatMat.uniforms.uTime.value; }
  getActiveMotion() { return this.splatMat.uniforms.uAmp.value > 0 ? this._motion : null; }

  requestRender() { this._dirty = true; }

  getMVP() {
    // Exports must be centred: compute the matrix with the chrome view-offset
    // cleared, then restore it for on-screen rendering.
    const hadOffset = !!(this.camera.view && this.camera.view.enabled);
    if (hadOffset) {
      this.camera.clearViewOffset();
      const [vw, vh] = this._size();
      this.camera.aspect = vw / vh;
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
    this.camera.position.z = (3.2 / this._zoom) * (this._insetZoomOut || 1);
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
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
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
      this.camera.aspect = w / h;
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
      this.splatMat.uniforms.uSize.value = savedSize * effScale;
      this._renderFrame(bigOut);
      this.toneMat.uniforms.uPeak.value = savedPeak;
      this.splatMat.uniforms.uSize.value = savedSize;
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
