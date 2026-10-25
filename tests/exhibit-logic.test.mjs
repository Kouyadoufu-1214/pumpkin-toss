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

test('participants can stand near the centre while each face still belongs to only one side', () => {
  const left = { x: 620 }, right = { x: 660 };
  assert.deepEqual(resolveRoles([right, left]), { caster: left, receiver: right });
  assert.deepEqual(resolveRoles([left]), { caster: left, receiver: null });
  assert.deepEqual(resolveRoles([right]), { caster: null, receiver: right });
  assert.deepEqual(resolveRoles([{ x: 640 }]), { caster: null, receiver: null }, 'the centre line cannot fill both roles');
});
test('held hand follows across center and does not jump to the distant receiver hand', () => {
  const hand = (x, label = 'Left') => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label });
  const caster = hand(460), receiver = hand(1050), crossing = hand(615);
  assert.equal(chooseControlHand([receiver, caster], null), caster);
  assert.equal(chooseControlHand([receiver, crossing], caster), crossing);
  assert.equal(chooseControlHand([receiver], caster), null);
  assert.equal(chooseControlHand([hand(520, 'Right')], caster), null);
});

test('sparse tracking follows a fast held hand while still rejecting distant, mismatched and stale hands', () => {
  const hand = (x, label = 'Left') => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label });
  const previous = hand(440), moving = hand(700), receiver = hand(1050);
  assert.equal(chooseControlHand([moving], previous), null, 'the normal frame interval keeps its tighter bound');
  assert.equal(chooseControlHand([receiver, moving], previous, { elapsed: 300 }), moving);
  assert.equal(chooseControlHand([receiver], previous, { elapsed: 650 }), null);
  assert.equal(chooseControlHand([hand(700, 'Right')], previous, { elapsed: 300 }), null);
  assert.equal(chooseControlHand([hand(460)], previous, { elapsed: 651 }), null);
  assert.equal(chooseControlHand([], previous, { elapsed: 300 }), null, 'a missing hand must never be invented');
});

test('acquiring a hand prefers the pumpkin position without selecting a hand from the receiver side', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 } });
  const far = hand(180), near = hand(490), otherSide = hand(720);
  assert.equal(chooseControlHand([far, near, otherSide], null, { anchor: { x: 510, y: 450 } }), near);
  assert.equal(chooseControlHand([far, near, otherSide], null, { anchor: { x: 700, y: 450 } }), near);
  const rightNear = hand(790), rightFar = hand(1080);
  assert.equal(chooseControlHand([rightFar, far, rightNear], null, { swapped: true, anchor: { x: 810, y: 450 } }), rightNear);
});

test('losing the held hand does not adopt a previously visible receiver hand with the same Left label', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  const held = hand(440), receiver = hand(950);
  const first = chooseControlHand([receiver, held], null, { anchor: { x: 440, y: 450 } });
  const moving = hand(700);
  const second = chooseControlHand([hand(950), moving], first, { elapsed: 300 });
  assert.equal(second, moving);
  assert.equal(chooseControlHand([hand(950)], second, { elapsed: 300 }), null);
  const continuing = hand(800);
  assert.equal(chooseControlHand([continuing, hand(970)], second, { elapsed: 300 }), continuing);
});

test('a peer approaching over several missed held-hand frames never becomes the held hand', () => {
  for (const swapped of [false, true]) {
    const hand = x => ({ palm: { x: swapped ? 1280 - x : x, y: 450 },
      wrist: { x: swapped ? 1280 - x : x, y: 480 }, label: 'Left' });
    const first = chooseControlHand([hand(440), hand(950)], null, { swapped });
    const held = chooseControlHand([hand(700), hand(950)], first, { elapsed: 300 });
    assert.ok(held, 'the genuine held hand can move quickly while the peer remains visible');
    assert.equal(chooseControlHand([hand(850)], held, { elapsed: 250 }), null);
    assert.equal(chooseControlHand([], held, { elapsed: 375 }), null, 'an empty result preserves known peers');
    assert.equal(chooseControlHand([hand(790)], held, { elapsed: 500 }), null,
      'a peer must stay a peer even when it approaches the last held-hand position');
  }
});

