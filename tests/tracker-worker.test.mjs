import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../public/tracker-worker.js', import.meta.url), 'utf8');

function harness({ failInit = [], failFrame = [], failBundle = false, failFiles = false } = {}) {
  const messages = [], created = [], detected = [], closed = [];
  const responses = {
    face: { faceLandmarks: [[{ x: .25, y: .3 }]], facialTransformationMatrixes: [{ data: [1, 0, 0] }] },
    gesture: { landmarks: [[{ x: .6, y: .7 }]], worldLandmarks: [[{ x: .02, y: -.01, z: .03 }]], handedness: [[{ categoryName: 'Right' }]], gestures: [[{ categoryName: 'Closed_Fist', score: .94 }]] },
    hand: { landmarks: [[{ x: .6, y: .7 }]], worldLandmarks: [[{ x: .01, y: -.02, z: -.03 }]], handedness: [[{ categoryName: 'Right' }]] },
  };
  const factory = kind => ({
    async createFromOptions(files, options) {
      created.push({ kind, files, options });
      if (failInit.includes(kind)) throw new Error(`${kind} init failure`);
      const infer = (bitmap, time) => {
        detected.push({ kind, bitmap, time });
        if (failFrame.includes(kind)) throw new Error(`${kind} frame failure`);
        return responses[kind];
      };
      return { detectForVideo: infer, recognizeForVideo: infer, close() { closed.push(kind); } };
    },
  });
  const self = { location: { href: 'https://example.test/pumpkin/tracker-worker.js' }, postMessage(message) { messages.push(message); } };
  vm.runInNewContext(worker, {
    self, URL,
    importScripts() {
      if (failBundle) throw new Error('bundle failure');
      self.exports = {
        FilesetResolver: { async forVisionTasks(path) { if (failFiles) throw new Error('wasm failure'); return { path }; } },
        FaceLandmarker: factory('face'), GestureRecognizer: factory('gesture'), HandLandmarker: factory('hand'),
      };
    },
  });
  return {
    messages, created, detected, closed, responses,
    init: options => self.onmessage({ data: { type: 'init', ...options } }),
    async frame(time = 1234) {
      let closes = 0;
      const bitmap = { close() { closes++; } };
      await self.onmessage({ data: { type: 'frame', bitmap, time } });
      assert.equal(closes, 1, 'every transferred frame must be released');
      return messages.at(-1);
    },
  };
}

test('default initialization recognizes gestures for both participants and preserves capture time', async () => {
  const h = harness(); await h.init();
  assert.deepEqual(h.created.map(item => item.kind), ['face', 'gesture']);
  const ready = h.messages.at(-1);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.faceEngine, 'face-landmarker');
  assert.equal(ready.handEngine, 'gesture-recognizer');
  const options = h.created[1].options;
  assert.equal(options.numHands, 4);
  assert.equal(options.baseOptions.delegate, 'CPU');
  assert.equal(options.runningMode, 'VIDEO');
  assert.equal(options.baseOptions.modelAssetPath, 'https://example.test/pumpkin/vendor/gesture_recognizer.task');
  const result = await h.frame(4321);
  assert.equal(result.type, 'result');
  assert.equal(result.time, 4321);
  assert.equal(result.gestures, h.responses.gesture.gestures);
  assert.equal(result.faces, h.responses.face.faceLandmarks);
  assert.equal(result.hands, h.responses.gesture.landmarks);
  assert.equal(result.worldHands, h.responses.gesture.worldLandmarks);
  assert.ok(h.detected.every(item => item.time === 4321));
});

test('mouse mode never initializes or runs either hand model', async () => {
  const h = harness(); await h.init({ detectHands: false });
  assert.deepEqual(h.created.map(item => item.kind), ['face']);
  assert.equal(h.messages.at(-1).handEngine, 'disabled');
  const result = await h.frame();
  assert.deepEqual(h.detected.map(item => item.kind), ['face']);
  assert.equal(result.faces.length, 1);
  assert.equal(result.hands.length, 0);
  assert.equal(result.worldHands.length, 0);
  assert.equal(result.gestures.length, 0);
});

