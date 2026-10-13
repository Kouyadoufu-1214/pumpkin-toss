import test from 'node:test';
import assert from 'node:assert/strict';
import { FreehandStroke, outlineInfo, smoothPath, resamplePath } from '../public/carving-path.mjs';

const circle = (count = 64, gap = 0) => Array.from({ length: count + 1 }, (_, i) => {
  const angle = i / count * (Math.PI * 2 - gap);
  return { x: 200 + Math.cos(angle) * 45, y: 240 + Math.sin(angle) * 35 };
});
function finish(points, options) { const stroke = new FreehandStroke(); points.forEach(p => stroke.add(p)); return stroke.finish(options); }

test('a nearly closed hand-drawn eye becomes a filled outline, without requiring exact closure', () => {
  const result = finish(circle(64, .18));
  assert.equal(result.kind, 'cut'); assert.equal(result.closed, true);
  assert.ok(outlineInfo(result.points).area > 4000);
});
test('an open outline and a pinching wobble do not cut an unexpected filled region', () => {
  assert.equal(finish(circle(64, 1.5)).kind, 'open');
  assert.equal(finish([{ x: 200, y: 200 }, { x: 203, y: 204 }, { x: 201, y: 201 }]).kind, 'small');
});
test('line mode preserves an open smile and its endpoints', () => {
  const points = circle(30, Math.PI);
  const result = finish(points, { mode: 'line', smoothing: 3 });
  assert.equal(result.kind, 'cut'); assert.equal(result.closed, false);
  assert.deepEqual(result.points[0], points[0]); assert.deepEqual(result.points.at(-1), points.at(-1));
});
test('spatial smoothing reduces tremor without moving a straight line or its endpoints', () => {
  const noisy = Array.from({ length: 101 }, (_, i) => ({ x: 100 + i * 2, y: 200 + (i % 2 ? 5 : -5) }));
  const result = smoothPath(noisy, 3);
  const middle = result.filter(p => p.x > 120 && p.x < 280);
  assert.ok(middle.reduce((sum, p) => sum + Math.abs(p.y - 200), 0) / middle.length < 1.5);
  assert.deepEqual(result[0], noisy[0]); assert.deepEqual(result.at(-1), noisy.at(-1));
  const straight = smoothPath([{ x: 10, y: 20 }, { x: 70, y: 20 }]);
  assert.ok(straight.every(p => p.y === 20));
});
test('pausing or adding extra samples does not change the smoothed shape', () => {
  const sparse = [{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 70 }];
  const dense = resamplePath(sparse, 1).flatMap(p => [p, p, p]);
  assert.deepEqual(smoothPath(sparse), smoothPath(dense));
});
test('tracking loss or a position jump cancels the whole draft until release', () => {
  for (const invalid of [null, { x: NaN, y: 20 }, { x: 513, y: 230 }, { x: 490, y: 490 }]) {
    const stroke = new FreehandStroke(); circle().slice(0, 30).forEach(p => stroke.add(p));
    assert.equal(stroke.add(invalid), false);
    circle().forEach(p => stroke.add(p));
    assert.equal(stroke.finish().kind, 'interrupted');
    stroke.reset(); circle().forEach(p => stroke.add(p)); assert.equal(stroke.finish().kind, 'cut');
  }
});
test('smoothing very short paths stays finite, including cyclic paths', () => {
  for (const points of [[], [{ x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 4 }]]) {
    assert.ok(smoothPath(points, 3, true).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});
