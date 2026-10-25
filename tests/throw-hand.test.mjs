import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyThrowHand, chooseControlHand, handGrip } from '../public/exhibit-logic.mjs';

// Equal mild bends in just two fingers deliberately stop well short of a fist.
function pose({ bent = 0, angle = 35, thumb = 'open' } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: .02, z: 0 }));
  points[0] = { x: 0, y: .08, z: 0 };
  points[1] = { x: -.02, y: .06, z: 0 };
  points[2] = { x: -.04, y: .045, z: 0 };
  points[3] = { x: -.055, y: .03, z: 0 };
  points[4] = { x: -.065, y: .025, z: 0 };
  for (const [index, base] of [5, 9, 13, 17].entries()) {
    const x = (index - 1.5) * .02, theta = index < bent ? angle * Math.PI / 180 : 0;
    points[base] = { x, y: .02, z: 0 };
    points[base + 1] = { x, y: 0, z: 0 };
    points[base + 2] = { x: x + .018 * Math.sin(theta), y: -.018 * Math.cos(theta), z: 0 };
    points[base + 3] = { x: x + .035 * Math.sin(theta), y: -.035 * Math.cos(theta), z: 0 };
  }
  if (thumb === 'tucked') points[4] = { x: 0, y: .03, z: 0 };
  if (thumb === 'pinched') points[4] = { ...points[8] };
  if (thumb === 'bent') points[4] = { x: -.045, y: .04, z: 0 };
  if (thumb === 'tip-only') for (const index of [1, 2, 3]) points[index] = { x: 0, y: .02, z: 0 };
  return points;
}

function project(points, { roll = 0, scale = 1000, mirror = false } = {}) {
  return points.map(({ x, y }) => ({ x: 400 + scale * (mirror ? -1 : 1) * (x * Math.cos(roll) - y * Math.sin(roll)),
    y: 350 + scale * (x * Math.sin(roll) + y * Math.cos(roll)) }));
}

function rotate3D(points, pitch, yaw) {
  return points.map(({ x, y, z }) => {
    const py = y * Math.cos(pitch) - z * Math.sin(pitch), pz = y * Math.sin(pitch) + z * Math.cos(pitch);
    return { x: x * Math.cos(yaw) + pz * Math.sin(yaw), y: py, z: -x * Math.sin(yaw) + pz * Math.cos(yaw) };
  });
}

test('two modest finger curls acquire a pumpkin before the legacy closed-fist gate', () => {
  for (const angle of [32, 35, 45, 90, 145]) {
    const world = pose({ bent: 2, angle }), points = project(world), result = classifyThrowHand(points, null, world);
    assert.equal(result.grip, true, `${angle}-degree curls should acquire`);
    assert.equal(result.open, false);
    assert.equal(result.bentFingers, 2);
    assert.equal(result.extendedFingers, 2);
    assert.ok(result.openness >= 0 && result.openness < 1);
    if (angle <= 45) assert.equal(handGrip(points, false, null, world), false, 'this is not the old two fully folded fingers fixture');
    const imageResult = classifyThrowHand(points);
    assert.ok(Math.abs(imageResult.openness - result.openness) < 1e-12);
    assert.deepEqual({ ...imageResult, openness: result.openness }, result);
  }
});

test('partly open poses form a neutral band instead of releasing as the inverse of grip', () => {
  for (const world of [pose({ bent: 1, angle: 35 }), pose({ bent: 4, angle: 27 })]) {
    const result = classifyThrowHand(project(world), null, world);
    assert.equal(result.grip, false);
    assert.equal(result.open, false);
    assert.ok(result.extendedFingers < 4);
  }
});

test('release needs four fully extended fingers and a separated thumb with sensible noise tolerance', () => {
  for (const angle of [0, 8, 15]) {
    const world = pose({ bent: 4, angle }), result = classifyThrowHand(project(world), null, world);
    assert.equal(result.grip, false);
    assert.equal(result.open, true);
    assert.equal(result.extendedFingers, 4);
    assert.equal(result.thumbOpen, true);
    assert.equal(result.bentFingers, 0);
    if (!angle) assert.equal(result.openness, 1);
  }
  for (const thumb of ['tucked', 'pinched', 'bent']) {
    const world = pose({ thumb }), result = classifyThrowHand(project(world), null, world);
    assert.equal(result.open, false, `${thumb} thumb is not fully open`);
    assert.equal(result.thumbOpen, false, 'diagnostics identify why straight fingers alone do not release');
    assert.equal(result.openness, 1);
    assert.equal(result.grip, false, 'a thumb gesture alone does not manufacture a loose grip');
  }
  const tipOnly = pose({ thumb: 'tip-only' });
  assert.equal(classifyThrowHand(project(tipOnly), null, tipOnly).open, true,
    'integrations supplying only the thumb tip can still show its positive separation');
});

