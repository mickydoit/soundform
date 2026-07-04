import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStrandSVG } from '../js/exporter.js';

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
