// The classic worker provides the CommonJS export object. Keeping inference in
// this worker prevents the two CPU models from blocking drawing and controls.
self.exports = {};
importScripts('./vendor/vision_bundle.js');
let faceTask, handTask;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const { FilesetResolver, FaceLandmarker, HandLandmarker } = self.exports;
      const files = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm/', self.location.href).href);
      faceTask = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: new URL('./vendor/face_landmarker.task', self.location.href).href, delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 2, minFaceDetectionConfidence: 0.55, minTrackingConfidence: 0.5,
        outputFacialTransformationMatrixes: true,
      });
      handTask = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: new URL('./vendor/hand_landmarker.task', self.location.href).href, delegate: 'CPU' },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: 'ready' });
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    return;
  }
  if (data.type === 'frame') {
    try {
      const faces = faceTask.detectForVideo(data.bitmap, data.time);
      const hands = handTask.detectForVideo(data.bitmap, data.time);
      self.postMessage({ type: 'result', faces: faces.faceLandmarks, matrices: faces.facialTransformationMatrixes, hands: hands.landmarks, handedness: hands.handedness });
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    finally { data.bitmap.close(); }
  }
};
