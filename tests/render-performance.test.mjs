import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPerformance } from '../public/render-performance.mjs';
test('automatic quality starts light, upgrades only after sustained headroom, and drops when drawing gets costly', () => {
  const monitor = new RenderPerformance();
  assert.equal(monitor.quality, 'light');
  for (let t = 0; t <= 10000; t += 1000 / 60) monitor.record(t, 3);
  assert.equal(monitor.fps, 60); assert.equal(monitor.renderMs, 3); assert.equal(monitor.quality, 'high');
  for (let t = 10020; t <= 11500; t += 30) monitor.record(t, 18);
  assert.equal(monitor.quality, 'light'); assert.ok(monitor.fps < 42);
});
test('explicit quality is respected and background gaps do not become low FPS measurements', () => {
  const monitor = new RenderPerformance(); monitor.setMode('high');
  for (let t = 0; t < 1200; t += 50) monitor.record(t, 40);
  assert.equal(monitor.quality, 'high'); assert.equal(monitor.fps, 20);
  monitor.record(10000, 3);
  for (let t = 10016; t < 10600; t += 16) monitor.record(t, 3);
  assert.ok(monitor.fps >= 60); assert.equal(monitor.quality, 'high');
  monitor.setMode('light'); assert.equal(monitor.quality, 'light');
});
