import { cp, mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'dist');
const pages = ['index.html', 'experience.css', 'experience.mjs', 'exhibit-logic.mjs', 'interaction.mjs', 'pumpkin-art.mjs', 'pumpkin-3d.mjs', 'tracker-worker.js', 'diagnostics.html'];
const vendor = ['vision_bundle.js', 'mediapipe-LICENSE.txt', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm', 'face_landmarker.task', 'hand_landmarker.task', 'three/three.module.js', 'three/three.core.js', 'three/LICENSE'];
for (const file of vendor) {
  try { await access(path.join(project, 'public/vendor', file)); }
  catch { throw new Error(`Missing vendor/${file}. Run npm run assets first.`); }
}
await mkdir(output, { recursive: true });
for (const file of pages) await copyFile(path.join(project, 'public', file), path.join(output, file));
for (const file of vendor) {
  const destination = path.join(output, 'vendor', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(project, 'public/vendor', file), destination);
}
await copyFile(path.join(project, 'THIRD_PARTY.md'), path.join(output, 'THIRD_PARTY.md'));
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Built dist/ with the application, local detection models, and third-party notices.');
