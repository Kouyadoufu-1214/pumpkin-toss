import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceRate } from '../public/inference-rate.mjs';

test('completion rate warms up for 500 ms and counts intervals rather than samples', () => {
  const rate = new InferenceRate();
  assert.equal(rate.fps, 0);
  for (const time of [0, 100, 200, 300, 400, 499]) assert.equal(rate.record(time), 0);
  assert.equal(rate.record(500), 12, 'six completed intervals span 500 ms');
  rate.reset();
  for (let time = 0; time <= 1000; time += 50) rate.record(time);
  assert.equal(rate.fps, 20);
});

test('rolling measurements replace old speed and retain the interval crossing the window', () => {
  const rate = new InferenceRate();
  for (let time = 0; time <= 500; time += 100) rate.record(time);
  assert.equal(rate.fps, 10);
  for (let time = 550; time <= 1000; time += 50) rate.record(time);
  assert.equal(rate.fps, 20, 'the faster recent half second replaces the initial rate');
  rate.record(1060);
  assert.equal(rate.fps, 20, 'a partial boundary interval cannot make FPS jump');
});

test('duplicate and invalid timestamps cannot inflate the rate', () => {
  const rate = new InferenceRate();
  for (let time = 0; time <= 500; time += 100) rate.record(time);
  for (const invalid of [500, 500, NaN, Infinity, -Infinity, undefined, null, '600']) {
    assert.equal(rate.record(invalid), 10);
  }
  assert.equal(rate.record(600), 10);
});

test('a backwards clock or a gap over one second begins a new measurement', () => {
  const rate = new InferenceRate();
  for (const time of [1000, 1250, 1500]) rate.record(time);
  assert.equal(rate.fps, 4);
  assert.equal(rate.record(50), 0);
  assert.equal(rate.record(550), 2);
  assert.equal(rate.record(1551), 0);
  assert.equal(rate.record(2051), 2);
  rate.reset();
  assert.equal(rate.fps, 0);
  assert.equal(rate.record(6000), 0);
  assert.equal(rate.record(7000), 1, 'exactly a one-second interval remains measurable');
});

test('face completions cannot change an independent hand completion rate', () => {
  const hands = new InferenceRate(), faces = new InferenceRate();
  for (let time = 0; time <= 1000; time += 20) {
    hands.record(time);
    if (time % 200 === 0) faces.record(time);
  }
  assert.equal(hands.fps, 50);
  assert.equal(faces.fps, 5);
  faces.record(1200);
  assert.equal(hands.fps, 50);
  hands.reset();
  assert.equal(hands.fps, 0);
  assert.equal(faces.fps, 5);
});
