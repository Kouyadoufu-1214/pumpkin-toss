// Run with: node tests/pumpkin-fit.bench.mjs
// Reports CPU fitting cost only; it does not measure camera or browser FPS.
import * as THREE from '../public/vendor/three/three.module.js';
import { Pumpkin3D, createPumpkinGeometry } from '../public/pumpkin-3d.mjs';

const camera = new THREE.PerspectiveCamera(40, 1280 / 720, 1, 5000);
camera.position.z = 720 / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
camera.updateMatrixWorld();
const pumpkin = Object.assign(Object.create(Pumpkin3D.prototype), {
  geometry: createPumpkinGeometry(), width: 1280, height: 720, camera, root: new THREE.Group(),
});
const faces = Array.from({ length: 180 }, (_, i) => ({
  x: 640 + Math.sin(i / 15) * 220, y: 360 + Math.cos(i / 17) * 50,
  w: 120 + Math.sin(i / 13) * 20, h: 170 + Math.sin(i / 13) * 25, roll: Math.sin(i / 21) * .5,
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(
    Math.sin(i / 23) * .4, Math.sin(i / 19) * .8, -Math.sin(i / 21) * .5,
  )).toArray(),
}));
for (let i = 0; i < 360; i++) pumpkin.fitFacePose(faces[i % faces.length]);
const rounds = [];
for (let round = 0; round < 5; round++) {
  const start = performance.now();
  for (let i = 0; i < 1800; i++) pumpkin.fitFacePose(faces[i % faces.length]);
  rounds.push((performance.now() - start) / 1800);
}
console.log(JSON.stringify({ metric: 'CPU ms per exact head-cover fit', rounds, median: [...rounds].sort((a, b) => a - b)[2] }, null, 2));
pumpkin.geometry.dispose();
