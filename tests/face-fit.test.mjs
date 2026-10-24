import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_OVAL, measureFace, faceCoverRegion, faceCoverSize, fallbackFacePose, manualFaceTarget, smoothFacePose } from '../public/face-fit.mjs';

function oval({ x = 800, y = 320, w = 120, h = 170, roll = 0 } = {}) {
  const points = [];
  FACE_OVAL.forEach((index, i) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / FACE_OVAL.length;
    const u = Math.cos(angle) * w / 2, v = Math.sin(angle) * h / 2;
    points[index] = { x: x + u * Math.cos(roll) - v * Math.sin(roll), y: y + u * Math.sin(roll) + v * Math.cos(roll) };
  });
  return points;
}
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ~= ${expected}`);

test('face width comes from the whole oval, even when cheek anchors are narrower', () => {
  const points = oval();
  points[234].x = 780; points[454].x = 820;
  const face = measureFace(points);
  near(face.x, 800); near(face.y, 320); near(face.w, 120); near(face.h, 170);
  assert.equal(face.measured, true);
});

test('tilting the head does not inflate width and mirror reverses the tilt', () => {
  for (const roll of [-1, -.5, 0, .4, 1]) {
    const points = oval({ roll });
    const face = measureFace(points), mirror = measureFace(points, p => ({ x: 1280 - p.x, y: p.y }));
    near(face.w, 120); near(face.h, 170); near(face.roll, roll);
    near(mirror.w, 120); near(mirror.h, 170); near(mirror.roll, -roll);
    near(mirror.x, 480); near(mirror.y, 320);
  }
});

test('camera distance scales the face and fallback shell without a fixed pixel floor or ceiling', () => {
  for (const ratio of [.15, .5, 1, 3, 4]) {
    const face = measureFace(oval({ w: 120 * ratio, h: 170 * ratio }));
    const pose = fallbackFacePose(face);
    near(pose.w * .78, face.w * 1.48 * 1.1); near(pose.h * .8, face.h * 1.52 * 1.1);
  }
});

test('letterboxing and normalised video coordinates are handled by the supplied mapping', () => {
  const points = oval({ x: .6, y: .4, w: .12, h: .2, roll: 0 });
  const face = measureFace(points, p => ({ x: 160 + p.x * 960, y: p.y * 720 }));
  near(face.x, 736); near(face.y, 288); near(face.w, 115.2); near(face.h, 144);
});

test('missing, collapsed or nonfinite face landmarks cannot create an enormous or invalid mask', () => {
  assert.equal(measureFace(null), null); assert.equal(measureFace([]), null);
  assert.equal(measureFace(oval({ w: 0 })), null);
  const points = oval(); points[10].x = NaN;
  assert.equal(measureFace(points), null);
  assert.equal(measureFace(oval(), () => ({ x: Infinity, y: 0 })), null);
});

test('wide and tall artwork keep their character without narrowing the face covering axis', () => {
  const face = { w: 120, h: 170 };
  const normal = faceCoverSize(face), wide = faceCoverSize(face, { shape: 'wide' }), tall = faceCoverSize(face, { shape: 'tall' });
  near(wide.h, normal.h); assert.ok(wide.w > normal.w);
  near(tall.w, normal.w); assert.ok(tall.h > normal.h);
  near(faceCoverSize(face, { scale: 1.2 }).w, normal.w * 1.2);
});

test('the default head envelope covers crown, temples, ears and chin beyond the measured face', () => {
  const face = { x: 800, y: 330, w: 120, h: 170 };
  const head = faceCoverRegion(face);
  // These independent points describe visible head parts outside FaceLandmarker's
  // forehead/cheek oval. Fitting the former 1.10x face box cannot cover them.
  const headParts = [[0, -.94], [-.4, -.8], [.4, -.8], [-.66, -.4], [.66, -.4], [-.72, 0], [.72, 0], [-.62, .18], [.62, .18], [-.3, .48], [.3, .48], [0, .54]];
  for (const [x, y] of headParts) {
    const u = x * face.w / (head.w / 2), v = (face.y + y * face.h - head.y) / (head.h / 2);
    assert.ok(u * u + v * v <= 1, `head part ${x}, ${y} must be covered`);
  }
  near(head.x, face.x); near(head.y, face.y - face.h * .19);
  assert.ok(head.w > face.w * 1.5 && head.h > face.h * 1.6);
});

test('head coverage shifts toward the crown after rotation or mirroring, without changing measured face roles', () => {
  for (const roll of [-.7, 0, .7, Math.PI / 2]) {
    const face = measureFace(oval({ roll }));
    const saved = { ...face }, head = faceCoverRegion(face), fallback = fallbackFacePose(face);
    near(head.x, face.x + Math.sin(roll) * face.h * .19);
    near(head.y, face.y - Math.cos(roll) * face.h * .19);
    near(fallback.x, head.x); near(fallback.y, head.y); near(fallback.roll, roll);
    assert.deepEqual(face, saved, 'role selection still receives the real face center');
    for (const point of head.points) near((point.x / (head.w / 2)) ** 2 + (point.y / (head.h / 2)) ** 2, 1);
  }
});

test('larger hairstyles can use the full 160 percent range while reset keeps the new head-covering default', () => {
  const face = { x: 800, y: 330, w: 120, h: 170 };
  const base = faceCoverRegion(face), large = faceCoverRegion(face, { scale: 1.6 });
  near(large.w / base.w, 1.6); near(large.h / base.h, 1.6);
  near(faceCoverRegion(face, { scale: Infinity }).w, base.w);
  near(faceCoverRegion(face, { scale: 100 }).w, large.w);
});

test('clicking either face preserves that face size and unrecognised clicks reuse the current measured size', () => {
  const small = measureFace(oval({ x: 300, w: 70, h: 100 }));
  const large = measureFace(oval({ x: 950, w: 220, h: 300, roll: .3 }));
  const manual = manualFaceTarget({ x: 970, y: 315 }, [small, large], small);
  near(manual.w, large.w); near(manual.roll, .3); assert.equal(manual.manual, true);
  near(manualFaceTarget({ x: 640, y: 650 }, [], large).w, large.w);
  near(manualFaceTarget({ x: 640, y: 650 }, [], null).w, 110);
});

test('face smoothing has the same response at 30, 60 and 120 fps and follows the short angle arc', () => {
  const start = { x: 300, y: 220, w: 80, h: 120, roll: Math.PI - .05 };
  const target = { x: 600, y: 400, w: 300, h: 400, roll: -Math.PI + .05 };
  const blend = () => null;
  const results = [30, 60, 120].map(fps => {
    let pose = { ...start, fallback: { ...start } };
    for (let i = 0; i < fps / 2; i++) pose = smoothFacePose(pose, { ...target, fallback: { ...target } }, 1000 / fps, blend);
    return pose;
  });
  for (const pose of results) {
    near(pose.w, results[0].w); near(pose.x, results[0].x); near(pose.fallback.w, pose.w);
    assert.ok(pose.roll > Math.PI, 'roll crosses the nearby boundary instead of spinning');
  }
  assert.equal(smoothFacePose(start, null, 16, blend), null);
  assert.notEqual(smoothFacePose(null, target, 16, blend), target);
});

test('losing the 3D renderer continues at the already visible fallback size', () => {
  const fallback = { x: 900, y: 300, w: 220, h: 260, roll: .3 };
  const previous = { x: 870, y: 310, w: 400, h: 330, fallback };
  const result = smoothFacePose(previous, { ...fallback }, 1000 / 60, () => null);
  near(result.w, 220); near(result.h, 260); near(result.x, 900); near(result.y, 300); near(result.roll, .3);
});