test('the original held hand can return after peer-only results without taking over that peer', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  const first = chooseControlHand([hand(440), hand(950)], null);
  const held = chooseControlHand([hand(700), hand(950)], first, { elapsed: 300 });
  assert.equal(chooseControlHand([hand(850)], held, { elapsed: 250 }), null);
  assert.equal(chooseControlHand([hand(790)], held, { elapsed: 500 }), null);
  const returned = hand(710), peer = hand(780);
  assert.equal(chooseControlHand([peer, returned], held, { elapsed: 600 }), returned);
  assert.equal(chooseControlHand([hand(765)], returned, { elapsed: 80 }), null,
    'the newly selected held hand also retains the peer identity');
});

test('starting near the centre no longer has a dead zone but never acquires the opposite side', () => {
  const left = { palm: { x: 630, y: 450 }, wrist: { x: 630, y: 480 } };
  const right = { palm: { x: 650, y: 450 }, wrist: { x: 650, y: 480 } };
  assert.equal(chooseControlHand([right, left], null), left);
  assert.equal(chooseControlHand([left, right], null, { swapped: true }), right);
  assert.equal(chooseControlHand([right], null), null);
  assert.equal(chooseControlHand([left], null, { swapped: true }), null);
});

test('ready mode can prefer a fist over a nearer open hand without changing held-hand continuity', () => {
  const hand = (x, closed) => {
    const worldPoints = anatomicalHand({ folded: closed ? 4 : 0 });
    return { palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left',
      points: projectHand(worldPoints), worldPoints, gesture: { categoryName: closed ? 'Closed_Fist' : 'Open_Palm', score: .9 } };
  };
  const open = hand(490, false), fist = hand(300, true), receiverFist = hand(740, true);
  const hands = [receiverFist, fist, open], anchor = { x: 500, y: 450 };
  assert.equal(chooseControlHand(hands, null, { anchor }), open, 'existing carving selection is unchanged by default');
  assert.equal(chooseControlHand(hands, null, { anchor, preferGrip: true }), fist);
  assert.equal(chooseControlHand([receiverFist, open], null, { anchor, preferGrip: true }), open);
  const nextOpen = hand(520, false);
  assert.equal(chooseControlHand([fist, receiverFist, nextOpen], open, { anchor, preferGrip: true }), nextOpen,
    'grip preference applies only to initial acquisition, never a held-hand switch');
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

test('a deliberate throw can be recognized from sparse frames beyond the old 240 ms history window', () => {
  for (const interval of [250, 350, 650]) {
    const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
    assert.equal(g.release({ x: 550, y: 410 }, interval, { x: 1000 }).ok, true, `${interval} ms frames`);
  }
});

test('release may be recognized shortly after the swing stops but an old swing cannot launch later', () => {
  const attempt = releaseAt => {
    const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
    g.move({ x: 450, y: 410 }, 150);
    return g.release({ x: 450, y: 410 }, releaseAt, { x: 1000 });
  };
  assert.equal(attempt(470).ok, true);
  assert.equal(attempt(471).ok, false);
  assert.equal(attempt(650).ok, false);
});

test('slow camera frames retain the start of a recent swing until a delayed open-hand frame arrives', () => {
  for (const interval of [350, 500, 600, 650]) {
    const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
    g.move({ x: 550, y: 410 }, interval);
    assert.equal(g.release({ x: 550, y: 410 }, interval + 250, { x: 1000 }).ok, true, `${interval} ms swing plus delayed release`);
  }
});

test('continuous high-rate motion still launches when each individual frame moves only a few pixels', () => {
  const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
  for (let frame = 1; frame < 15; frame++) g.move({ x: 350 + frame * 5, y: 450 }, frame * 16);
  assert.equal(g.release({ x: 425, y: 450 }, 240, { x: 1000 }).ok, true);
});

test('reversing toward the thrower at release rejects the earlier forward speed in either direction', () => {
  for (const direction of [1, -1]) {
    const g = new TossGesture(), start = direction === 1 ? 350 : 900;
    g.begin({ x: start, y: 450 }, 0);
    g.move({ x: start + 150 * direction, y: 410 }, 100);
    assert.equal(g.release({ x: start + 50 * direction, y: 410 }, 200, { x: start + 600 * direction }).reason, 'direction');
  }
});

test('slow repositioning, a tiny wobble, and fast vertical motion do not count as a throw toward the receiver', () => {
  const slow = new TossGesture(); slow.begin({ x: 350, y: 450 }, 0);
  for (let step = 1; step < 10; step++) slow.move({ x: 350 + step * 10, y: 450 }, step * 100);
  assert.equal(slow.release({ x: 450, y: 450 }, 1000, { x: 1000 }).ok, false);
  const wobble = new TossGesture(); wobble.begin({ x: 350, y: 450 }, 0);
  wobble.move({ x: 355, y: 447 }, 100); wobble.move({ x: 348, y: 450 }, 200);
  assert.equal(wobble.release({ x: 354, y: 450 }, 300, { x: 1000 }).ok, false);
  const vertical = new TossGesture(); vertical.begin({ x: 350, y: 450 }, 0);
  assert.equal(vertical.release({ x: 380, y: 200 }, 200, { x: 1000 }).ok, false);
});

test('a long tracking gap, out-of-order result, or invalid position cancels without an inferred release', () => {
  for (const [point, time] of [[{ x: 550, y: 410 }, 651], [{ x: 550, y: 410 }, -1], [{ x: NaN, y: 410 }, 100]]) {
    const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
    assert.equal(g.move(point, time), false);
    assert.equal(g.active, false);
    assert.equal(g.release({ x: 600, y: 410 }, 800, { x: 1000 }).ok, false);
  }
  const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 0);
  assert.equal(g.release({ x: 550, y: 410 }, 651, { x: 1000 }).ok, false);
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

test('confident fist and open-palm classifications resolve ambiguous projections while low scores retain landmark fallback', () => {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  points[0] = { x: 0, y: 4 }; points[5] = { x: -1, y: 2 }; points[17] = { x: 1, y: 2 }; points[4] = { x: -3, y: 1 };
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) { points[pip] = { x: 0, y: 2 }; points[tip] = { x: 0, y: 0 }; }
  assert.equal(handGrip(points, false, { categoryName: 'Closed_Fist', score: .9 }), true);
  assert.equal(handGrip(points, false, { categoryName: 'Closed_Fist', score: .4 }), false);
  for (const tip of [8, 12, 16, 20]) points[tip] = { x: 0, y: 3 };
  assert.equal(handGrip(points, true, { categoryName: 'Open_Palm', score: .9 }), false);
  assert.equal(handGrip(points, true, { categoryName: 'Open_Palm', score: .4 }), true);
  points[4] = { x: .3, y: 3 };
  assert.equal(handGrip(points, false, { categoryName: 'Open_Palm', score: .9 }), true, 'a deliberate pinch is still supported');
  points[8] = { x: NaN, y: 3 };
  assert.equal(handGrip(points, true, { categoryName: 'Closed_Fist', score: .9 }), false);
});

// A small anatomical hand in metres. Four-joint finger chains distinguish an
// extended finger from one folded away from the camera; projection can hide it.
function anatomicalHand({ folded = 4, pitch = 0 } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: .02, z: 0 }));
  points[0] = { x: 0, y: .08, z: 0 };
  points[1] = { x: -.02, y: .06, z: 0 }; points[2] = { x: -.04, y: .045, z: 0 };
  points[3] = { x: -.055, y: .03, z: 0 }; points[4] = { x: -.065, y: .025, z: 0 };
  for (const [i, base] of [5, 9, 13, 17].entries()) {
    const x = (i - 1.5) * .02, curled = i < folded;
    points[base] = { x, y: .02, z: 0 };
    points[base + 1] = { x, y: 0, z: 0 };
    points[base + 2] = { x, y: curled ? .003 : -.018, z: curled ? .02 : 0 };
    points[base + 3] = { x, y: curled ? .025 : -.035, z: curled ? .025 : 0 };
  }
  return points.map(({ x, y, z }) => ({ x, y: y * Math.cos(pitch) - z * Math.sin(pitch), z: y * Math.sin(pitch) + z * Math.cos(pitch) }));
}

