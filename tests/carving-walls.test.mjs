import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/vendor/three/three.module.js';
import { createFrontDepth, createCutWalls, createInnerShell } from '../public/carving-walls.mjs';

const bytes = readFileSync(new URL('../public/pumpkin-higgsfield.glb', import.meta.url));
const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const binaryOffset = 28 + jsonLength;
const body = gltf.meshes.find(m => m.name === 'pumpkin-shell').primitives[0];
function attribute(id) {
  const a = gltf.accessors[id], v = gltf.bufferViews[a.bufferView];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const Type = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  assert.ok(Type); assert.equal(v.byteStride, undefined, 'The delivery asset uses tightly packed attributes');
  const begin = binaryOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
  return new THREE.BufferAttribute(new Type(bytes.buffer.slice(bytes.byteOffset + begin, bytes.byteOffset + begin + a.count * components * Type.BYTES_PER_ELEMENT)), components);
}
const shell = new THREE.BufferGeometry();
shell.setAttribute('position', attribute(body.attributes.POSITION)); shell.setIndex(attribute(body.indices));
const surface = createFrontDepth(shell);
const blank = () => ({ data: new Uint8ClampedArray(512 * 512 * 4) });

test('Higgsfield delivery has three named parts, portable embedded PBR textures and a mobile-sized mesh', () => {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.deepEqual(gltf.meshes.map(m => m.name).sort(), ['pumpkin-leaf', 'pumpkin-shell', 'pumpkin-stem']);
  assert.ok(bytes.length < 2_000_000);
  assert.ok(gltf.meshes.reduce((sum, m) => sum + m.primitives.reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0), 0) < 25000);
  const material = gltf.materials[body.material];
  assert.ok(material.normalTexture && material.pbrMetallicRoughness.baseColorTexture && material.pbrMetallicRoughness.metallicRoughnessTexture);
  assert.equal(gltf.images.length, 3);
  for (const image of gltf.images) {
    assert.equal(image.uri, undefined);
    const v = gltf.bufferViews[image.bufferView], start = binaryOffset + (v.byteOffset || 0);
    assert.equal(bytes.toString('ascii', start + 1, start + 4), 'PNG');
    assert.ok(bytes.readUInt32BE(start + 16) <= 1024 && bytes.readUInt32BE(start + 20) <= 1024);
  }
  shell.computeBoundingBox();
  const size = shell.boundingBox.getSize(new THREE.Vector3());
  assert.ok(size.x > 2 && size.x < 2.2 && size.y > 1.6 && size.y < 1.8 && size.z > 2);
  assert.ok(Array.from(shell.attributes.position.array).every(Number.isFinite));
});

test('cut depth agrees with ray intersections of the actual Higgsfield surface', () => {
  const mesh = new THREE.Mesh(shell, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld();
  for (const [gx, gy] of [[128, 110], [90, 120], [160, 166]]) {
    const x = (gx / surface.cells - .5) * 2.45, y = (.56 - gy / surface.cells) * 2.35;
    const hit = new THREE.Raycaster(new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)).intersectObject(mesh)[0];
    assert.ok(hit);
    assert.ok(Math.abs(surface.depth[gy * surface.stride + gx] - hit.point.z) < 1e-5);
  }
  assert.ok(Number.isNaN(surface.depth[0])); mesh.material.dispose();
});

test('inner shell keeps carvings aligned and leaves a physical gap for the cut walls', () => {
  const inner = createInnerShell(shell), a = shell.attributes.position, b = inner.attributes.position;
  for (let i = 0; i < a.count; i++) {
    assert.ok(b.getX(i) === a.getX(i)); assert.ok(b.getY(i) === a.getY(i));
    if (a.getZ(i) > .5) assert.ok(a.getZ(i) - b.getZ(i) > .07);
  }
  inner.dispose();
});

test('smooth freehand holes generate finite sloped walls, and clearing removes all walls', () => {
  const mask = blank();
  for (let y = 150; y < 290; y++) for (let x = 150; x < 290; x++) {
    const distance = Math.hypot(x + .5 - 218, y + .5 - 218);
    mask.data[(y * 512 + x) * 4 + 3] = Math.max(0, Math.min(255, (48 - distance) * 255));
  }
  const walls = createCutWalls(mask, surface), p = walls.attributes.position;
  assert.ok(p.count > 100 && p.count < 6000);
  assert.ok(Array.from(p.array).every(Number.isFinite));
  assert.ok(Array.from(walls.attributes.normal.array).every(Number.isFinite));
  let diagonal = 0;
  for (let i = 0; i < p.count; i += 6) {
    assert.ok(p.getZ(i) > p.getZ(i + 5), 'the back lip sits inside the front lip');
    if (Math.abs(p.getX(i) - p.getX(i + 1)) > 1e-4 && Math.abs(p.getY(i) - p.getY(i + 1)) > 1e-4) diagonal++;
  }
  assert.ok(diagonal > p.count / 12, 'curves must not become axis-aligned pixel stairs');
  const cleared = createCutWalls(blank(), surface); assert.equal(cleared.attributes.position.count, 0);
  walls.dispose(); cleared.dispose();
});
