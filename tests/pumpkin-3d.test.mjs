import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/vendor/three/three.module.js';
import { Pumpkin3D, faceQuaternion, blendOrientation, createPumpkinGeometry, projectedCarvingPoint } from '../public/pumpkin-3d.mjs';

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

function renderHarness() {
  const calls = { render: 0, copy: 0 };
  let lost = false;
  const pumpkin = Object.assign(Object.create(Pumpkin3D.prototype), {
    disposed: false, renderError: null, wallsDirty: false,
    inside: { material: {} }, place() {},
    renderer: {
      getContext: () => ({ isContextLost: () => lost }),
      render() { calls.render++; }, domElement: {},
    },
  });
  const context = { drawImage() { calls.copy++; } };
  return { pumpkin, calls, draw: () => pumpkin.draw(context, {}), lose: value => { lost = value; } };
}

test('a lost WebGL context requests fallback and recovers without replacing the artwork', () => {
  const h = renderHarness();
  assert.equal(h.draw(), true);
  h.lose(true);
  assert.equal(h.draw(), false);
  assert.equal(h.draw(), false);
  assert.deepEqual(h.calls, { render: 1, copy: 1 }, 'a transparent lost buffer is never copied');
  h.lose(false);
  assert.equal(h.draw(), true);
  assert.deepEqual(h.calls, { render: 2, copy: 2 });
});

test('context loss during rendering does not copy the empty output', () => {
  const h = renderHarness();
  h.pumpkin.renderer.render = () => h.lose(true);
  assert.equal(h.draw(), false);
  assert.equal(h.calls.copy, 0);
});

test('shader failures and disposed renderers request fallback without copying an empty frame', () => {
  for (const failure of ['shader', 'disposed']) {
    const h = renderHarness();
    if (failure === 'shader') h.pumpkin.renderer.render = () => { h.pumpkin.renderError = new Error('Shader unavailable'); };
    else h.pumpkin.disposed = true;
    assert.equal(h.draw(), false);
    assert.equal(h.draw(), false);
    assert.equal(h.calls.copy, 0);
  }
});

test('unexpected renderer exceptions remain observable by the application fallback', () => {
  const h = renderHarness();
  h.pumpkin.renderer.render = () => { throw new Error('GPU unavailable'); };
  assert.throws(h.draw, /GPU unavailable/);
  assert.equal(h.calls.copy, 0);
});

function fittingHarness(geometry = createPumpkinGeometry(), width = 1280, height = 720) {
  const camera = new THREE.PerspectiveCamera(40, width / height, 1, 5000);
  camera.position.z = height / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
  camera.updateMatrixWorld();
  return Object.assign(Object.create(Pumpkin3D.prototype), { geometry, width, height, camera, root: new THREE.Group() });
}

function projectedShellBox(pumpkin, pose, face) {
  pumpkin.place(pose);
  const vertices = pumpkin.geometry.attributes.position, point = new THREE.Vector3();
  const cos = Math.cos(face.roll || 0), sin = Math.sin(face.roll || 0);
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  // Independently project EVERY vertex through the real place() method. The
  // production fit only sees a small cached subset of those vertices.
  for (let i = 0; i < vertices.count; i++) {
    point.fromBufferAttribute(vertices, i).applyMatrix4(pumpkin.root.matrixWorld).project(pumpkin.camera);
    const x = (point.x + 1) * pumpkin.width / 2 - face.x, y = (1 - point.y) * pumpkin.height / 2 - face.y;
    const u = x * cos + y * sin, v = -x * sin + y * cos;
    left = Math.min(left, u); right = Math.max(right, u); top = Math.min(top, v); bottom = Math.max(bottom, v);
  }
  return { w: right - left, h: bottom - top, x: (left + right) / 2, y: (top + bottom) / 2 };
}

function deliveryShell() {
  const bytes = readFileSync(new URL('../public/pumpkin-higgsfield.glb', import.meta.url));
  const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  const meshIndex = gltf.meshes.findIndex(mesh => mesh.name === 'pumpkin-shell');
  const accessor = gltf.accessors[gltf.meshes[meshIndex].primitives[0].attributes.POSITION];
  const view = gltf.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126); assert.equal(view.byteStride, undefined);
  const begin = 28 + jsonLength + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const array = new Float32Array(bytes.buffer.slice(bytes.byteOffset + begin, bytes.byteOffset + begin + accessor.count * 12));
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(array, 3));
  const node = gltf.nodes.find(item => item.mesh === meshIndex);
  assert.ok(!gltf.nodes.some(item => item.children?.includes(gltf.nodes.indexOf(node))), 'delivery shell has no parent transform');
  const transform = node.matrix ? new THREE.Matrix4().fromArray(node.matrix) : new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node.translation || [0, 0, 0]), new THREE.Quaternion().fromArray(node.rotation || [0, 0, 0, 1]), new THREE.Vector3().fromArray(node.scale || [1, 1, 1]),
  );
  return geometry.applyMatrix4(transform);
}

