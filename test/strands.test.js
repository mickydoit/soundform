import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStrand, rdp, toBezierPath, buildDensityGrid } from '../js/strands.js';

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

test('projectStrand maps clip space to pixels', () => {
  const strand = new Float32Array([0, 0, 0, 0.5, 0.5, 0]);
  const { pts } = projectStrand(strand, IDENTITY, 100, 100);
  assert.deepEqual(pts[0], [50, 50]);
  assert.deepEqual(pts[1], [75, 25]); // y flips
});

test('rdp keeps endpoints, drops collinear points', () => {
  const line = [[0, 0], [1, 0.001], [2, 0], [3, 5], [4, 0]];
  const out = rdp(line, 0.5);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [4, 0]);
  assert.ok(out.length < line.length);
  assert.ok(out.some(p => p[1] === 5)); // keeps the spike
});

test('toBezierPath emits M + C commands', () => {
  const d = toBezierPath([[0, 0], [10, 10], [20, 0], [30, 10]]);
  assert.ok(d.startsWith('M'));
  assert.ok(d.includes('C'));
});

test('density grid: dense region samples higher than empty', () => {
  const pos = new Float32Array(3000);
  for (let i = 0; i < 1000; i++) { // cluster at origin
    pos[i * 3] = (i % 10) * 0.01; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
  }
  const g = buildDensityGrid(pos, 16);
  assert.ok(g.sample(0.05, 0, 0) > g.sample(0.9, 0.9, 0.9));
});
