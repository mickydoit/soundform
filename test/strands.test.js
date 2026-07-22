import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStrand, rdp, toBezierPath, buildDensityGrid,
         simplifyToBudget, buildVectorPaths,
         catmullRomToBezier, toRelativeBezierLegs, buildPdfOps } from '../js/strands.js';

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

test('simplifyToBudget never drops a strand, even a very dense one', () => {
  // Amplitude-2 zigzag: at epsilon 1.4 nearly every point survives (>500).
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push([i * 0.1, (i % 2) * 2]);
  const out = simplifyToBudget(pts, 1.4, 500);
  assert.ok(out.length >= 2, 'strand must never vanish');
  assert.ok(out.length <= 500, `expected <=500, got ${out.length}`);
});

test('simplifyToBudget leaves an already-small strand under budget alone at eps0', () => {
  const pts = [[0, 0], [10, 0.01], [20, 0], [30, 5], [40, 0]];
  assert.deepEqual(simplifyToBudget(pts, 1.4, 500), rdp(pts, 1.4));
});

test('buildVectorPaths keeps a strand that used to exceed the old 300-point drop cap', () => {
  // Jittered loop whose eps=1.4 simplification lands at 384 points (verified
  // via rdp directly) — solidly between the old 300 drop cap and the 500 budget.
  const n = 6000;
  const strand = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const jitter = Math.sin(t * 1200) * 0.008;
    strand[i * 3] = Math.cos(t * 6) * 0.6 + jitter;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 6) * 0.6 + jitter;
  }
  const items = buildVectorPaths({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 1600, height: 1200, stops: [[0, '#000000'], [1, '#ffffff']], weight: 1 });
  assert.equal(items.length, 1, 'the strand must appear, not be dropped');
  assert.ok(items[0].points.length >= 2);
  assert.ok(items[0].points.length > 300, 'sanity check: this fixture must actually exceed the old drop cap');
});

test('buildVectorPaths resolves colors and geometry per strand', () => {
  const strand = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    strand[i * 3] = Math.cos(t * 6) * 0.6;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const items = buildVectorPaths({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#050614'], [1, '#ffffff']], weight: 2 });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.match(it.c1, /^#[0-9a-f]{6}$/);
  assert.match(it.c2, /^#[0-9a-f]{6}$/);
  assert.ok(it.strokeWidth > 0);
  assert.ok(it.opacity > 0 && it.opacity <= 1);
  assert.equal(it.x1, it.points[0][0]);
  assert.equal(it.y2, it.points[it.points.length - 1][1]);
});

test('buildPdfOps produces jsPDF-ready ops with no DOM/jsPDF dependency', () => {
  const strand = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    strand[i * 3] = Math.cos(t * 6) * 0.6;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const ops = buildPdfOps({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#050614'], [1, '#ffffff']], weight: 2, background: '#03040a' });
  assert.equal(ops.width, 800);
  assert.equal(ops.background, '#03040a');
  assert.equal(ops.strokes.length, 1);
  const stroke = ops.strokes[0];
  assert.ok(stroke.strokeWidth > 0);
  assert.ok(stroke.runs.length > 0);
  stroke.runs.forEach((run) => {
    assert.equal(run.start.length, 2);
    assert.match(run.color, /^#[0-9a-f]{6}$/);
    run.legs.forEach((leg) => assert.equal(leg.length, 6));
  });
});

test('buildPdfOps run colors interpolate from c1 toward c2 along the stroke', () => {
  const strand = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const t = i / 599;
    strand[i * 3] = t * 1.2 - 0.6;
    strand[i * 3 + 1] = Math.sin(t * 3) * 0.4;
    strand[i * 3 + 2] = 0;
  }
  const ops = buildPdfOps({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#000000'], [1, '#ffffff']], weight: 1, background: null });
  const runs = ops.strokes[0].runs;
  assert.ok(runs.length > 1, 'fixture must produce multiple runs to test interpolation');
  assert.equal(ops.background, null);
  const firstGray = parseInt(runs[0].color.slice(1, 3), 16);
  const lastGray = parseInt(runs[runs.length - 1].color.slice(1, 3), 16);
  assert.ok(lastGray >= firstGray, 'color should trend from c1 toward c2 along the stroke');
});

test('toBezierPath output is unchanged after the catmullRomToBezier refactor', () => {
  const pts = [[0, 0], [10, 10], [20, 0], [30, 10], [40, -5]];
  assert.equal(
    toBezierPath(pts),
    'M0 0C1.7 1.7 6.7 10 10 10C13.3 10 16.7 0 20 0C23.3 0 26.7 10.8 30 10C33.3 9.2 38.3 -2.5 40 -5'
  );
});

test('catmullRomToBezier + toRelativeBezierLegs round-trips to the same absolute points', () => {
  const pts = [[5, 5], [12, -3], [20, 8], [31, 2], [40, 15]];
  const segs = catmullRomToBezier(pts);
  const legs = toRelativeBezierLegs(pts[0], segs);
  let cx = pts[0][0], cy = pts[0][1];
  const reconstructedEnds = [];
  for (const [dx1, dy1, dx2, dy2, dx3, dy3] of legs) {
    const x1 = cx + dx1, y1 = cy + dy1;
    const x2 = x1 + dx2, y2 = y1 + dy2;
    const x3 = x2 + dx3, y3 = y2 + dy3;
    reconstructedEnds.push([x3, y3]);
    cx = x3; cy = y3;
  }
  segs.forEach((seg, i) => {
    assert.ok(Math.abs(reconstructedEnds[i][0] - seg.end[0]) < 1e-9);
    assert.ok(Math.abs(reconstructedEnds[i][1] - seg.end[1]) < 1e-9);
  });
});
