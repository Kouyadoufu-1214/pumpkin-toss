import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionRelease } from '../public/motion-release.mjs';

const target = { x: 1100, y: 300 };
const sample = (release, x, time, options = {}) => {
  const { now = time, ...overrides } = options;
  return release.observe({ point: { x, y: 400 }, time, target, ...overrides }, now);
};

test('three real forward windows release at 15 through 120 FPS in either direction', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const direction of [1, -1]) {
      const release = new MotionRelease();
      const receiver = { x: direction > 0 ? 1100 : 100, y: 300 };
      const start = direction > 0 ? 200 : 1000;
      let readyAt = null;
      for (let index = 0; index <= fps / 2; index++) {
        const elapsed = index / fps * 1000;
        const ready = sample(release, start + direction * elapsed * .6, 1000 + elapsed, { target: receiver });
        if (ready && readyAt === null) readyAt = elapsed;
        assert.ok(release.frames <= release.requiredFrames);
      }
      assert.ok(readyAt >= 75 && readyAt <= 220, `${fps} FPS, direction ${direction}: ${readyAt}`);
      assert.equal(release.progress, 1);
    }
  }
});

test('high-rate steps below 2px can combine into actual forward motion windows', () => {
  for (const fps of [90, 120]) {
    const release = new MotionRelease();
    let ready = false;
    for (let index = 0; index <= fps / 2; index++) {
      const elapsed = index / fps * 1000;
      ready ||= sample(release, 200 + elapsed * .17, 1000 + elapsed);
    }
    assert.equal(ready, true, `${fps} FPS at 170px/s`);
  }
});

test('a single distant jump followed by stillness never accumulates release frames', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000);
  assert.equal(sample(release, 600, 1050), false);
  assert.equal(release.frames, 1);
  for (let time = 1060; time <= 1500; time += 10) assert.equal(sample(release, 600, time), false);
  assert.equal(release.frames, 0);
});

test('slow, vertical, reverse and stationary windows break the forward streak', () => {
  for (const point of [{ x: 220, y: 400 }, { x: 240, y: 450 }, { x: 210, y: 400 }, { x: 223, y: 400 }]) {
    const release = new MotionRelease();
    sample(release, 200, 1000);
    sample(release, 220, 1050);
    assert.equal(release.frames, 1);
    assert.equal(sample(release, point.x, 1100, { point }), false);
    assert.equal(release.frames, 0);
  }
});

test('backswing starts a fresh forward streak on either side', () => {
  for (const direction of [1, -1]) {
    const release = new MotionRelease(), start = direction > 0 ? 400 : 800;
    const receiver = { x: direction > 0 ? 1100 : 100, y: 300 };
    for (const [index, offset] of [0, -50, -100, -80, -60].entries()) {
      assert.equal(sample(release, start + offset * direction, 1000 + index * 50, { target: receiver }), false);
    }
    assert.equal(sample(release, start - 40 * direction, 1250, { target: receiver }), true);
  }
});

test('invalid, stale, future, duplicate and out-of-order observations cannot count', () => {
  for (const overrides of [
    { valid: false }, { target: null }, { target: { x: 1100, y: NaN } },
    { point: { x: NaN, y: 400 } }, { point: { x: 260, y: Infinity } },
    { now: 1751 }, { now: 1099 }, { now: NaN }, { time: NaN }, { time: 1050 }, { time: 1049 },
  ]) {
    const release = new MotionRelease();
    sample(release, 200, 1000); sample(release, 220, 1050);
    assert.equal(sample(release, 240, 1100, overrides), false, JSON.stringify(overrides));
    assert.equal(release.frames, 0);
    assert.equal(sample(release, 260, 1150), false, 'new evidence starts with a fresh anchor');
  }
});

test('replayed observations cannot establish a fresh streak after chronological rejection', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000); sample(release, 220, 1050); sample(release, 240, 1100);
  for (const [x, time] of [[200, 1000], [220, 1050], [240, 1100]]) {
    assert.equal(sample(release, x, time, { now: 1150 }), false);
    assert.equal(release.frames, 0);
  }
});

test('a long result gap restarts motion and the 650ms boundary remains usable', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000); sample(release, 220, 1050);
  assert.equal(sample(release, 420, 1701), false);
  assert.equal(release.frames, 0);
  assert.equal(sample(release, 550, 2351, { now: 3001 }), false);
  assert.equal(release.frames, 1, 'exactly 650ms gap and age are accepted');
});

test('a target direction change clears previous counts and absence lends no motion history', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000); sample(release, 220, 1050);
  assert.equal(sample(release, 240, 1100, { target: { x: 100, y: 300 } }), false);
  assert.equal(release.frames, 0);
  assert.equal(sample(release, 200, 1150, { target: null }), false);
  assert.equal(sample(release, 600, 1200), false);
  assert.equal(release.frames, 0);
  assert.equal(sample(release, 620, 1250), false);
  assert.equal(release.frames, 1);
});

test('reaching or crossing the target cannot complete the old direction streak', () => {
  for (const end of [1100, 1110]) {
    const release = new MotionRelease();
    sample(release, 1000, 1000); sample(release, 1040, 1050); sample(release, 1080, 1100);
    assert.equal(sample(release, end, 1150), false);
    assert.equal(release.frames, 0);
  }
});

test('configuration resets changed settings, retains unchanged settings, and bounds bad inputs', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000); sample(release, 220, 1050);
  release.configure({ motionFrames: 3, minSpeed: 160 });
  assert.equal(release.frames, 1);
  release.configure({ motionFrames: 2 });
  assert.equal(release.frames, 0);
  assert.equal(release.requiredFrames, 2);
  sample(release, 200, 1000); sample(release, 220, 1050);
  assert.equal(sample(release, 240, 1100), true);
  release.configure({ minSpeed: 600 });
  assert.equal(release.frames, 0);
  release.configure({ motionFrames: 100, minSpeed: -1 });
  assert.equal(release.requiredFrames, 8);
  assert.equal(release.minSpeed, 80);
  release.configure({ motionFrames: NaN, minSpeed: '160' });
  assert.equal(release.requiredFrames, 8);
  assert.equal(release.minSpeed, 80);
});

test('reset clears history, counts and progress before the next participant', () => {
  const release = new MotionRelease();
  sample(release, 200, 1000); sample(release, 220, 1050);
  assert.ok(release.progress > 0);
  release.reset();
  assert.equal(release.progress, 0);
  assert.equal(sample(release, 500, 2000), false);
  assert.equal(release.frames, 0);
});
