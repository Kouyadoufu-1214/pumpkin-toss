import test from 'node:test';
import assert from 'node:assert/strict';
import { HandMotion, SoftFollow } from '../public/hand-motion.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('soft visual follow is independent of display frame rate and never alters measured targets', () => {
  const outputs = [];
  for (const hz of [30, 60, 120]) {
    const follow = new SoftFollow(65), target = Object.freeze({ x: 60, y: 30 });
    follow.follow({ x: 0, y: 0 }, 0);
    for (let frame = 1; frame <= hz; frame++) follow.follow(target, frame * 1000 / hz);
    outputs.push(follow.follow(target, 1000));
  }
  for (const output of outputs) { near(output.x, outputs[0].x); near(output.y, outputs[0].y); }
});
test('soft follow limits fast-motion lag, settles after stopping and supports disabling smoothing', () => {
  const follow = new SoftFollow(65); follow.follow({ x: 0, y: 0 }, 0);
  const point = follow.follow({ x: 600, y: 800 }, 16);
  near(Math.hypot(point.x - 600, point.y - 800), 90);
  for (let t = 32; t < 1000; t += 16) follow.follow({ x: 600, y: 800 }, t);
  assert.ok(Math.abs(follow.point.x - 600) < .001);
  follow.configure(0); assert.deepEqual(follow.follow({ x: 40, y: 50 }, 1010), { x: 40, y: 50 });
  follow.reset(); assert.equal(follow.point, null);
});

test('180 ms camera latency advances the visual hand by at most 90 ms and updates between camera observations', () => {
  const motion = new HandMotion();
  assert.equal(motion.position(100), null);
  assert.equal(motion.observe({ x: 100, y: 200 }, 100), true);
  assert.deepEqual(motion.position(180), { x: 100, y: 200 }, 'one sample has no inferred velocity');
  motion.observe({ x: 190, y: 200 }, 190);
  assert.deepEqual(motion.position(205), { x: 205, y: 200 });
  assert.deepEqual(motion.position(220), { x: 220, y: 200 });
  assert.deepEqual(motion.position(370), { x: 280, y: 200 }, '180 ms latency is only partly compensated');
});

test('a very fast diagonal throw never extrapolates more than 160 screen pixels', () => {
  const motion = new HandMotion();
  motion.observe({ x: 0, y: 0 }, 100);
  motion.observe({ x: 600, y: 800 }, 200);
  const point = motion.position(380);
  near(point.x, 696); near(point.y, 928);
  near(Math.hypot(point.x - 600, point.y - 800), 160);
});

test('a stopped hand stops immediately and reversing direction replaces the earlier velocity', () => {
  const motion = new HandMotion();
  motion.observe({ x: 100, y: 300 }, 100);
  motion.observe({ x: 200, y: 300 }, 200);
  assert.deepEqual(motion.position(380), { x: 290, y: 300 });
  motion.observe({ x: 200, y: 300 }, 300);
  assert.deepEqual(motion.position(480), { x: 200, y: 300 });
  motion.observe({ x: 100, y: 300 }, 400);
  assert.deepEqual(motion.position(580), { x: 10, y: 300 });
});

test('missing observations freeze at the bounded prediction and expire instead of drifting indefinitely', () => {
  const motion = new HandMotion();
  motion.observe({ x: 100, y: 200 }, 0);
  motion.observe({ x: 200, y: 200 }, 100);
  assert.deepEqual(motion.position(190), { x: 290, y: 200 });
  assert.deepEqual(motion.position(600), { x: 290, y: 200 });
  assert.equal(motion.position(601), null);
  assert.equal(motion.position(10000), null);
  motion.observe({ x: 700, y: 400 }, 1000);
  assert.deepEqual(motion.position(1180), { x: 700, y: 400 }, 'a long gap starts a new motion without extrapolation');
});

test('invalid positions, invalid time, duplicate time, and old observations reset prediction', () => {
  for (const [point, time] of [
    [null, 300], [{}, 300], [{ x: NaN, y: 2 }, 300], [{ x: 2, y: Infinity }, 300],
    [{ x: 2, y: 2 }, NaN], [{ x: 2, y: 2 }, Infinity], [{ x: 2, y: 2 }, -1],
    [{ x: 2, y: 2 }, 200], [{ x: 2, y: 2 }, 150],
  ]) {
    const motion = new HandMotion();
    motion.observe({ x: 100, y: 200 }, 100); motion.observe({ x: 200, y: 200 }, 200);
    assert.equal(motion.observe(point, time), false);
    assert.equal(motion.position(380), null);
    motion.observe({ x: 300, y: 400 }, 400);
    assert.deepEqual(motion.position(580), { x: 300, y: 400 });
  }
});

test('observations and returned snapshots cannot mutate the predictor state', () => {
  const motion = new HandMotion(), first = { x: 100, y: 200 }, second = { x: 200, y: 200 };
  motion.observe(first, 100); motion.observe(second, 200);
  assert.deepEqual(first, { x: 100, y: 200 }); assert.deepEqual(second, { x: 200, y: 200 });
  first.x = 10000; second.y = 10000;
  const snapshot = motion.position(380);
  assert.deepEqual(snapshot, { x: 290, y: 200 });
  snapshot.x = -10000;
  assert.deepEqual(motion.position(380), { x: 290, y: 200 });
  motion.reset(); assert.equal(motion.position(380), null);
  motion.observe(Object.freeze({ x: 300, y: 400 }), 400);
  assert.deepEqual(motion.position(580), { x: 300, y: 400 });
});

test('bad render times and extreme finite inputs cannot produce NaN or an unbounded correction', () => {
  const motion = new HandMotion();
  motion.observe({ x: 100, y: 200 }, 100); motion.observe({ x: 101, y: 200 }, 100.001);
  const point = motion.position(280);
  near(point.x, 106.625); near(point.y, 200);
  assert.equal(motion.position(NaN), null); assert.equal(motion.position(Infinity), null);
  assert.deepEqual(motion.position(50), { x: 101, y: 200 }, 'rendering cannot extrapolate backwards');
  motion.observe({ x: 1e308, y: 1e308 }, 200); motion.observe({ x: -1e308, y: -1e308 }, 300);
  assert.deepEqual(motion.position(480), { x: -1e308, y: -1e308 });
});
