# Third-party components

## MediaPipe Tasks Vision 0.10.32

- Package: https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.32
- Source: https://github.com/google-ai-edge/mediapipe
- Package metadata declares the Apache-2.0 license: https://www.apache.org/licenses/LICENSE-2.0
- Distributed files are stored in `public/vendor/vision_bundle.js` and `public/vendor/wasm/`. The upstream CommonJS bundle is renamed to `.js` for static-host JavaScript MIME compatibility; its content is unchanged.
- Apache-2.0 license text is distributed as `public/vendor/mediapipe-LICENSE.txt`.
- Download source: https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/

## Detection models

- Face Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker
- Hand Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
- Face model: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- Hand model: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

The download script stores these models locally. No remote service receives camera frames.
## Three.js 0.180.0

- Source: https://github.com/mrdoob/three.js/tree/r180
- Package: https://www.npmjs.com/package/three/v/0.180.0
- License: MIT, saved in `public/vendor/three/LICENSE`.
- Download source: https://cdn.jsdelivr.net/npm/three@0.180.0/build/

The GLTFLoader and BufferGeometryUtils modules also come from Three.js 0.180.0. The asset download script rewrites only their module import paths for local serving.

## Pumpkin asset (Higgsfield 3D Jutsu)

- `public/pumpkin-higgsfield.glb` was authored for this project in Higgsfield 3D Jutsu on 2026-10-16, revision 2.
- Editable project: https://higgsfield.ai/3d-jutsu/dbfbe1f5-d3c0-4655-bbad-2056a80c442a (owner access may be required).
- Reproducible modeling/material stages: `scripts/higgsfield-pumpkin.py`.
- Original procedural geometry and textures; no catalog models or third-party photos were imported. It contains 16,804 triangles and three embedded 512×512 PBR textures.
- The app loads only the named shell, stem and leaf, using its own camera and lights. Carving and its cut walls are generated locally from the player's drawing; the demo people are drawn using Canvas 2D.
- Higgsfield is used during asset creation. Visitors do not need a Higgsfield account and camera images are not sent to Higgsfield.