test('missing gesture model falls back to hand landmarks without losing faces', async () => {
  const h = harness({ failInit: ['gesture'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.equal(ready.handEngine, 'hand-landmarker');
  assert.equal(ready.handError, null);
  assert.match(ready.handWarning, /gesture init failure/);
  const result = await h.frame();
  assert.equal(result.faces.length, 1);
  assert.equal(result.hands, h.responses.hand.landmarks);
  assert.equal(result.worldHands, h.responses.hand.worldLandmarks);
  assert.equal(result.gestures.length, 0);
});

test('failure of both hand models still produces face results for mouse throwing', async () => {
  const h = harness({ failInit: ['gesture', 'hand'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.handEngine, 'unavailable');
  assert.match(ready.handError, /hand init failure/);
  const result = await h.frame();
  assert.equal(result.faces.length, 1);
  assert.equal(result.hands.length, 0);
  assert.equal(result.worldHands.length, 0);
});

test('face initialization failure does not prevent gestures from starting', async () => {
  const h = harness({ failInit: ['face'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.equal(ready.faceEngine, 'unavailable');
  assert.match(ready.faceError, /face init failure/);
  assert.equal(ready.handEngine, 'gesture-recognizer');
  const result = await h.frame();
  assert.equal(result.faces.length, 0);
  assert.equal(result.hands.length, 1);
});

test('hand inference failure posts one status and later frames continue face tracking', async () => {
  const h = harness({ failFrame: ['gesture'] }); await h.init();
  const first = await h.frame(100);
  const second = await h.frame(200);
  assert.equal(first.handEngine, 'unavailable');
  assert.equal(second.faces.length, 1);
  assert.equal(second.hands.length, 0);
  assert.equal(second.worldHands.length, 0);
  assert.equal(h.messages.filter(message => message.type === 'status').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 0);
  assert.equal(h.detected.filter(item => item.kind === 'gesture').length, 1);
  assert.deepEqual(h.closed, ['gesture']);
});

test('face inference failure leaves gesture inference alive and releases every frame', async () => {
  const h = harness({ failFrame: ['face'] }); await h.init();
  await h.frame(100);
  const result = await h.frame(200);
  assert.equal(result.faceEngine, 'unavailable');
  assert.equal(result.faces.length, 0);
  assert.equal(result.hands.length, 1);
  assert.equal(h.messages.filter(message => message.type === 'status').length, 1);
  assert.equal(h.detected.filter(item => item.kind === 'face').length, 1);
});

test('shared runtime failure reports unavailable engines without blocking manual camera mode', async () => {
  for (const fault of [{ failBundle: true }, { failFiles: true }]) {
    const h = harness(fault); await h.init({ detectHands: false });
    assert.equal(h.messages.at(-1).type, 'ready');
    assert.equal(h.messages.at(-1).faceEngine, 'unavailable');
    assert.equal(h.messages.at(-1).handEngine, 'disabled');
    const result = await h.frame();
    assert.equal(result.type, 'result');
    assert.equal(result.faces.length, 0);
    assert.equal(result.hands.length, 0);
    assert.equal(result.worldHands.length, 0);
  }
});

test('both hand engines use the more permissive confidence gates and preserve multiple-hand capacity', async () => {
  for (const failInit of [[], ['gesture']]) {
    const h = harness({ failInit }); await h.init();
    const faceOptions = h.created.find(item => item.kind === 'face').options;
    assert.equal(faceOptions.minFaceDetectionConfidence, .4);
    assert.equal(faceOptions.minFacePresenceConfidence, .4);
    assert.equal(faceOptions.minTrackingConfidence, .4);
    for (const { kind, options } of h.created.filter(item => item.kind !== 'face')) {
      assert.equal(options.numHands, 4);
      assert.equal(options.minHandDetectionConfidence, .4);
      assert.equal(options.minHandPresenceConfidence, .4);
      assert.equal(options.minTrackingConfidence, .4);
      if (kind === 'gesture') {
        assert.equal(options.cannedGesturesClassifierOptions.scoreThreshold, .45);
        assert.deepEqual(Array.from(options.cannedGesturesClassifierOptions.categoryAllowlist), ['Closed_Fist', 'Open_Palm']);
      }
    }
  }
});

test('world hand coordinates preserve result order for tilted fists and can be absent in older task results', async () => {
  const h = harness(); await h.init();
  h.responses.gesture.landmarks.push([{ x: .2, y: .3 }]);
  h.responses.gesture.worldLandmarks.push([{ x: -.04, y: .01, z: -.02 }]);
  h.responses.gesture.handedness.push([{ categoryName: 'Left' }]);
  h.responses.gesture.gestures.push([{ categoryName: 'Open_Palm', score: .65 }]);
  const result = await h.frame();
  assert.equal(result.hands.length, 2);
  assert.deepEqual(result.worldHands.map(hand => hand[0].x), [.02, -.04]);
  assert.equal(result.gestures[1][0].categoryName, 'Open_Palm');
  delete h.responses.gesture.worldLandmarks;
  const legacy = await h.frame(1300);
  assert.equal(legacy.worldHands.length, 0);
  assert.equal(legacy.hands.length, 2);
});
