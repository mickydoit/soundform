import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStrandSVG, framePlan, loopsForDuration } from '../js/exporter.js';

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function fixture() {
  const strands = [];
  for (let s = 0; s < 48; s++) {
    const st = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      const t = i / 199;
      st[i * 3] = Math.cos(t * 6 + s) * 0.6;
      st[i * 3 + 1] = (t - 0.5) * 1.4;
      st[i * 3 + 2] = Math.sin(t * 6 + s) * 0.6;
    }
    strands.push(st);
  }
  const positions = new Float32Array(30000);
  for (let i = 0; i < 10000; i++) {
    positions[i * 3] = Math.cos(i) * 0.6; positions[i * 3 + 1] = (i / 10000 - 0.5); positions[i * 3 + 2] = Math.sin(i) * 0.6;
  }
  return { strands, positions, mvp: IDENTITY, width: 1600, height: 1200,
           stops: [[0, '#050614'], [0.5, '#9d5bd2'], [1, '#ffffff']], background: '#03040a', weight: 1 };
}

test('exportStrandSVG: valid structure, named editable groups', () => {
  const svg = exportStrandSVG(fixture());
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('id="strand-01"'));
  assert.ok(svg.includes('id="strand-48"'));
  assert.ok(svg.includes('<path'));
  assert.ok(svg.includes('linearGradient'));
  assert.ok(!svg.includes('<circle')); // no dot spam
});

test('exportStrandSVG: under 1MB budget', () => {
  const svg = exportStrandSVG(fixture());
  assert.ok(svg.length < 1_000_000, `size ${svg.length}`);
});

test('exportStrandSVG: deterministic', () => {
  assert.equal(exportStrandSVG(fixture()), exportStrandSVG(fixture()));
});

test('framePlan: whole loop, phase wraps to zero, never reaches 1', () => {
  const p = framePlan(8, 30);
  assert.equal(p.frames, 240);
  assert.equal(p.fps, 30);
  assert.equal(p.phase(0), 0);
  assert.equal(p.phase(p.frames), 0, 'frame N wraps to frame 0 — seamless');
  assert.ok(p.phase(p.frames - 1) < 1);
  for (let i = 1; i < p.frames; i++) assert.ok(p.phase(i) > p.phase(i - 1));
});

test('framePlan: minimum two frames', () => {
  assert.ok(framePlan(0.01, 30).frames >= 2);
});

test('loopsForDuration: rounds to whole loops, min 1, 0 means one loop', () => {
  assert.equal(loopsForDuration(0, 8), 1);
  assert.equal(loopsForDuration(undefined, 8), 1);
  assert.equal(loopsForDuration(5, 8), 1);
  assert.equal(loopsForDuration(10, 4), 3);
  assert.equal(loopsForDuration(30, 8), 4);
  assert.equal(loopsForDuration(60, 8), 8);
});

test('exportStrandSVG: null background omits the rect, keeps paths', () => {
  const { strands, positions } = fixture();
  const svg = exportStrandSVG({ strands, positions, mvp: IDENTITY, width: 800, height: 600,
    stops: [[0, '#000000'], [1, '#ffffff']], background: null, weight: 1 });
  assert.ok(!svg.includes('id="background"'), 'background rect must be absent');
  assert.ok(svg.includes('<path'), 'paths must remain');
});

test('exportStrandSVG: a strand that used to exceed the 300-point drop cap still appears', () => {
  // Jittered loop whose eps=1.4 simplification lands at 384 points — solidly
  // between the old 300 drop cap and the new 500 budget.
  const n = 6000;
  const st = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const jitter = Math.sin(t * 1200) * 0.008;
    st[i * 3] = Math.cos(t * 6) * 0.6 + jitter;
    st[i * 3 + 1] = (t - 0.5) * 1.4;
    st[i * 3 + 2] = Math.sin(t * 6) * 0.6 + jitter;
  }
  const svg = exportStrandSVG({ strands: [st], positions: st, mvp: IDENTITY, width: 1600, height: 1200,
    stops: [[0, '#050614'], [1, '#ffffff']], background: '#03040a', weight: 1 });
  assert.ok(svg.includes('id="strand-01"'), 'the dense strand must not be dropped');
  assert.ok(svg.includes('<path'));
});
