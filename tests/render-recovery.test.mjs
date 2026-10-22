import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const experience = readFileSync(new URL('../public/experience.mjs', import.meta.url), 'utf8');
function productionSection(from, to) {
  const start = experience.indexOf(from), end = experience.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `production code is available: ${from}`);
  return experience.slice(start, end);
}
const pose = { x: 640, y: 422, w: 530, h: 480 };

// Only the renderer and browser boundaries are replaced. These are the actual
// display and carving functions, so a fallback must affect both consistently.
function recoveryHarness({ draw = () => true, cleanupFails = false } = {}) {
  const calls = { draw: 0, mask: 0, fallback: 0, raycast: 0, dispose: 0, warn: 0 };
  const status = { textContent: '3D PUMPKIN' }, maskCanvas = {}, strokes = [], copiedImages = [];
  const art = {
    canvas: maskCanvas, changed: true, options: { mode: 'scrape' },
    stroke(hit) { strokes.push(hit); return true; },
  };
  const renderer = {
    draw() { calls.draw++; return draw(); },
    updateMask() { calls.mask++; },
    dispose() { calls.dispose++; if (cleanupFails) throw new Error('cleanup failed'); },
    hit() { calls.raycast++; return { x: 123, y: 456 }; },
  };
  const c = {
    save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, fill() {},
    ellipse() { calls.fallback++; },
    drawImage(image) { copiedImages.push(image); },
  };
  const context = vm.createContext({
    pumpkin: renderer, pumpkin3DVisible: false, art, c, $: () => status,
    line() {}, carvingFeedback() {}, shapeScale: () => [1, 1],
    console: { warn() { calls.warn++; } },
  });
  vm.runInContext(productionSection('function drawPumpkin(', 'function handCursor('), context);
  vm.runInContext(productionSection('const carvingPose =', 'function carvingFeedback('), context);
  return {
    context, calls, status, art, maskCanvas, strokes, copiedImages, renderer,
    draw: () => context.drawPumpkin(pose),
    carve: point => context.carveAt(point),
  };
}

test('a false 3D draw shows the same artwork in 2D and returns to 3D after recovery', () => {
  let healthy = true;
  const h = recoveryHarness({ draw: () => healthy });
  h.draw();
  assert.equal(h.context.pumpkin3DVisible, true);
  assert.equal(h.calls.fallback, 0);
  healthy = false;
  h.draw();
  assert.equal(h.context.pumpkin3DVisible, false);
  assert.equal(h.status.textContent, '簡易表示');
  assert.equal(h.calls.fallback, 1);
  assert.equal(h.copiedImages[0], h.maskCanvas);
  assert.equal(h.context.pumpkin, h.renderer, 'temporary failure must retain the renderer for recovery');
  assert.equal(h.calls.dispose, 0);

  // New carving while in 2D is still delivered to the recovering renderer.
  h.art.changed = true;
  h.draw();
  assert.equal(h.calls.mask, 2);
  healthy = true;
  h.draw();
  assert.equal(h.context.pumpkin3DVisible, true);
  assert.equal(h.status.textContent, '3D PUMPKIN');
  assert.equal(h.calls.fallback, 2);
  assert.equal(h.calls.warn, 0);
  assert.equal(h.art.canvas, h.maskCanvas);
});

test('a drawing exception disables the renderer once and later frames continue drawing the saved mask', () => {
  const h = recoveryHarness({ draw: () => { throw new Error('drawing failed'); } });
  h.draw(); h.draw(); h.draw();
  assert.equal(h.context.pumpkin, null);
  assert.equal(h.context.pumpkin3DVisible, false);
  assert.equal(h.status.textContent, '簡易表示');
  assert.equal(h.calls.draw, 1);
  assert.equal(h.calls.warn, 1);
  assert.equal(h.calls.dispose, 1);
  assert.equal(h.calls.fallback, 3);
  assert.equal(h.copiedImages.length, 3);
  assert.ok(h.copiedImages.every(image => image === h.maskCanvas));
});

test('renderer cleanup failure cannot prevent fallback drawing or further carving', () => {
  const h = recoveryHarness({ draw: () => { throw new Error('drawing failed'); }, cleanupFails: true });
  assert.doesNotThrow(() => { h.draw(); h.draw(); h.carve({ x: 640, y: 422 }); });
  assert.equal(h.context.pumpkin, null);
  assert.equal(h.calls.warn, 1);
  assert.equal(h.calls.dispose, 1);
  assert.equal(h.calls.fallback, 2);
  assert.equal(h.calls.raycast, 0);
  assert.equal(h.strokes[0].x, 256);
  assert.equal(h.strokes[0].y, 256);
  assert.equal(h.art.canvas, h.maskCanvas);
});

test('carving uses the displayed 2D coordinates until a successful 3D draw enables raycasting', () => {
  let healthy = false;
  const h = recoveryHarness({ draw: () => healthy });
  const point = { x: pose.x + pose.w * .19, y: pose.y - pose.h * .19 };
  h.draw(); h.carve(point);
  assert.equal(h.calls.raycast, 0);
  assert.ok(Math.abs(h.strokes[0].x - 384) < 1e-9);
  assert.ok(Math.abs(h.strokes[0].y - 128) < 1e-9);
  healthy = true;
  h.draw(); h.carve(point);
  assert.equal(h.calls.raycast, 1);
  assert.equal(h.strokes[1].x, 123);
  assert.equal(h.strokes[1].y, 456);
  healthy = false;
  h.draw(); h.carve(point);
  assert.equal(h.calls.raycast, 1, 'a later context loss must switch carving back to 2D');
  assert.ok(Math.abs(h.strokes[2].x - 384) < 1e-9);
  assert.ok(Math.abs(h.strokes[2].y - 128) < 1e-9);
});