function projectHand(worldPoints, { roll = 0, scale = 1000 } = {}) {
  return worldPoints.map(({ x, y }) => ({ x: 400 + scale * (x * Math.cos(roll) - y * Math.sin(roll)),
    y: 350 + scale * (x * Math.sin(roll) + y * Math.cos(roll)) }));
}

test('finger-chain bending recognizes a tilted fist that the old wrist-distance rule missed', () => {
  const world = anatomicalHand({ pitch: 55 * Math.PI / 180 });
  const projected = projectHand(world);
  const oldFolded = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) =>
    Math.hypot(projected[tip].x - projected[0].x, projected[tip].y - projected[0].y)
      < Math.hypot(projected[pip].x - projected[0].x, projected[pip].y - projected[0].y) * 1.08).length;
  assert.ok(oldFolded < 3, 'the fixture exercises a previous false negative');
  for (const roll of [-1.2, 0, 1.8]) {
    for (const scale of [300, 1000, 2400]) {
      assert.equal(handGrip(projectHand(world, { roll, scale }), false, { categoryName: 'Closed_Fist', score: .5 }), true);
      assert.equal(handGrip(projectHand(anatomicalHand({ folded: 0, pitch: 55 * Math.PI / 180 }), { roll, scale })), false);
    }
  }
});

