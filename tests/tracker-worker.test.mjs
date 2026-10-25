import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(new URL('../public/tracker-worker.js', import.meta.url), 'utf8');

function harness({ failInit = [], failFrame = [], failBundle = false, failFiles = false, costs = { face: 45, gesture: 20, hand: 18 } } = {}) {
  const messages = [], created = [], detected = [], closed = [], events = [];
  let clock = 0;
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
        events.push({ type: `infer-${kind}`, at: clock }); clock += costs[kind] || 0;
        if (failFrame.includes(kind)) throw new Error(`${kind} frame failure`);
        return responses[kind];
      };
      return { detectForVideo: infer, recognizeForVideo: infer, close() { closed.push(kind); } };
    },
  });
  const self = { location: { href: 'https://example.test/pumpkin/tracker-worker.js' }, postMessage(message) { messages.push(message); events.push({ type: message.type, at: clock }); } };
  vm.runInNewContext(worker, {
    self, URL, performance: { now: () => clock },
    importScripts() {
      if (failBundle) throw new Error('bundle failure');
      self.exports = {
        FilesetResolver: { async forVisionTasks(path) { if (failFiles) throw new Error('wasm failure'); return { path }; } },
        FaceLandmarker: factory('face'), GestureRecognizer: factory('gesture'), HandLandmarker: factory('hand'),
      };
    },
  });
  return {
    messages, created, detected, closed, responses, events,
    hands: () => messages.findLast(message => message.type === 'hands'),
    init: options => self.onmessage({ data: { type: 'init', ...options } }),
    async frame(time = 1234, options = {}) {
      let closes = 0;
      const bitmap = { close() { closes++; events.push({ type: 'bitmap-close', at: clock }); } };
      await self.onmessage({ data: { type: 'frame', bitmap, time, ...options } });
      assert.equal(closes, 1, 'every transferred frame must be released');
      return messages.at(-1);
    },
  };
}

test('default initialization uses lighter hand landmarks for both participants and preserves capture time', async () => {
  const h = harness(); await h.init();
  assert.deepEqual(h.created.map(item => item.kind), ['face', 'hand']);
  const ready = h.messages.at(-1);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.faceEngine, 'face-landmarker');
  assert.equal(ready.handEngine, 'hand-landmarker');
  const options = h.created[1].options;
  assert.equal(options.numHands, 4);
  assert.equal(options.baseOptions.delegate, 'CPU');
  assert.equal(options.runningMode, 'VIDEO');
  assert.equal(options.baseOptions.modelAssetPath, 'https://example.test/pumpkin/vendor/hand_landmarker.task');
  const result = await h.frame(4321);
  assert.equal(result.type, 'result');
  assert.equal(result.time, 4321);
  assert.equal(h.hands().time, 4321);
  assert.equal(h.hands().gestures.length, 0);
  assert.equal(result.faces, h.responses.face.faceLandmarks);
  assert.equal(h.hands().hands, h.responses.hand.landmarks);
  assert.equal(h.hands().worldHands, h.responses.hand.worldLandmarks);
  assert.equal(result.hands, undefined, 'frame completion never replays a hand observation');
  assert.ok(h.detected.every(item => item.time === 4321));
});

test('dedicated hand worker neither initializes nor runs face inference', async () => {
  const h = harness({ failInit: ['face'] }); await h.init({ detectFaces: false });
  assert.deepEqual(h.created.map(item => item.kind), ['hand']);
  const ready = h.messages.at(-1);
  assert.equal(ready.faceEngine, 'disabled');
  assert.equal(ready.faceError, null);
  assert.equal(ready.handEngine, 'hand-landmarker');
  for (const time of [1000, 1034, 1068]) {
    const result = await h.frame(time);
    assert.equal(h.hands().time, time);
    assert.equal(result.facesUpdated, false);
    assert.equal(result.faces.length, 0);
    assert.equal(result.faceTime, null);
    assert.equal(result.faceMs, 0);
  }
  assert.deepEqual(h.detected.map(item => item.kind), ['hand', 'hand', 'hand']);
  assert.equal(h.events.find(event => event.type === 'result').at, 18,
    'the hand frame completes without waiting for the 45 ms face inference');
});

test('mouse mode never initializes or runs either hand model', async () => {
  const h = harness(); await h.init({ detectHands: false });
  assert.deepEqual(h.created.map(item => item.kind), ['face']);
  assert.equal(h.messages.at(-1).handEngine, 'disabled');
  await h.frame(100);
  const result = await h.frame(120);
  assert.deepEqual(h.detected.map(item => item.kind), ['face', 'face']);
  assert.equal(result.faces.length, 1);
  assert.equal(result.facesUpdated, true);
  assert.equal(result.faceTime, 120);
  assert.equal(h.hands(), undefined);
  assert.equal(result.handMs, 0);
});

