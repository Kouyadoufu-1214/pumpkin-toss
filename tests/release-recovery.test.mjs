import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseRecovery } from '../public/release-recovery.mjs';

const curled = { grip: true, open: false, openness: .75, extendedFingers: 0 };
const partial = { grip: false, open: false, openness: .95, extendedFingers: 3 };
const open = { grip: false, open: true, openness: 1, extendedFingers: 4 };
const target = { x: 1000, y: 300 };
const from = { x: 240, y: 400, w: 90, h: 90 };

function observation(recovery, x, time, shape, options = {}) {
  const { now = time, ...overrides } = options;
  recovery.observe({ point: { x, y: 400 }, time, shape, cropped: false,
    metrics: { ok: true }, target, from, ...overrides }, now);
}

function openingSwing(recovery, { direction = 1, end = partial } = {}) {
  const receiver = direction > 0 ? target : { x: 100, y: 300 };
  const x = direction > 0 ? 200 : 900;
  observation(recovery, x, 1000, curled, { target: receiver });
  observation(recovery, x + direction * 60, 1050, curled, { target: receiver });
  observation(recovery, x + direction * 130, 1100, end, { target: receiver });
  return { receiver, x: x + direction * 130 };
}

test('one genuinely open release sample survives a short recognition dropout', () => {
  const recovery = new ReleaseRecovery();
  observation(recovery, 200, 1000, curled);
  observation(recovery, 260, 1100, open);
  assert.equal(recovery.recover(1120, 1120, target), null, 'a disappearance is not immediate release');
  assert.deepEqual(recovery.recover(1140, 1140, target), {
    point: { x: 260, y: 400 }, time: 1100, from, kind: 'observed-open',
  });
  assert.equal(recovery.recover(1180, 1180, target), null, 'the evidence is consumed once');
});

test('consecutive open samples preserve the initial release sample and respect configured confirmation', () => {
  const recovery = new ReleaseRecovery();
  observation(recovery, 200, 1000, curled);
  observation(recovery, 260, 1100, open);
  observation(recovery, 280, 1130, open);
  assert.equal(recovery.recover(1170, 1170, target, 80), null);
  assert.equal(recovery.recover(1210, 1210, target, 80)?.time, 1100);
});

test('rapid opening swing recovers in both directions using only the last real position', () => {
  for (const direction of [1, -1]) {
    const recovery = new ReleaseRecovery();
    const { receiver, x } = openingSwing(recovery, { direction });
    const result = recovery.recover(1160, 1170, receiver);
    assert.equal(result?.kind, 'opening-swing');
    assert.deepEqual(result.point, { x, y: 400 });
    assert.equal(result.time, 1100);
  }
});

test('the same opening swing recovers at 15 through 120 observations per second', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const direction of [1, -1]) {
      const recovery = new ReleaseRecovery(), receiver = direction > 0 ? target : { x: 100, y: 300 };
      const start = direction > 0 ? 200 : 900, count = fps / 5;
      for (let index = 0; index <= count; index++) {
        const elapsed = index / fps * 1000;
        observation(recovery, start + direction * elapsed * 1.1, 1000 + elapsed,
          index === count ? partial : curled, { target: receiver });
      }
      const result = recovery.recover(1250, 1250, receiver);
      assert.equal(result?.kind, 'opening-swing', `${fps} fps, direction ${direction}`);
      assert.equal(result.time, 1200);
      assert.deepEqual(result.point, { x: start + direction * 220, y: 400 });
    }
  }
});

test('high-rate windows preserve speed, distance, closure and single-jump safeguards', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const scenario of ['slow', 'short', 'closed', 'single-jump']) {
      const recovery = new ReleaseRecovery(), count = scenario === 'short' ? fps / 15 : fps / 5;
      for (let index = 0; index <= count; index++) {
        const elapsed = index / fps * 1000;
        const travel = scenario === 'single-jump' ? index === count ? 220 : 0
          : elapsed * (scenario === 'slow' ? .6 : 1.1);
        observation(recovery, 200 + travel, 1000 + elapsed,
          index === count && scenario !== 'closed' ? partial : curled);
      }
      const missingAt = 1000 + count / fps * 1000 + 50;
      assert.equal(recovery.recover(missingAt, missingAt, target), null, `${scenario} at ${fps} fps`);
    }
  }
});

test('small reverse jitter keeps observed opening, but a cumulative backswing clears it', () => {
  const recovery = new ReleaseRecovery();
  openingSwing(recovery, { end: open });
  observation(recovery, 329, 1120, open);
  observation(recovery, 330, 1140, open);
  assert.equal(recovery.recover(1180, 1180, target)?.time, 1100);

  recovery.reset();
  openingSwing(recovery, { end: open });
  observation(recovery, 315, 1120, open);
  observation(recovery, 300, 1140, open);
  observation(recovery, 297, 1160, open);
  assert.equal(recovery.recover(1200, 1200, target), null,
    'several small backward steps must not evade the 32px reversal limit');
});

test('closed-fist speed and missing hands alone never release', () => {
  const recovery = new ReleaseRecovery();
  openingSwing(recovery, { end: curled });
  assert.equal(recovery.recover(1160, 1160, target), null);
  recovery.reset();
  assert.equal(recovery.recover(1160, 1160, target), null);
});

test('stationary opening and a single jump have insufficient real swing evidence', () => {
  for (const xs of [[200, 200, 200], [200, 200, 360], [200, 210, 230]]) {
    const recovery = new ReleaseRecovery();
    observation(recovery, xs[0], 1000, curled);
    observation(recovery, xs[1], 1050, curled);
    observation(recovery, xs[2], 1100, partial);
    assert.equal(recovery.recover(1160, 1160, target), null);
  }
});