test('world landmarks recover an almost edge-on fist and keep a similarly projected open palm open', () => {
  for (const folded of [4, 0]) {
    const world = anatomicalHand({ folded, pitch: 80 * Math.PI / 180 });
    const image = projectHand(world);
    assert.equal(handGrip(image, false, null, world), folded === 4);
    assert.equal(handGrip(image, true, { categoryName: folded ? 'Closed_Fist' : 'Open_Palm', score: .5 }, world), folded === 4);
  }
});

test('moderate fist confidence needs bent-finger evidence and cannot turn an open palm into a grip', () => {
  const partial = anatomicalHand({ folded: 2 }), open = anatomicalHand({ folded: 0 });
  assert.equal(handGrip(projectHand(partial), false, null, partial), false);
  assert.equal(handGrip(projectHand(partial), false, { categoryName: 'Closed_Fist', score: .5 }, partial), true);
  assert.equal(handGrip(projectHand(partial), false, { categoryName: 'Closed_Fist', score: .4 }, partial), false);
  assert.equal(handGrip(projectHand(open), false, { categoryName: 'Closed_Fist', score: .65 }, open), false);
  assert.equal(handGrip(projectHand(open), true, { categoryName: 'Closed_Fist', score: .65 }, open), false);
});

test('invalid optional 3D landmarks fall back to image geometry without accepting invalid image coordinates', () => {
  const fist = anatomicalHand(), image = projectHand(fist), invalid = fist.map(point => ({ ...point }));
  invalid[8].z = NaN;
  assert.equal(handGrip(image, false, null, invalid), true);
  assert.equal(handGrip(image, false, null, []), true);
  image[8].x = NaN;
  assert.equal(handGrip(image, true, { categoryName: 'Closed_Fist', score: .9 }, fist), false);
});

test('changing the grip at a stationary position never supplies a throw impulse', () => {
  const fist = anatomicalHand(), open = anatomicalHand({ folded: 0 });
  const point = { x: 400, y: 450 }, toss = new TossGesture();
  assert.equal(handGrip(projectHand(fist), false, null, fist), true);
  toss.begin(point, 1000); toss.move(point, 1250);
  assert.equal(handGrip(projectHand(open), true, null, open), false);
  assert.equal(toss.release(point, 1500, { x: 950 }).ok, false);
});
