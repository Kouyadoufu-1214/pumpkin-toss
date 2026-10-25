import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles, chooseControlHand, handGrip, handOpen, TossGesture, DwellAction, flightPose, HELD_HAND_GRACE_MS } from '../public/exhibit-logic.mjs';

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

test('held recovery can reacquire a nearby wrist after a short absence without changing the default timeout', () => {
  assert.equal(HELD_HAND_GRACE_MS, 1500);
  for (const swapped of [false, true]) {
    const hand = (x, label = 'Left') => ({ palm: { x: swapped ? 1280 - x : x, y: 450 },
      wrist: { x: swapped ? 1280 - x : x, y: 480 }, label });
    const held = chooseControlHand([hand(350)], null, { swapped }), returned = hand(450);
    assert.equal(chooseControlHand([returned], held, { elapsed: 1000, swapped }), null);
    for (const elapsed of [651, 1000, HELD_HAND_GRACE_MS]) {
      assert.equal(chooseControlHand([returned], held, { elapsed, swapped, recoverHeld: true }), returned);
    }
    assert.equal(chooseControlHand([returned], held, { elapsed: HELD_HAND_GRACE_MS + 1, recoverHeld: true }), null);
    assert.equal(chooseControlHand([hand(450, 'Right')], held, { elapsed: 1000, recoverHeld: true }), null);
    assert.equal(chooseControlHand([], held, { elapsed: 1000, recoverHeld: true }), null);
    assert.equal(chooseControlHand([hand(550)], held, { elapsed: 1000, recoverHeld: true, fastMotion: true }), null,
      'even an enabled fast swing cannot extend the recovery distance');
  }
});

test('held recovery rejects ambiguous unknown nearby hands and keeps a smaller stage bound', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  const held = chooseControlHand([hand(350)], null), options = { elapsed: 1000, recoverHeld: true };
  assert.equal(chooseControlHand([hand(360), hand(420)], held, options), null);
  assert.equal(chooseControlHand([hand(510)], held, { ...options, width: 800 }), null);
  assert.equal(chooseControlHand([hand(490)], held, { ...options, width: 800 }).wrist.x, 490);
});

test('held recovery keeps a known peer reserved through missed results and reacquires only the original hand', () => {
  for (const swapped of [false, true]) {
    const hand = x => ({ palm: { x: swapped ? 1280 - x : x, y: 450 },
      wrist: { x: swapped ? 1280 - x : x, y: 480 }, label: 'Left' });
    const initial = chooseControlHand([hand(440), hand(950)], null, { swapped });
    const held = chooseControlHand([hand(700), hand(950)], initial, { elapsed: 300, swapped });
    const options = { swapped, fastMotion: true, recoverHeld: true };
    assert.equal(chooseControlHand([hand(850)], held, { ...options, elapsed: 350 }), null);
    assert.equal(chooseControlHand([hand(790)], held, { ...options, elapsed: 800 }), null);
    assert.equal(chooseControlHand([hand(740)], held, { ...options, elapsed: 1100 }), null,
      'a known peer stays reserved even nearer the old held wrist than its own last position');
    const returned = hand(650), peer = hand(740);
    assert.equal(chooseControlHand([peer, returned], held, { ...options, elapsed: 1400 }), returned);
    assert.equal(chooseControlHand([hand(730)], returned, { ...options, elapsed: 80 }), null);
  }
});

test('a reacquired hand does not carry forward velocity from before or across the tracking gap', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  for (const delta of [0, 190]) {
    const initial = chooseControlHand([hand(300)], null);
    const moving = chooseControlHand([hand(350)], initial, { elapsed: 40, fastMotion: true });
    const returned = delta ? hand(350 + delta) : moving;
    assert.equal(chooseControlHand([returned], moving, { elapsed: 700, recoverHeld: true, fastMotion: true }), returned);
    assert.equal(chooseControlHand([hand(returned.wrist.x + 400)], returned, { elapsed: 80, fastMotion: true }), null,
      'a blind gap cannot supply forward movement evidence for a distant hand');
  }
});

