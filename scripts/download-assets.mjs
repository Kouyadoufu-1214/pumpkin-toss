import { mkdir, writeFile, access, copyFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../public/vendor/', import.meta.url));
const cdn = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const files = [
  ['vision_bundle.js', `${cdn}/vision_bundle.cjs`],
  ['mediapipe-LICENSE.txt', 'https://www.apache.org/licenses/LICENSE-2.0.txt'],
  ['wasm/vision_wasm_internal.js', `${cdn}/wasm/vision_wasm_internal.js`],
  ['wasm/vision_wasm_internal.wasm', `${cdn}/wasm/vision_wasm_internal.wasm`],
  ['wasm/vision_wasm_nosimd_internal.js', `${cdn}/wasm/vision_wasm_nosimd_internal.js`],
  ['wasm/vision_wasm_nosimd_internal.wasm', `${cdn}/wasm/vision_wasm_nosimd_internal.wasm`],
  ['face_landmarker.task', 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'],
  ['hand_landmarker.task', 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'],
  ['package.json', `${cdn}/package.json`],
  ['three/three.module.js', 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js'],
  ['three/three.core.js', 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.core.js'],
  ['three/LICENSE', 'https://cdn.jsdelivr.net/npm/three@0.180.0/LICENSE'],
];
for (const [name, url] of files) {
  const destination = path.join(root, name);
  try { await access(destination); console.log(`Already present: ${name}`); continue; } catch {}
  // Reuse the already downloaded bundle; .js also has a JavaScript MIME type on Pages.
  if (name === 'vision_bundle.js') {
    try { await copyFile(path.join(root, 'vision_bundle.cjs'), destination); console.log(`Migrated: ${name}`); continue; } catch {}
  }
  console.log(`Downloading: ${name}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  console.log(`Saved ${bytes.length} bytes`);
}