test('misleading classifier labels never override the requested loose-grip and fully-open geometry', () => {
  for (const categoryName of ['Open_Palm', 'Closed_Fist', 'None', 'Victory']) {
    for (const score of [.1, .95, 1, NaN, Infinity]) {
      for (const world of [pose(), pose({ bent: 2 }), pose({ bent: 4, angle: 27 })]) {
        const points = project(world);
        assert.deepEqual(classifyThrowHand(points, { categoryName, score }, world), classifyThrowHand(points, null, world));
      }
    }
  }
});

test('throw classification is roll, mirror and scale independent in image-space fallback', () => {
  for (const bent of [0, 2, 4]) {
    const world = pose({ bent });
    for (const roll of [-2.3, 0, 1.7]) {
      for (const scale of [200, 1000, 4000]) {
        for (const mirror of [false, true]) {
          const result = classifyThrowHand(project(world, { roll, scale, mirror }));
          assert.equal(result.grip, bent >= 2);
          assert.equal(result.open, bent === 0);
        }
      }
    }
  }
});

test('valid world geometry keeps tilted and edge-on curls distinct from an open hand', () => {
  for (const bent of [0, 2, 4]) {
    for (const pitch of [0, 1, Math.PI / 2]) {
      for (const yaw of [0, .9, Math.PI / 2]) {
        const world = rotate3D(pose({ bent }), pitch, yaw);
        const result = classifyThrowHand(project(world, { roll: 1.3, scale: 400 }), null, world);
        assert.equal(result.grip, bent >= 2);
        assert.equal(result.open, bent === 0);
      }
    }
  }
  const sideOn = rotate3D(pose(), 0, Math.PI / 2);
  assert.equal(classifyThrowHand(project(sideOn)).open, false,
    'an ambiguous edge-on image without world landmarks cannot invent thumb separation');
});

test('invalid or collapsed observations cannot grab or release, and invalid optional world data falls back to image geometry', () => {
  const world = pose(), points = project(world), expectedUnknown = { grip: false, open: false, openness: 0, bentFingers: 0, extendedFingers: 0, thumbOpen: false };
  const invalid = points.map(point => ({ ...point })); invalid[8].x = NaN;
  const collapsed = points.map(point => ({ ...point })); collapsed[12] = { ...collapsed[11] };
  for (const input of [null, [], Array(21).fill({ x: 0, y: 0 }), invalid, collapsed]) {
    assert.deepEqual(classifyThrowHand(input, { categoryName: 'Open_Palm', score: 1 }), expectedUnknown);
  }
  const badWorld = world.map(point => ({ ...point })); badWorld[8].z = NaN;
  for (const optionalWorld of [[], badWorld]) assert.deepEqual(classifyThrowHand(points, null, optionalWorld), classifyThrowHand(points));
  assert.deepEqual(classifyThrowHand(invalid, { categoryName: 'Open_Palm', score: 1 }, world), expectedUnknown);
  assert.deepEqual(classifyThrowHand(points, { categoryName: 'Open_Palm', score: 1 }, Array(21).fill({ x: 0, y: 0, z: 0 })), expectedUnknown);
});

test('soft-grip hand preference applies only to initial acquisition and retains side and continuity constraints', () => {
  const hand = (x, bent) => {
    const worldPoints = pose({ bent });
    return { palm: { x, y: 450 }, wrist: { x, y: 480 }, label: 'Left', worldPoints,
      points: project(worldPoints), gesture: { categoryName: 'Open_Palm', score: .99 } };
  };
  const nearOpen = hand(490, 0), looseGrip = hand(300, 2), receiverGrip = hand(740, 2), options = { anchor: { x: 500, y: 450 }, preferSoftGrip: true };
  assert.equal(chooseControlHand([nearOpen, looseGrip, receiverGrip], null, options), looseGrip);
  assert.equal(chooseControlHand([nearOpen, looseGrip, receiverGrip], null, { ...options, preferSoftGrip: false }), nearOpen);
  assert.equal(chooseControlHand([nearOpen, receiverGrip], null, options), nearOpen);
  assert.equal(chooseControlHand([looseGrip, receiverGrip, hand(520, 0)], nearOpen, options).palm.x, 520);
  assert.equal(chooseControlHand([nearOpen, looseGrip, receiverGrip], null, { ...options, swapped: true }), receiverGrip);
});