test('completed rounds can pause hand inference without unloading it or losing face tracking', async () => {
  const h = harness(); await h.init();
  await h.frame(1000, { detectHands: false, faceIntervalMs: 100 });
  await h.frame(1050, { detectHands: false, faceIntervalMs: 100 });
  await h.frame(1100, { detectHands: false, faceIntervalMs: 100 });
  assert.deepEqual(h.detected.map(item => item.kind), ['face', 'face']);
  assert.equal(h.hands(), undefined); assert.deepEqual(h.closed, []);
  await h.frame(1200, { detectHands: true, faceIntervalMs: 240 });
  assert.equal(h.hands().time, 1200);
  assert.deepEqual(h.detected.map(item => item.kind), ['face', 'face', 'hand']);
  await h.frame(1340, { detectHands: true, faceIntervalMs: 240 });
  assert.equal(h.messages.at(-1).facesUpdated, true);
});

test('missing hand landmark model falls back to gestures without losing faces or bones', async () => {
  const h = harness({ failInit: ['hand'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.deepEqual(h.created.map(item => item.kind), ['face', 'hand', 'gesture']);
  assert.equal(ready.handEngine, 'gesture-recognizer');
  assert.equal(ready.handError, null);
  assert.match(ready.handWarning, /hand init failure/);
  const result = await h.frame();
  assert.equal(result.faces.length, 1);
  assert.equal(h.hands().hands, h.responses.gesture.landmarks);
  assert.equal(h.hands().worldHands, h.responses.gesture.worldLandmarks);
  assert.equal(h.hands().gestures, h.responses.gesture.gestures);
});

test('failure of both hand models still produces face results for mouse throwing', async () => {
  const h = harness({ failInit: ['gesture', 'hand'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.handEngine, 'unavailable');
  assert.match(ready.handWarning, /hand init failure/);
  assert.match(ready.handError, /gesture init failure/);
  await h.frame(100);
  const result = await h.frame(120);
  assert.equal(result.faces.length, 1);
  assert.equal(result.facesUpdated, true);
  assert.equal(result.faceTime, 120);
  assert.equal(h.hands(), undefined);
});

test('face initialization failure does not prevent hand landmarks from starting', async () => {
  const h = harness({ failInit: ['face'] }); await h.init();
  const ready = h.messages.at(-1);
  assert.equal(ready.faceEngine, 'unavailable');
  assert.match(ready.faceError, /face init failure/);
  assert.equal(ready.handEngine, 'hand-landmarker');
  const result = await h.frame();
  assert.equal(result.faces.length, 0);
  assert.equal(result.facesUpdated, false);
  assert.equal(h.hands().hands.length, 1);
});

test('hand inference failure posts one status and later frames continue face tracking', async () => {
  const h = harness({ failFrame: ['hand'] }); await h.init();
  const first = await h.frame(100);
  const second = await h.frame(200);
  assert.equal(first.handEngine, 'unavailable');
  assert.equal(second.faces.length, 1);
  assert.equal(second.facesUpdated, true);
  assert.equal(second.faceTime, 200);
  assert.equal(h.hands().hands.length, 0);
  assert.equal(h.hands().worldHands.length, 0);
  assert.equal(h.messages.filter(message => message.type === 'status').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 0);
  assert.equal(h.detected.filter(item => item.kind === 'hand').length, 1);
  assert.deepEqual(h.closed, ['hand']);
});

test('face inference failure leaves hand inference alive and releases every frame', async () => {
  const h = harness({ failFrame: ['face'] }); await h.init();
  await h.frame(100);
  const result = await h.frame(200);
  assert.equal(result.faceEngine, 'unavailable');
  assert.equal(result.faces.length, 0);
  assert.equal(h.hands().hands.length, 1);
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
    assert.equal(result.facesUpdated, false);
    assert.equal(result.faceTime, null);
    assert.equal(h.hands(), undefined);
  }
});

test('shared runtime failure leaves explicitly disabled face engine disabled and error-free', async () => {
  for (const fault of [{ failBundle: true }, { failFiles: true }]) {
    const h = harness(fault); await h.init({ detectFaces: false });
    const ready = h.messages.at(-1);
    assert.equal(ready.faceEngine, 'disabled');
    assert.equal(ready.faceError, null);
    assert.equal(ready.handEngine, 'unavailable');
    assert.match(ready.handError, /failure/);
    const result = await h.frame();
    assert.equal(result.faceEngine, 'disabled');
    assert.equal(result.facesUpdated, false);
    assert.equal(result.faceTime, null);
    assert.equal(h.hands(), undefined);
  }
});

test('face detection uses forgiving confidence gates in camera and mouse modes', async () => {
  for (const detectHands of [true, false]) {
    const h = harness(); await h.init({ detectHands });
    const faceOptions = h.created.find(item => item.kind === 'face').options;
    assert.equal(faceOptions.minFaceDetectionConfidence, .3);
    assert.equal(faceOptions.minFacePresenceConfidence, .3);
    assert.equal(faceOptions.minTrackingConfidence, .3);
    assert.equal(faceOptions.numFaces, 2);
    assert.equal(faceOptions.runningMode, 'VIDEO');
    assert.equal(faceOptions.outputFacialTransformationMatrixes, true);
    assert.deepEqual(h.created.map(item => item.kind), detectHands ? ['face', 'hand'] : ['face']);
  }
});

test('both hand engines retain their confidence gates and multiple-hand capacity', async () => {
  for (const failInit of [[], ['hand']]) {
    const h = harness({ failInit }); await h.init();
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

test('both hand engines preserve world-coordinate order and tolerate older task results without it', async () => {
  for (const kind of ['hand', 'gesture']) {
    const h = harness({ failInit: kind === 'gesture' ? ['hand'] : [] }); await h.init();
    const response = h.responses[kind];
    const firstWorldX = response.worldLandmarks[0][0].x;
    response.landmarks.push([{ x: .2, y: .3 }]);
    response.worldLandmarks.push([{ x: -.04, y: .01, z: -.02 }]);
    response.handedness.push([{ categoryName: 'Left' }]);
    response.gestures?.push([{ categoryName: 'Open_Palm', score: .65 }]);
    await h.frame();
    const result = h.hands();
    assert.equal(result.hands.length, 2);
    assert.deepEqual(result.worldHands.map(hand => hand[0].x), [firstWorldX, -.04]);
    if (kind === 'gesture') assert.equal(result.gestures[1][0].categoryName, 'Open_Palm');
    else assert.equal(result.gestures.length, 0);
    delete response.worldLandmarks;
    await h.frame(1300);
    const legacy = h.hands();
    assert.equal(legacy.worldHands.length, 0);
    assert.equal(legacy.hands.length, 2);
  }
});

test('hands arrive before face inference and frame completion releases the bitmap once', async () => {
  const h = harness(); await h.init();
  const result = await h.frame(1000);
  assert.deepEqual(h.events.filter(event => event.type !== 'ready'), [
    { type: 'infer-hand', at: 0 }, { type: 'hands', at: 18 },
    { type: 'infer-face', at: 18 }, { type: 'result', at: 63 }, { type: 'bitmap-close', at: 63 },
  ]);
  assert.equal(h.hands().handMs, 18);
  assert.equal(result.handMs, 18); assert.equal(result.faceMs, 45);
  assert.equal(result.faceTime, 1000, 'capture time never uses the worker clock origin');
  for (const field of ['hands', 'worldHands', 'handedness', 'gestures']) assert.equal(field in result, false);
});

test('hand frames do not rerun faces or refresh their age inside the face interval', async () => {
  const h = harness(); await h.init();
  const first = await h.frame(0);
  const skipped = await h.frame(159);
  const next = await h.frame(160);
  assert.equal(first.facesUpdated, true); assert.equal(first.faceTime, 0);
  assert.equal(skipped.facesUpdated, false); assert.equal(skipped.faceTime, 0);
  assert.equal(skipped.faces.length, 0); assert.equal(skipped.matrices.length, 0); assert.equal(skipped.faceMs, 0);
  assert.equal(next.facesUpdated, true); assert.equal(next.faceTime, 160);
  assert.deepEqual(h.detected.filter(item => item.kind === 'face').map(item => item.time), [0, 160]);
  assert.deepEqual(h.detected.filter(item => item.kind === 'hand').map(item => item.time), [0, 159, 160]);
  assert.equal(h.messages.filter(message => message.type === 'hands').length, 3);
});

test('reinitialization clears the face interval and the previous task state', async () => {
  const h = harness(); await h.init(); await h.frame(10000);
  await h.init();
  const result = await h.frame(20);
  assert.equal(result.facesUpdated, true); assert.equal(result.faceTime, 20);
  assert.deepEqual(h.closed, ['face', 'hand']);
  assert.equal(h.hands().time, 20);
});

test('reinitializing as hand-only closes a previous face model and never retains its timestamps', async () => {
  const h = harness(); await h.init(); await h.frame(10000);
  await h.init({ detectFaces: false });
  assert.deepEqual(h.closed, ['face', 'hand']);
  const result = await h.frame(20);
  assert.equal(result.faceEngine, 'disabled');
  assert.equal(result.facesUpdated, false);
  assert.equal(result.faceTime, null);
  assert.equal(result.faceMs, 0);
  assert.equal(h.hands().time, 20);
  assert.equal(h.detected.filter(item => item.kind === 'face').length, 1);
});
