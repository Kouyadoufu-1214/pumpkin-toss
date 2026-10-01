import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles, chooseControlHand, handGrip, TossGesture, DwellAction, flightPose } from '../public/exhibit-logic.mjs';

test('two-player mode never makes a lone person their own receiver', () => {
  const left = { x: 200 }, right = { x: 1050 };
  assert.deepEqual(resolveRoles([left]), { caster: left, receiver: null });
  assert.deepEqual(resolveRoles([right]), { caster: null, receiver: right });
  assert.deepEqual(resolveRoles([left, { x: 640 }]), { caster: left, receiver: null });
  assert.deepEqual(resolveRoles([right, left], { swapped: true }), { caster: right, receiver: left });
});
test('solo mode reserves receiver for the explicitly marked practice avatar', () => {
  assert.deepEqual(resolveRoles([{ x: 240 }], { solo: true }), { caster: { x: 240 }, receiver: null });
});
test('held hand follows across center and does not jump to the distant receiver hand', () => {
  const hand = (x, label = 'Left') => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label });
  const caster = hand(460), receiver = hand(1050), crossing = hand(615);
  assert.equal(chooseControlHand([receiver, caster], null), caster);
  assert.equal(chooseControlHand([receiver, crossing], caster), crossing);
  assert.equal(chooseControlHand([receiver], caster), null);
  assert.equal(chooseControlHand([hand(520, 'Right')], caster), null);
});
test('only a deliberate throw toward an existing receiver launches', () => {
  const attempt = (end, target, time = 200) => { const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0); return g.release(end, time, target); };
  assert.equal(attempt({ x: 480, y: 410 }, { x: 1000 }).ok, true);
  assert.equal(attempt({ x: 220, y: 410 }, { x: 1000 }).reason, 'direction');
  assert.equal(attempt({ x: 480, y: 410 }, null).reason, 'no-receiver');
  assert.equal(attempt({ x: 480, y: 410 }, { x: 1000 }, 2000).reason, 'slow');
  const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0); g.cancel();
  assert.equal(g.release({ x: 600, y: 400 }, 200, { x: 1000 }).ok, false);
});
test('throwing to the left is supported when roles are swapped', () => {
  const g = new TossGesture(); g.begin({ x: 900, y: 450 }, 0);
  assert.equal(g.release({ x: 770, y: 400 }, 200, { x: 300 }).ok, true);
});
test('dwell requires uninterrupted presence and fires only once per entry', () => {
  const d = new DwellAction(1000);
  assert.equal(d.update(true, 0), false); assert.equal(d.update(true, 900), false);
  d.update(false, 950); assert.equal(d.update(true, 1000), false);
  assert.equal(d.update(true, 2001), true); assert.equal(d.update(true, 2100), false);
});
test('flight lands exactly at the receiver and drops from above near its end', () => {
  const from = { x: 400, y: 450, w: 220, h: 200 }, to = { x: 950, y: 330, w: 250, h: 240 };
  const start = flightPose(from, to, 0), before = flightPose(from, to, .8), end = flightPose(from, to, 1);
  assert.equal(start.x, from.x); assert.equal(start.y, from.y);
  assert.equal(before.x, to.x); assert.ok(before.y < to.y - 60);
  assert.equal(end.x, to.x); assert.ok(Math.abs(end.y - to.y) < .000001); assert.equal(end.w, to.w); assert.equal(end.h, to.h);
});
test('grip accepts a fist and rejects an open palm', () => {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  points[0] = { x: 0, y: 4 }; points[5] = { x: -1, y: 2 }; points[17] = { x: 1, y: 2 }; points[4] = { x: -3, y: 1 };
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) { points[pip] = { x: 0, y: 2 }; points[tip] = { x: 0, y: 0 }; }
  assert.equal(handGrip(points), false);
  for (const tip of [8, 12, 16, 20]) points[tip] = { x: 0, y: 3 };
  assert.equal(handGrip(points), true); assert.equal(handGrip([]), false);
});