test('fast-motion tracking accepts large forward swings while ordinary selection stays bounded', () => {
  for (const swapped of [false, true]) {
    const hand = (x, y = 450, label = 'Left') => ({ palm: { x: swapped ? 1280 - x : x, y },
      wrist: { x: swapped ? 1280 - x : x, y: y + 30 }, label });
    for (const [elapsed, travel] of [[80, 250], [150, 300], [80, 500], [250, 450], [500, 500]]) {
      const held = hand(350), moving = hand(350 + travel);
      if (travel > 340) {
        const prior = chooseControlHand([hand(300)], null, { swapped });
        assert.equal(chooseControlHand([held], prior, { swapped, elapsed: 40 }), held);
      }
      assert.equal(chooseControlHand([moving], held, { elapsed, swapped }), null);
      assert.equal(chooseControlHand([moving], held, { elapsed, swapped, fastMotion: true }), moving);
    }
    const held = hand(440), options = { elapsed: 300, swapped, fastMotion: true };
    assert.equal(chooseControlHand([hand(1050)], held, options), null, 'a previously unknown distant receiver remains out of reach');
    assert.equal(chooseControlHand([hand(900, 450, 'Right')], held, options), null);
    assert.equal(chooseControlHand([hand(900)], held, { ...options, elapsed: 651 }), null);
    assert.equal(chooseControlHand([hand(440, 950)], held, options), null, 'a vertical leap is not a forward swing');
    assert.equal(chooseControlHand([hand(-60)], held, options), null, 'the expanded reach is only for the throwing direction');
    assert.equal(chooseControlHand([hand(900)], held, { ...options, width: 800 }), null, 'the bound scales down for a smaller stage');
  }
});

test('fast-motion tracking reserves known peers before following a large swing', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  const beginning = chooseControlHand([hand(390), hand(1050)], null);
  const first = chooseControlHand([hand(440), hand(1050)], beginning, { elapsed: 40 });
  const moving = hand(940), peer = hand(1040);
  const second = chooseControlHand([peer, moving], first, { elapsed: 100, fastMotion: true });
  assert.equal(second, moving);
  assert.equal(chooseControlHand([hand(1020)], second, { elapsed: 100, fastMotion: true }), null);
  assert.equal(chooseControlHand([hand(990)], second, { elapsed: 300, fastMotion: true }), null);
});

test('the widest hand reach needs prior forward motion and cannot adopt an unknown receiver after a stationary hold', () => {
  for (const swapped of [false, true]) {
    const hand = x => ({ palm: { x: swapped ? 1280 - x : x, y: 450 },
      wrist: { x: swapped ? 1280 - x : x, y: 480 }, label: 'Left' });
    const initial = chooseControlHand([hand(440)], null, { swapped });
    const stationary = chooseControlHand([hand(440)], initial, { elapsed: 40, swapped });
    for (const elapsed of [100, 200, 500]) {
      assert.equal(chooseControlHand([hand(900)], stationary, { elapsed, swapped, fastMotion: true }), null);
    }
    assert.equal(chooseControlHand([hand(790)], stationary, { elapsed: 300, swapped, fastMotion: true }), null,
      'the cold-start cap also applies when the older sparse-frame reach would allow 350 pixels');
    const beginning = chooseControlHand([hand(330)], null, { swapped });
    const forward = chooseControlHand([hand(380)], beginning, { elapsed: 40, swapped, fastMotion: true });
    const swinging = hand(820);
    assert.equal(chooseControlHand([swinging], forward, { elapsed: 80, swapped, fastMotion: true }), swinging);
    const backwards = chooseControlHand([hand(350)], chooseControlHand([hand(390)], null, { swapped }), { elapsed: 40, swapped });
    assert.equal(chooseControlHand([hand(800)], backwards, { elapsed: 80, swapped, fastMotion: true }), null);
  }
});

