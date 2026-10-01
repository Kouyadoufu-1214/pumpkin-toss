import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../public/vendor/three/three.module.js';
import { faceQuaternion, blendOrientation, createPumpkinGeometry, projectedCarvingPoint } from '../public/pumpkin-3d.mjs';

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
test('face pose ignores position and scale and mirrors yaw with the video', () => {
  const source = new THREE.Matrix4().compose(new THREE.Vector3(8, 4, -50), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 3, 0)), new THREE.Vector3(2, 2, 2));
  const result = faceQuaternion({ data: source.toArray() });
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(result));
  near(direction.x, -Math.sin(Math.PI / 3)); near(direction.y, 0); near(direction.z, .5);
});
test('face pitch stays upright and a mirrored roll reverses direction', () => {
  const pitch = new THREE.Matrix4().makeRotationX(.4);
  const q = new THREE.Quaternion().fromArray(faceQuaternion({ data: pitch.toArray() }));
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  near(forward.y, -Math.sin(.4));
  const roll = new THREE.Matrix4().makeRotationZ(.3);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(faceQuaternion({ data: roll.toArray() })));
  near(right.y, -Math.sin(.3));
});
test('non-mirrored video preserves the original head orientation', () => {
  const rotation = new THREE.Matrix4().makeRotationY(.6);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(faceQuaternion({ data: rotation.toArray() }, false)));
  near(forward.x, Math.sin(.6)); near(forward.z, Math.cos(.6));
});
test('bad pose data cannot inject NaN into rendering', () => {
  assert.equal(faceQuaternion(null), null);
  assert.equal(faceQuaternion({ data: [1, 2] }), null);
  assert.equal(faceQuaternion({ data: Array(16).fill(NaN) }), null);
});
test('orientation smoothing takes the short path across 180 degrees', () => {
  const a = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI - .05, 0));
  const b = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI + .05, 0));
  const halfway = new THREE.Quaternion().fromArray(blendOrientation(a.toArray(), b.toArray(), .5));
  assert.ok(a.angleTo(halfway) < .06);
  near(halfway.length(), 1);
});
test('carving targets the front surface even after the pumpkin is rotated', () => {
  const mesh = new THREE.Mesh(createPumpkinGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.rotation.y = .55; mesh.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(0, .15, 5), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObject(mesh)[0]; assert.ok(hit);
  const local = mesh.worldToLocal(hit.point.clone());
  assert.ok(local.z > .5); assert.ok(local.x < -.2);
  const point = projectedCarvingPoint(local);
  assert.ok(point.x > 0 && point.x < 256); assert.ok(point.y > 0 && point.y < 287);
  mesh.geometry.dispose(); mesh.material.dispose();
});
test('pumpkin mesh is a closed-volume shape with visible front and back surfaces', () => {
  const geometry = createPumpkinGeometry();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld();
  const front = new THREE.Raycaster(new THREE.Vector3(.12, .1, 5), new THREE.Vector3(0, 0, -1)).intersectObject(mesh)[0];
  const back = new THREE.Raycaster(new THREE.Vector3(.12, .1, -5), new THREE.Vector3(0, 0, 1)).intersectObject(mesh)[0];
  assert.ok(front.point.z > .8); assert.ok(back.point.z < -.8);
  geometry.dispose(); mesh.material.dispose();
});
