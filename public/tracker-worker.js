// The classic worker provides the CommonJS export object. CPU inference stays
// here so camera drawing and mouse controls remain responsive during detection.
self.exports = {};
let bundleError = null;
try { importScripts('./vendor/vision_bundle.js'); }
catch (error) { bundleError = String(error); }
let faceTask = null, handTask = null;
let faceEngine = 'unavailable', handEngine = 'unavailable';
let faceError = null, handError = null, handWarning = null;
const status = () => ({ faceEngine, handEngine, faceError, handError, handWarning });
const asset = name => new URL(`./vendor/${name}`, self.location.href).href;
function closeTask(task) {
  try { task?.close(); } catch { /* A failed model must not stop the other one. */ }
}

async function initialize({ detectHands = true, numHands = 4 }) {
  closeTask(faceTask); closeTask(handTask);
  faceTask = handTask = null;
  faceEngine = 'unavailable'; handEngine = detectHands ? 'unavailable' : 'disabled';
  faceError = handError = handWarning = null;
  let files;
  try {
    if (bundleError) throw new Error(bundleError);
    files = await self.exports.FilesetResolver.forVisionTasks(asset('wasm/'));
  } catch (error) {
    faceError = String(error);
    if (detectHands) handError = faceError;
    self.postMessage({ type: 'ready', ...status() });
    return;
  }

  try {
    faceTask = await self.exports.FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: asset('face_landmarker.task'), delegate: 'CPU' },
      runningMode: 'VIDEO', numFaces: 2, minFaceDetectionConfidence: 0.55, minTrackingConfidence: 0.5,
      outputFacialTransformationMatrixes: true,
    });
    faceEngine = 'face-landmarker';
  } catch (error) { faceError = String(error); }

  if (detectHands) {
    // Four hands allow two participants without the target's hands hiding the
    // throwing hand. Mouse mode skips this task completely to reduce CPU use.
    const handOptions = {
      runningMode: 'VIDEO', numHands: Math.max(1, Math.min(4, Number(numHands) || 4)),
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    };
    try {
      handTask = await self.exports.GestureRecognizer.createFromOptions(files, {
        ...handOptions,
        baseOptions: { modelAssetPath: asset('gesture_recognizer.task'), delegate: 'CPU' },
        cannedGesturesClassifierOptions: {
          categoryAllowlist: ['Closed_Fist', 'Open_Palm'], scoreThreshold: 0.5,
        },
      });
      handEngine = 'gesture-recognizer';
    } catch (error) {
      handWarning = String(error);
      try {
        handTask = await self.exports.HandLandmarker.createFromOptions(files, {
          ...handOptions,
          baseOptions: { modelAssetPath: asset('hand_landmarker.task'), delegate: 'CPU' },
        });
        handEngine = 'hand-landmarker';
      } catch (fallbackError) { handError = String(fallbackError); }
    }
  }
  // Ready also means partial availability: live video and manual aiming can
  // continue when either model is missing. Older callers can ignore the fields.
  self.postMessage({ type: 'ready', ...status() });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    await initialize(data);
    return;
  }
  if (data.type === 'frame') {
    let faces = [], matrices = [], hands = [], handedness = [], gestures = [];
    let statusChanged = false;
    try {
      if (faceTask) {
        try {
          const result = faceTask.detectForVideo(data.bitmap, data.time);
          faces = result.faceLandmarks; matrices = result.facialTransformationMatrixes;
        } catch (error) {
          faceError = String(error); faceEngine = 'unavailable';
          closeTask(faceTask); faceTask = null; statusChanged = true;
        }
      }
      if (handTask) {
        try {
          const result = handEngine === 'gesture-recognizer'
            ? handTask.recognizeForVideo(data.bitmap, data.time)
            : handTask.detectForVideo(data.bitmap, data.time);
          hands = result.landmarks; handedness = result.handedness;
          gestures = result.gestures || [];
        } catch (error) {
          handError = String(error); handEngine = 'unavailable';
          closeTask(handTask); handTask = null; statusChanged = true;
        }
      }
      if (statusChanged) self.postMessage({ type: 'status', ...status() });
      self.postMessage({ type: 'result', faces, matrices, hands, handedness, gestures, time: data.time, ...status() });
    } finally { data.bitmap.close(); }
  }
};