test('fast-motion tracking refuses competing unknown hands unless prior motion distinguishes them', () => {
  const hand = x => ({ palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left' });
  assert.equal(chooseControlHand([hand(700), hand(850)], hand(350), { elapsed: 80, fastMotion: true }), null);
  const first = chooseControlHand([hand(350)], null);
  const second = chooseControlHand([hand(450)], first, { elapsed: 80, fastMotion: true });
  const continuing = hand(800), unknown = hand(1000);
  assert.equal(chooseControlHand([unknown, continuing], second, { elapsed: 250, fastMotion: true }), continuing);
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
  for (const { swapped, fastMotion } of [{ swapped: false, fastMotion: false }, { swapped: true, fastMotion: false },
    { swapped: false, fastMotion: true }, { swapped: true, fastMotion: true }]) {
    const hand = x => ({ palm: { x: swapped ? 1280 - x : x, y: 450 },
      wrist: { x: swapped ? 1280 - x : x, y: 480 }, label: 'Left' });
    const first = chooseControlHand([hand(440), hand(950)], null, { swapped });
    const held = chooseControlHand([hand(700), hand(950)], first, { elapsed: 300 });
    assert.ok(held, 'the genuine held hand can move quickly while the peer remains visible');
    assert.equal(chooseControlHand([hand(850)], held, { elapsed: 250, swapped, fastMotion }), null);
    assert.equal(chooseControlHand([], held, { elapsed: 375, swapped, fastMotion }), null, 'an empty result preserves known peers');
    assert.equal(chooseControlHand([hand(790)], held, { elapsed: 500, swapped, fastMotion }), null,
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
test('grip calibration affects initial hand preference without overriding side or held-hand identity', () => {
  const hand = (x, categoryName = 'Open_Palm') => {
    // A partly visible/ambiguous fist has little useful bend information and
    // needs its classifier score to clear the selected confidence threshold.
    const worldPoints = anatomicalHand({ folded: 0 });
    return { palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left',
      points: projectHand(worldPoints), worldPoints, gesture: { categoryName, score: .6 } };
  };
  const open = hand(490), ambiguousFist = hand(300, 'Closed_Fist'), otherSide = hand(740, 'Closed_Fist');
  const hands = [open, otherSide, ambiguousFist], base = { preferGrip: true, anchor: { x: 500, y: 450 } };
  assert.equal(chooseControlHand(hands, null, base), open, 'the default confidence rejects the ambiguous classifier');
  assert.equal(chooseControlHand(hands, null, { ...base, gripOptions: { confidence: .6 } }), ambiguousFist);
  assert.equal(chooseControlHand(hands, null, { ...base, gripOptions: { confidence: .61 } }), open);
  assert.equal(chooseControlHand([open, otherSide], null, { ...base, gripOptions: { confidence: .6 } }), open,
    'even a confident fist cannot be acquired from the receiver side');
  const nextOpen = hand(520);
  assert.equal(chooseControlHand([ambiguousFist, otherSide, nextOpen], open, { ...base, gripOptions: { confidence: .6 } }), nextOpen,
    'calibration cannot switch an already held hand to another fist');
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

test('a substantial quick flick may finish within 90 ms without allowing small or reversed movements', () => {
  for (const direction of [1, -1]) {
    const start = { x: direction > 0 ? 350 : 900, y: 450 }, target = { x: start.x + 600 * direction };
    const attempt = (time, travel, dy = 0) => {
      const g = new TossGesture(); g.begin(start, 1000);
      return g.release({ x: start.x + travel * direction, y: start.y + dy }, 1000 + time, target);
    };
    for (const duration of [60, 80]) {
      assert.equal(attempt(duration, 350, -30).ok, true);
      assert.equal(attempt(duration, 50).ok, false, 'a short wobble is insufficient');
      assert.equal(attempt(duration, 0).ok, false);
      assert.equal(attempt(duration, -350).ok, false);
      assert.equal(attempt(duration, 30, -300).ok, false, 'fast vertical motion is insufficient');
    }
    assert.equal(attempt(20, 350).ok, false, 'an implausibly short observation remains rejected');
  }
});

test('release preview leaves the hold and samples intact until the actual release', () => {
  const g = new TossGesture(); g.begin({ x: 350, y: 450 }, 1000);
  g.move({ x: 390, y: 440 }, 1030);
  const before = structuredClone({ active: g.active, start: g.start, history: g.history });
  const preview = g.previewRelease({ x: 700, y: 410 }, 1080, { x: 1000 });
  assert.deepEqual(preview, { ok: true, fast: true });
  assert.deepEqual({ active: g.active, start: g.start, history: g.history }, before);
  assert.equal(g.previewRelease({ x: 700, y: 410 }, 1080, null).ok, false);
  assert.deepEqual({ active: g.active, start: g.start, history: g.history }, before, 'failed previews cannot cancel the hold either');
  assert.deepEqual(g.release({ x: 700, y: 410 }, 1080, { x: 1000 }), preview);
  assert.equal(g.active, false); assert.deepEqual(g.history, []);
});

test('fast release evidence requires a substantial recent forward swing in either direction', () => {
  for (const direction of [1, -1]) {
    const start = { x: direction > 0 ? 350 : 900, y: 450 }, target = { x: start.x + 600 * direction };
    const attempt = (time, travel, dy = 0) => {
      const g = new TossGesture(); g.begin(start, 1000);
      if (time >= 60) g.move({ x: start.x + 30 * direction, y: start.y - 5 }, 1030);
      return g.previewRelease({ x: start.x + travel * direction, y: start.y + dy }, 1000 + time, target);
    };
    assert.deepEqual(attempt(80, 350, -30), { ok: true, fast: true });
    assert.equal(attempt(120, 180).fast, true);
    assert.deepEqual(attempt(200, 180), { ok: true, fast: false }, 'ordinary throws keep two-observation confirmation');
    assert.equal(attempt(80, 120).fast, false, 'a short but quick movement is not strong enough evidence');
    assert.equal(attempt(120, 180, -400).fast, false, 'predominantly vertical movement cannot bypass confirmation');
    assert.equal(attempt(80, -350).ok, false);
    assert.equal(attempt(20, 350).ok, false);
    assert.equal(attempt(100, 0).ok, false);
    const stopped = new TossGesture(); stopped.begin(start, 1000);
    stopped.move({ x: start.x + 350 * direction, y: 420 }, 1080);
    assert.equal(stopped.previewRelease({ x: start.x + 350 * direction, y: 420 }, 1240, target).fast, true);
    assert.deepEqual(stopped.previewRelease({ x: start.x + 350 * direction, y: 420 }, 1241, target), { ok: true, fast: false },
      'a previous fast swing expires before an unrelated open-hand classification');
  }
});

test('a single large jump from a stationary hold cannot bypass open-hand confirmation', () => {
  for (const direction of [1, -1]) {
    const start = { x: direction > 0 ? 440 : 840, y: 450 }, target = { x: start.x + 600 * direction };
    for (const stationarySample of [false, true]) {
      const g = new TossGesture(); g.begin(start, 1000);
      if (stationarySample) g.move(start, 1050);
      const point = { x: start.x + 460 * direction, y: 450 };
      assert.deepEqual(g.previewRelease(point, 1100, target), { ok: true, fast: false });
      assert.equal(g.active, true, 'normal two-observation confirmation can still finish the throw');
    }
  }
});

test('tiny, stale, vertical, and reverse prior movements cannot certify a later fast jump', () => {
  const start = { x: 350, y: 450 }, target = { x: 1000 };
  for (const [point, movedAt, openedAt] of [
    [{ x: 360, y: 450 }, 1030, 1100],
    [{ x: 390, y: 450 }, 1010, 1100],
    [{ x: 390, y: 450 }, 1050, 1300],
    [{ x: 390, y: 550 }, 1050, 1150],
    [{ x: 310, y: 450 }, 1050, 1150],
  ]) {
    const g = new TossGesture(); g.begin(start, 1000); g.move(point, movedAt);
    assert.deepEqual(g.previewRelease({ x: 800, y: 450 }, openedAt, target), { ok: true, fast: false });
  }
  const highRate = new TossGesture(); highRate.begin(start, 1000);
  for (let step = 1; step <= 4; step++) highRate.move({ x: 350 + step * 10, y: 450 }, 1000 + step * 8);
  assert.equal(highRate.previewRelease({ x: 750, y: 450 }, 1080, target).fast, true,
    'several short camera intervals can together establish earlier forward motion');
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

test('the same observed throw keeps its outcome from 15 through 120 recognition frames per second', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const direction of [1, -1]) {
      for (const speed of [120, 200, 1800]) {
        const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
        const start = { x: direction > 0 ? 200 : 1080, y: 450 }, duration = 300;
        const point = time => ({ x: start.x + speed * time / 1000 * direction, y: 450 });
        g.begin(start, 1000);
        for (let time = 1000 / fps; time < duration - 1e-8; time += 1000 / fps) g.move(point(time), 1000 + time);
        const result = g.diagnostics(point(duration), 1000 + duration, { x: start.x + 900 * direction });
        assert.equal(result.ok, speed >= 160, `${fps} fps at ${speed} px/s, direction ${direction}`);
        assert.equal(result.fast, speed === 1800, 'extra samples do not change fast-release eligibility');
        if (speed >= 160) assert.ok(Math.abs(result.speed - speed) < 1e-7);
      }
    }
  }
});

test('a natural wind-up releases from its most recent observed forward pivot in either direction', () => {
  for (const direction of [1, -1]) {
    const origin = direction > 0 ? 500 : 780;
    const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
    g.begin({ x: origin, y: 450 }, 1000);
    for (const [offset, time] of [[-100, 1100], [-150, 1200], [-100, 1250]]) {
      g.move({ x: origin + offset * direction, y: 450 }, time);
    }
    const result = g.diagnostics({ x: origin - 50 * direction, y: 450 }, 1300, { x: origin + 500 * direction });
    assert.equal(result.ok, true, 'release need not cross the original grab position');
    assert.equal(result.travel, 100);
    assert.equal(result.distance, 100);
    assert.equal(result.duration, 100);
    assert.equal(result.speed, 1000);
    assert.equal(result.fast, false, 'a wind-up cannot turn ordinary movement into a fast bypass');
  }
});

test('sample rate does not change a wind-up, a retreating release or an expired throw', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const direction of [1, -1]) {
      const origin = direction > 0 ? 500 : 780, target = { x: origin + 500 * direction };
      const offset = time => time <= 200 ? -.75 * time : -150 + .5 * (time - 200);
      const makeThrow = () => {
        const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
        g.begin({ x: origin, y: 450 }, 1000);
        const times = new Set([200, 400]);
        for (let time = 1000 / fps; time < 400 - 1e-8; time += 1000 / fps) times.add(time);
        for (const time of [...times].sort((a, b) => a - b)) g.move({ x: origin + offset(time) * direction, y: 450 }, 1000 + time);
        return g;
      };
      const released = { x: origin - 50 * direction, y: 450 };
      assert.equal(makeThrow().previewRelease(released, 1400, target).ok, true, `${fps} fps wind-up`);
      const retreat = { x: released.x - 45 * direction, y: 450 };
      assert.equal(makeThrow().previewRelease(retreat, 1460, target).reason, 'direction', `${fps} fps retreat`);
      const stale = makeThrow();
      for (let time = 1450; time <= 1750; time += 50) stale.move(released, time);
      assert.equal(stale.previewRelease(released, 1750, target).ok, false, `${fps} fps stale swing`);
    }
  }
});

test('a new wind-up cannot borrow speed before its pivot or bypass confirmation with one distant jump', () => {
  const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
  g.begin({ x: 300, y: 450 }, 1000);
  g.move({ x: 500, y: 450 }, 1080);
  g.move({ x: 350, y: 450 }, 1130);
  g.move({ x: 370, y: 450 }, 1330);
  assert.equal(g.previewRelease({ x: 382, y: 450 }, 1450, { x: 1000 }).ok, false, 'old forward speed is not part of the new swing');

  const jump = new TossGesture();
  jump.begin({ x: 400, y: 450 }, 1000);
  jump.move({ x: 250, y: 450 }, 1100);
  assert.deepEqual(jump.previewRelease({ x: 700, y: 450 }, 1200, { x: 1000 }), { ok: true, fast: false });
});

test('several wind-ups use only the latest turn while small tracking jitter leaves the original swing intact', () => {
  const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
  g.begin({ x: 500, y: 450 }, 1000);
  for (const [x, time] of [[300, 1100], [400, 1200], [330, 1300], [390, 1400]]) g.move({ x, y: 450 }, time);
  const result = g.diagnostics({ x: 410, y: 450 }, 1450, { x: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.travel, 80);
  assert.equal(result.duration, 150);

  const noisy = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
  noisy.begin({ x: 200, y: 450 }, 1000);
  noisy.move({ x: 240, y: 450 }, 1100);
  noisy.move({ x: 237, y: 450 }, 1116);
  const jittered = noisy.diagnostics({ x: 280, y: 450 }, 1200, { x: 1000 });
  assert.equal(jittered.ok, true);
  assert.equal(jittered.travel, 80);
  assert.equal(jittered.duration, 200, 'a 3 px wobble does not manufacture a new short flick');
});

test('tiny jitter after stopping cannot refresh an expired swing at any recognition rate', () => {
  for (const fps of [15, 30, 60, 90, 120]) {
    for (const direction of [1, -1]) {
      const origin = direction > 0 ? 200 : 1080, target = { x: origin + 500 * direction };
      const g = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
      g.begin({ x: origin, y: 450 }, 1000);
      for (let index = 1; index / fps < .1; index++) {
        g.move({ x: origin + index / fps * 1000 * direction, y: 450 }, 1000 + index / fps * 1000);
      }
      const stopped = origin + 100 * direction;
      g.move({ x: stopped, y: 450 }, 1100);
      for (let index = 1; index / fps < .35; index++) {
        const jitter = index % 3 === 0 ? -.4 : .1;
        g.move({ x: stopped + jitter * direction, y: 450 }, 1100 + index / fps * 1000);
      }
      const result = g.diagnostics({ x: stopped + .1 * direction, y: 450 }, 1450, target);
      assert.equal(result.ok, false, `${fps} fps stationary jitter, direction ${direction}`);
      assert.equal(result.speed, 0, 'only substantive accumulated movement supplies the last movement time');
    }
  }
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

test('open-palm fallback requires at least three extended fingers instead of merely not being a fist', () => {
  for (const folded of [0, 1, 2, 3, 4]) {
    const world = anatomicalHand({ folded }), projected = projectHand(world);
    assert.equal(handOpen(projected), folded <= 1);
    assert.equal(handOpen(projected, { categoryName: 'None', score: .95 }, world), folded <= 1);
  }
  const ambiguous = anatomicalHand({ folded: 2 });
  assert.equal(handGrip(projectHand(ambiguous)), false);
  assert.equal(handOpen(projectHand(ambiguous)), false, 'not gripping is insufficient positive evidence of a palm');
});

test('open-palm recognition trusts confident classifications and supports calibrated confidence safely', () => {
  const fist = anatomicalHand(), projected = projectHand(fist), palm = anatomicalHand({ folded: 0 });
  const classifier = { categoryName: 'Open_Palm', score: .65 };
  assert.equal(handOpen(projected, classifier, fist), false);
  assert.equal(handOpen(projected, classifier, fist, { confidence: .65 }), true);
  assert.equal(handOpen(projected, classifier, fist, { confidence: .66 }), false);
  assert.equal(handOpen(projected, { ...classifier, score: .95 }, fist), true);
  for (const confidence of [NaN, Infinity, '0', null]) {
    assert.equal(handOpen(projected, classifier, fist, { confidence }), false);
  }
  for (const score of [NaN, Infinity, -1, 1.1, '0.95', null, .49]) {
    assert.equal(handOpen(projected, { ...classifier, score }, fist, { confidence: 0 }), false);
  }
  for (const categoryName of ['Closed_Fist', 'Pointing_Up', 'Thumb_Down', 'Thumb_Up', 'Victory', 'ILoveYou']) {
    assert.equal(handOpen(projectHand(palm), { categoryName, score: .95 }, palm), false,
      'a confident different gesture must not become a geometric false positive');
  }
});

test('open-palm geometry supports tilted hands, rotation and scale with optional world landmarks', () => {
  for (const pitch of [0, 55 * Math.PI / 180, 80 * Math.PI / 180]) {
    const open = anatomicalHand({ folded: 0, pitch }), fist = anatomicalHand({ pitch });
    for (const roll of [-1.2, 0, 1.8]) {
      for (const scale of [300, 1000, 2400]) {
        assert.equal(handOpen(projectHand(open, { roll, scale }), null, open), true);
        assert.equal(handOpen(projectHand(fist, { roll, scale }), null, fist), false);
      }
    }
  }
});

test('open-palm geometry rejects pinches, degenerate chains and invalid input without rejecting a usable 2D fallback', () => {
  const open = anatomicalHand({ folded: 0 }), projected = projectHand(open);
  const pinched = open.map(point => ({ ...point })); pinched[4] = { ...pinched[8] };
  assert.equal(handOpen(projectHand(pinched), null, pinched), false);
  const ambiguous = open.map(point => ({ ...point }));
  for (const base of [5, 9, 13, 17]) {
    ambiguous[base + 1] = { ...ambiguous[base] }; ambiguous[base + 2] = { ...ambiguous[base] };
    ambiguous[base + 3] = { ...ambiguous[base] };
  }
  assert.equal(handOpen(projectHand(ambiguous), null, ambiguous), false);
  const invalidWorld = open.map(point => ({ ...point })); invalidWorld[8].z = NaN;
  assert.equal(handOpen(projected, null, invalidWorld), true);
  assert.equal(handOpen(projected, null, []), true);
  for (const points of [[], Array(21).fill({ x: 0, y: 0 }), projected.map((point, index) => index === 8 ? { x: NaN, y: point.y } : point)]) {
    assert.equal(handOpen(points, { categoryName: 'Open_Palm', score: .95 }), false);
  }
});

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

test('throw calibration can accept a shorter or slower deliberate motion while unconfigured defaults stay unchanged', () => {
  const attempt = (settings, point, time) => {
    const gesture = new TossGesture();
    if (settings) gesture.configure(settings);
    gesture.begin({ x: 350, y: 450 }, 1000);
    return gesture.previewRelease(point, 1000 + time, { x: 1000 });
  };
  assert.equal(attempt(null, { x: 395, y: 450 }, 250).ok, false, 'the historical 200 px/s default is retained');
  assert.equal(attempt({ minSpeed: 160 }, { x: 395, y: 450 }, 250).ok, true);
  assert.equal(attempt({ minSpeed: 190 }, { x: 395, y: 450 }, 250).ok, false);
  assert.equal(attempt(null, { x: 382, y: 450 }, 160).ok, false, 'the historical 40 px default is retained');
  assert.equal(attempt({ minDistance: 32 }, { x: 382, y: 450 }, 160).ok, true);
  assert.equal(attempt({ minDistance: 33 }, { x: 382, y: 450 }, 160).ok, false);
});

test('throw configuration validates limits and keeps earlier valid values when an update is incomplete or invalid', () => {
  const gesture = new TossGesture();
  assert.equal(gesture.configure({ minSpeed: 0, minDistance: 999 }), gesture);
  assert.deepEqual(gesture.settings, { minSpeed: 80, minDistance: 160 });
  gesture.configure({ minSpeed: 1000, minDistance: -20 });
  assert.deepEqual(gesture.settings, { minSpeed: 600, minDistance: 20 });
  for (const invalid of [undefined, null, { minSpeed: NaN, minDistance: Infinity }, { minSpeed: '80', minDistance: null }]) {
    gesture.configure(invalid);
    assert.deepEqual(gesture.settings, { minSpeed: 600, minDistance: 20 });
  }
  gesture.configure({ minSpeed: 160 });
  assert.deepEqual(gesture.settings, { minSpeed: 160, minDistance: 20 });
});

test('diagnostics use the configured release evidence without consuming or rewriting the active hold', () => {
  for (const direction of [1, -1]) {
    const gesture = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
    const start = { x: 500, y: 450 }, point = { x: 500 + direction * 32, y: 450 }, target = { x: 500 + direction * 400 };
    gesture.begin(start, 1000);
    const before = structuredClone(gesture);
    const expected = { ok: true, reason: 'ready', fast: false, speed: 200, travel: 32, distance: 32, duration: 160, gap: 160 };
    assert.deepEqual(gesture.diagnostics(point, 1160, target), expected);
    assert.deepEqual(gesture.diagnostics(point, 1160, target), expected, 'polling the developer overlay is harmless');
    assert.deepEqual(structuredClone(gesture), before);
    const preview = gesture.previewRelease(point, 1160, target);
    assert.deepEqual(preview, { ok: true, fast: false });
    assert.deepEqual(structuredClone(gesture), before);
    assert.deepEqual(gesture.release(point, 1160, target), preview, 'preview and actual release use the same calibration');
    assert.equal(gesture.active, false);
  }
});

test('diagnostics report forward speed separately from total duration and the latest camera gap', () => {
  const gesture = new TossGesture();
  gesture.begin({ x: 350, y: 450 }, 1000);
  gesture.move({ x: 390, y: 450 }, 1040);
  const diagnostic = gesture.diagnostics({ x: 710, y: 450 }, 1120, { x: 1000 });
  assert.deepEqual(diagnostic, { ok: true, reason: 'ready', fast: true, speed: 4000, travel: 360, distance: 360, duration: 120, gap: 80 });
  assert.deepEqual(gesture.previewRelease({ x: 710, y: 450 }, 1120, { x: 1000 }), { ok: true, fast: true });
});

test('the most permissive calibration still rejects no motion, reversal, vertical movement and lost tracking', () => {
  const settings = { minSpeed: 80, minDistance: 20 };
  const cases = [
    [{ x: 350, y: 450 }, 200, { x: 1000 }, 'direction'],
    [{ x: 350, y: 200 }, 200, { x: 1000 }, 'direction'],
    [{ x: 250, y: 450 }, 200, { x: 1000 }, 'direction'],
    [{ x: 600, y: 450 }, 651, { x: 1000 }, 'slow'],
    [{ x: 600, y: 450 }, 200, null, 'no-receiver'],
    [{ x: NaN, y: 450 }, 200, { x: 1000 }, 'cancelled'],
    [{ x: 600, y: 450 }, -1, { x: 1000 }, 'cancelled'],
  ];
  for (const [point, duration, target, reason] of cases) {
    const gesture = new TossGesture().configure(settings);
    gesture.begin({ x: 350, y: 450 }, 1000);
    const before = structuredClone(gesture), diagnostic = gesture.diagnostics(point, 1000 + duration, target);
    assert.equal(diagnostic.ok, false); assert.equal(diagnostic.reason, reason); assert.equal(diagnostic.fast, false);
    for (const key of ['speed', 'travel', 'distance', 'duration', 'gap']) assert.equal(Number.isFinite(diagnostic[key]), true);
    assert.deepEqual(structuredClone(gesture), before);
    assert.deepEqual(gesture.release(point, 1000 + duration, target), { ok: false, reason });
  }
  const reversed = new TossGesture().configure(settings);
  reversed.begin({ x: 350, y: 450 }, 0); reversed.move({ x: 550, y: 450 }, 100);
  assert.equal(reversed.diagnostics({ x: 450, y: 450 }, 200, { x: 1000 }).reason, 'direction');
  assert.deepEqual(new TossGesture().diagnostics({ x: 400, y: 450 }, 100, { x: 1000 }),
    { ok: false, reason: 'cancelled', fast: false, speed: 0, travel: 0, distance: 0, duration: 0, gap: 0 });
});

test('diagnostics distinguish the distance threshold from signed forward travel for diagonal or reversed motion', () => {
  for (const direction of [1, -1]) {
    const gesture = new TossGesture().configure({ minSpeed: 160, minDistance: 32 });
    gesture.begin({ x: 500, y: 450 }, 1000);
    const point = { x: 500 + 30 * direction, y: 480 }, target = { x: 500 + 400 * direction };
    const diagnostic = gesture.diagnostics(point, 1150, target);
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.travel, 30);
    assert.equal(diagnostic.distance, Math.hypot(30, 30));
    assert.ok(diagnostic.distance >= gesture.settings.minDistance,
      'the developer comparison uses the same Euclidean distance as the release gate');
    const reversed = gesture.diagnostics({ x: 500 - 30 * direction, y: 480 }, 1150, target);
    assert.equal(reversed.ok, false); assert.equal(reversed.reason, 'direction');
    assert.equal(reversed.travel, -30); assert.equal(reversed.distance, diagnostic.distance);
    assert.equal(gesture.diagnostics({ x: NaN, y: 480 }, 1150, target).distance, 0);
  }
});

test('grip confidence is adjustable while invalid scores, geometry fallback and deliberate pinching stay guarded', () => {
  const open = anatomicalHand({ folded: 0 }), fist = anatomicalHand(), projected = projectHand(open);
  const classifier = { categoryName: 'Closed_Fist', score: .65 };
  assert.equal(handGrip(projected, false, classifier, open), false);
  assert.equal(handGrip(projected, false, classifier, open, { confidence: .65 }), true);
  assert.equal(handGrip(projected, false, classifier, open, { confidence: .66 }), false);
  for (const confidence of [NaN, Infinity, '0', null]) {
    assert.equal(handGrip(projected, false, classifier, open, { confidence }), false);
  }
  assert.equal(handGrip(projected, false, { ...classifier, score: .49 }, open, { confidence: 0 }), false,
    'the lower confidence bound cannot accept arbitrary low scores');
  assert.equal(handGrip(projected, false, { ...classifier, score: 1.1 }, open, { confidence: .5 }), false);
  assert.equal(handGrip(projectHand(fist), true, { categoryName: 'Open_Palm', score: .65 }, fist), true);
  assert.equal(handGrip(projectHand(fist), true, { categoryName: 'Open_Palm', score: .65 }, fist, { confidence: .65 }), false);
  assert.equal(handGrip(projectHand(fist), false, null, fist, { confidence: .95 }), true, 'geometry remains available at any setting');
});
