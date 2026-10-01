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

The 3D pumpkin mesh and carving effects are created by the app. The demo character is drawn using Canvas 2D.