test('a newly held, closed, reversed or low-confidence frame replaces partial eligibility', () => {
  for (const [x, shape, options] of [
    [330, partial, {}], [370, curled, {}], [320, partial, {}],
    [370, partial, { metrics: { ok: false } }],
  ]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    observation(recovery, x, 1140, shape, options);
    assert.equal(recovery.recover(1200, 1200, target), null);
  }
});

test('contradictory full-open evidence is cleared on closure, reversal and cropping', () => {
  for (const [x, shape, options] of [
    [360, curled, {}], [297, open, {}], [370, open, { cropped: true }],
  ]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery, { end: open });
    observation(recovery, x, 1140, shape, options);
    assert.equal(recovery.recover(1200, 1200, target), null);
  }
});

test('partial geometry must show three extended fingers and opening since a recent observed curl', () => {
  for (const shape of [
    { ...partial, extendedFingers: 2 }, { ...partial, openness: .84 },
    { ...partial, openness: .8 }, { ...partial, grip: true },
  ]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery, { end: shape });
    assert.equal(recovery.recover(1160, 1160, target), null);
  }
  const recovery = new ReleaseRecovery();
  observation(recovery, 200, 1000, partial);
  observation(recovery, 260, 1050, partial);
  observation(recovery, 330, 1100, partial);
  assert.equal(recovery.recover(1160, 1160, target), null, 'already-open motion is not opening evidence');
});

test('partial recovery rejects slow, vertical, too sparse and too close sample segments', () => {
  for (const observations of [
    [[200, 1000, 400], [250, 1110, 400], [300, 1220, 400]],
    [[200, 1000, 400], [260, 1050, 500], [330, 1100, 600]],
    [[200, 1000, 400], [260, 1170, 400], [330, 1200, 400]],
    [[200, 1000, 400], [260, 1010, 400], [330, 1020, 400]],
  ]) {
    const recovery = new ReleaseRecovery();
    for (const [index, [x, time, y]] of observations.entries()) {
      observation(recovery, x, time, index === 2 ? partial : curled, { point: { x, y } });
    }
    const now = observations.at(-1)[1] + 50;
    assert.equal(recovery.recover(now, now, target), null);
  }
});

test('old curl evidence cannot infer a later opening', () => {
  const recovery = new ReleaseRecovery();
  observation(recovery, 200, 1000, curled);
  observation(recovery, 210, 1160, partial);
  observation(recovery, 270, 1210, partial);
  observation(recovery, 340, 1260, partial);
  assert.equal(recovery.recover(1310, 1310, target), null);
});

test('stale missing results and observations clear eligibility permanently', () => {
  for (const [time, now] of [[1281, 1281], [1150, 1351], [1150, 1149]]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    assert.equal(recovery.recover(time, now, target), null);
    assert.equal(recovery.recover(time + 1, now + 1, target), null);
  }
  const recovery = new ReleaseRecovery();
  openingSwing(recovery);
  observation(recovery, 380, 1130, open, { now: 1331 });
  assert.equal(recovery.recover(1180, 1180, target), null);
});

test('duplicate and out-of-order visible or missing frames invalidate old release evidence', () => {
  for (const time of [1100, 1090]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    observation(recovery, 330, time, partial, { now: 1110 });
    assert.equal(recovery.recover(1160, 1160, target), null);
    recovery.reset();
    openingSwing(recovery);
    assert.equal(recovery.recover(time, 1110, target), null);
    assert.equal(recovery.recover(1160, 1160, target), null);
  }
});

test('missing receiver or changed target direction clears the candidate', () => {
  for (const receiver of [null, { x: 100, y: 300 }, { x: NaN, y: 300 }]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    assert.equal(recovery.recover(1160, 1160, receiver), null);
    assert.equal(recovery.recover(1170, 1170, target), null);
  }
  for (const receiver of [null, { x: 100, y: 300 }]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    observation(recovery, 380, 1140, open, { target: receiver });
    assert.equal(recovery.recover(1200, 1200, target), null);
  }
});

test('cropped observations, invalid shapes and a reset cannot retain a release', () => {
  for (const options of [{ cropped: true }, { shape: { ...partial, openness: NaN } }, { point: { x: NaN, y: 1 } }]) {
    const recovery = new ReleaseRecovery();
    openingSwing(recovery);
    observation(recovery, 380, 1140, partial, options);
    assert.equal(recovery.recover(1200, 1200, target), null);
  }
  const recovery = new ReleaseRecovery();
  openingSwing(recovery);
  recovery.reset();
  assert.equal(recovery.recover(1160, 1160, target), null);
});

test('loss of receiver clears curl history before any release candidate exists', () => {
  const recovery = new ReleaseRecovery();
  observation(recovery, 200, 1000, curled);
  observation(recovery, 260, 1050, curled);
  assert.equal(recovery.recover(1070, 1070, null), null);
  observation(recovery, 330, 1100, partial);
  assert.equal(recovery.recover(1160, 1160, target), null);
});

test('caller mutations cannot change the remembered real release point or display pose', () => {
  const recovery = new ReleaseRecovery();
  const point = { x: 330, y: 400 }, pose = { ...from };
  observation(recovery, 200, 1000, curled);
  observation(recovery, 330, 1100, open, { point, from: pose });
  point.x = 900;
  pose.x = 900;
  const result = recovery.recover(1160, 1160, { x: 900, y: 310 });
  assert.equal(result.point.x, 330);
  assert.equal(result.from.x, from.x);
});