function assertFaceFit(pumpkin, face, options = {}) {
  const pose = pumpkin.fitFacePose(face, options); assert.ok(pose);
  const box = projectedShellBox(pumpkin, pose, face);
  const scale = options.scale ?? 1;
  const w = face.w * 1.1 * scale * (options.shape === 'wide' ? 1.22 : 1);
  const h = face.h * 1.1 * scale * (options.shape === 'tall' ? 1.18 : 1);
  assert.ok(Math.abs(box.w / w - 1) < .025, `width ${box.w}, expected ${w}`);
  assert.ok(Math.abs(box.h / h - 1) < .025, `height ${box.h}, expected ${h}`);
  assert.ok(Math.abs(box.x) < Math.max(1, w * .01), `horizontal center ${box.x}`);
  assert.ok(Math.abs(box.y) < Math.max(1, h * .01), `vertical center ${box.y}`);
  return { pose, box };
}

test('face fit follows distant and nearby faces using the actual shell projection without fixed size clamps', () => {
  for (const geometry of [createPumpkinGeometry(), deliveryShell()]) {
    const pumpkin = fittingHarness(geometry);
    for (const face of [
      { x: 640, y: 360, w: 20, h: 30 }, { x: 950, y: 300, w: 80, h: 120 },
      { x: 320, y: 360, w: 240, h: 320 }, { x: 720, y: 360, w: 430, h: 510 },
    ]) assertFaceFit(pumpkin, face);
    geometry.dispose();
  }
});

test('face fit uses the same roll-free screen basis for yaw, pitch, and sideways heads', () => {
  const pumpkin = fittingHarness(deliveryShell());
  for (const [pitch, yaw, rotation, w] of [[0, .8, 0, 100], [.4, .6, .65, 110], [-.5, -.7, -1.1, 90], [0, 1.4, 0, 75], [0, 0, Math.PI / 2, 130]]) {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, -rotation, 'YXZ'));
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    const face = { x: 870, y: 330, w, h: 180, roll: Math.atan2(axis.x, axis.y), quaternion: quaternion.toArray() };
    const { pose } = assertFaceFit(pumpkin, face);
    near(new THREE.Quaternion().fromArray(pose.quaternion).angleTo(quaternion), 0, 1e-6);
  }
  pumpkin.geometry.dispose();
});

test('shape choices preserve face coverage and their canvas fallback has the same visible dimensions', () => {
  const pumpkin = fittingHarness();
  const face = { x: 640, y: 360, w: 130, h: 180, roll: .55 };
  for (const shape of ['round', 'tall', 'wide']) {
    const { pose, box } = assertFaceFit(pumpkin, face, { shape, scale: 1.15 });
    assert.ok(box.w > face.w && box.h > face.h);
    near(pose.fallback.w * .78, face.w * 1.1 * 1.15 * (shape === 'wide' ? 1.22 : 1));
    near(pose.fallback.h * .8, face.h * 1.1 * 1.15 * (shape === 'tall' ? 1.18 : 1));
    near(pose.fallback.x, face.x); near(pose.fallback.y, face.y); near(pose.fallback.roll, face.roll);
  }
  pumpkin.geometry.dispose();
});

test('fitting does not move the render root and refreshes cached support points after asset replacement', () => {
  const pumpkin = fittingHarness();
  pumpkin.root.position.set(10, 20, 30); pumpkin.root.scale.set(2, 3, 4);
  const face = { x: 640, y: 360, w: 130, h: 180 };
  const original = pumpkin.geometry, positions = original.attributes.position;
  let reads = 0; const getX = positions.getX.bind(positions);
  positions.getX = index => { reads++; return getX(index); };
  const initial = pumpkin.fitFacePose(face);
  assert.ok(reads > positions.count);
  reads = 0; pumpkin.fitFacePose(face);
  assert.equal(reads, 0, 'steady-state fitting uses cached shell points');
  assert.deepEqual(pumpkin.root.position.toArray(), [10, 20, 30]);
  assert.deepEqual(pumpkin.root.scale.toArray(), [2, 3, 4]);
  pumpkin.geometry = deliveryShell();
  const replacement = assertFaceFit(pumpkin, face).pose;
  assert.notEqual(initial.h, replacement.h);
  original.dispose(); pumpkin.geometry.dispose();
});

test('degenerate side-on fits stay finite and invalid measurements do not reach rendering', () => {
  const pumpkin = fittingHarness();
  for (const quaternion of [
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)).toArray(),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)).toArray(),
  ]) {
    const face = { x: 640, y: 360, w: 250, h: 120, quaternion };
    const pose = pumpkin.fitFacePose(face);
    assert.ok(pose && [pose.x, pose.y, pose.w, pose.h].every(Number.isFinite));
    assert.ok(pose.w > 0 && pose.w < 2000 && pose.h > 0 && pose.h < 2000);
    const box = projectedShellBox(pumpkin, pose, face);
    assert.ok(box.w >= face.w && box.h >= face.h);
  }
  for (const face of [null, { x: 1, y: 1, w: 0, h: 2 }, { x: NaN, y: 1, w: 20, h: 30 }, { x: 1, y: 1, w: 20, h: Infinity }]) {
    assert.equal(pumpkin.fitFacePose(face), null);
  }
  assertFaceFit(pumpkin, { x: 640, y: 360, w: 130, h: 180, roll: .5, quaternion: [NaN, 0, 0, 1] });
  pumpkin.geometry.dispose();
});
