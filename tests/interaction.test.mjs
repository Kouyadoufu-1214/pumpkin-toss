import test from 'node:test';
import assert from 'node:assert/strict';
import { GrabGesture, isPinched, chooseFace } from '../public/interaction.mjs';

function hand(gap, scale = 1) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  points[5] = { x: .5, y: .5 }; points[17] = { x: .5 + .2 * scale, y: .5 };
  points[4] = { x: .5, y: .3 }; points[8] = { x: .5 + gap * .2 * scale, y: .3 };
  return points;
}
test('pinch stays stable at different camera distances and has hysteresis', () => {
  for (const scale of [.5, 1, 1.5]) {
    assert.equal(isPinched(hand(.3, scale)), true);
    assert.equal(isPinched(hand(.55, scale)), false);
    assert.equal(isPinched(hand(.55, scale), true), true);
    assert.equal(isPinched(hand(.8, scale), true), false);
  }
});
test('a stationary pinch and release does not accidentally throw', () => {
  const gesture = new GrabGesture(); gesture.begin({ x: 100, y: 100 }, 0);
  gesture.move({ x: 104, y: 103 }, 200);
  assert.equal(gesture.release({ x: 100, y: 101 }, 300), false);
});
test('slowly repositioning the pumpkin does not throw it', () => {
  const gesture = new GrabGesture(); gesture.begin({ x: 100, y: 100 }, 0);
  gesture.move({ x: 300, y: 100 }, 1900);
  assert.equal(gesture.release({ x: 304, y: 100 }, 2000), false);
});
test('a deliberate flick followed by release throws', () => {
  const gesture = new GrabGesture(); gesture.begin({ x: 100, y: 200 }, 0);
  gesture.move({ x: 120, y: 190 }, 100);
  gesture.move({ x: 190, y: 150 }, 170);
  assert.equal(gesture.release({ x: 235, y: 115 }, 210), true);
  assert.equal(gesture.active, false);
});
test('tracking loss cancels a grab without a throw', () => {
  const gesture = new GrabGesture(); gesture.begin({ x: 100, y: 200 }, 0);
  gesture.move({ x: 220, y: 100 }, 110); gesture.reset();
  assert.equal(gesture.release({ x: 350, y: 20 }, 160), false);
});
test('receiver selection is independent of model result order', () => {
  const left = { x: 150 }, right = { x: 700 };
  assert.equal(chooseFace([right, left], 'left'), left);
  assert.equal(chooseFace([left, right], 'right'), right);
  assert.equal(chooseFace([left], 'right'), left);
  assert.equal(chooseFace([], 'left'), null);
});
