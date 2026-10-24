import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clamp, distance, isPinched } from '../public/interaction.mjs';
import { resolveRoles, chooseControlHand, handGrip, TossGesture, DwellAction } from '../public/exhibit-logic.mjs';

const experience = readFileSync(new URL('../public/experience.mjs', import.meta.url), 'utf8');
function section(from, to) {
  const start = experience.indexOf(from), end = experience.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `production section exists: ${from}`);
  return experience.slice(start, end);
}
const executable = [
  section('let source =', 'let audioContext;'),
  'let audioContext;',
  section('const colors =', 'function cue('),
  section('function notice(', 'function openCarving('),
  section('function pointerPoint(', 'function roundRect('),
].join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mediaStream() {
  const track = {
    readyState: 'live', stops: 0, onended: null,
    stop() { this.stops++; this.readyState = 'ended'; },
    getSettings() { return { deviceId: 'usb-camera' }; },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function cameraHarness({ getUserMedia, play } = {}) {
  let now = 1000, timerId = 0;
  const elements = new Map(), timers = new Map(), workers = [], mediaRequests = [], notices = [];
  const effects = { begin: 0, move: 0, release: 0, cancel: 0 };
  const toss = new TossGesture();
  for (const name of Object.keys(effects)) {
    const original = toss[name].bind(toss);
    toss[name] = (...args) => { effects[name]++; return original(...args); };
  }
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, hidden: true, checked: false, disabled: false, value: '', textContent: '', children: [], listeners: new Map(),
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        addEventListener(type, callback) { this.listeners.set(type, callback); },
        contains: () => false, focus() {}, scrollIntoView() {},
        replaceChildren(...children) { this.children = children; }, add(child) { this.children.push(child); },
      });
    }
    return elements.get(id);
  }
  const canvas = element('screen');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 });
  canvas.setPointerCapture = id => { canvas.capturedPointer = id; };
  const video = element('camera-video');
  Object.assign(video, { videoWidth: 1280, videoHeight: 720, readyState: 2, currentTime: 0, srcObject: null });
  video.play = play || (() => Promise.resolve());
  const window = element('window'), document = element('document'); document.hidden = false;
  class FakeWorker {
    constructor(url) { this.url = url; this.messages = []; this.terminated = 0; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated++; }
    emit(data) { this.onmessage?.({ data }); }
    fail() { this.onerror?.({ message: 'model worker failed' }); }
  }
  const context = vm.createContext({
    W: 1280, H: 720, $: element, canvas, video, window, document,
    art: { cancel() {}, base: null }, toss, dwell: new DwellAction(),
    clamp, distance, isPinched, resolveRoles, chooseControlHand, handGrip,
    faceQuaternion: () => null,
    performance: { now: () => now }, getComputedStyle: () => ({ objectFit: 'contain' }),
    matchMedia: () => ({ matches: false }),
    navigator: { mediaDevices: {
      getUserMedia(options) { mediaRequests.push(options); return getUserMedia ? getUserMedia(options) : Promise.resolve(mediaStream()); },
      enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'usb-camera', label: 'USB Camera' }]),
    } },
    Option: function Option(label, value) { this.label = label; this.value = value; }, Worker: FakeWorker,
    setTimeout(callback, duration) { timers.set(++timerId, { callback, duration }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(executable, context);
  return {
    context, elements, element, effects, mediaRequests, workers, video, timers, notices,
    state: () => vm.runInContext('({ source, phase, pointer, heldPose, flight, receiver, manualTarget, stream, worker, workerReady, loading, session })', context),
    run: code => vm.runInContext(code, context),
    setNow: time => { now = time; },
    point: (type, x, y, pointerId = 7) => canvas.listeners.get(type)?.({ clientX: x, clientY: y, pointerId }),
    track: data => context.acceptTracking({ faces: [], hands: [], matrices: [], time: now, ...data }),
    start: (...args) => context.startCamera(...args),
    stop: () => context.stopCamera(),
    attach(media, oldWorker = null) {
      context.existingStream = media; context.existingWorker = oldWorker;
      vm.runInContext('stream = existingStream; video.srcObject = stream; worker = existingWorker;', context);
    },
    ready(worker = workers.at(-1)) { worker.emit({ type: 'ready', faceEngine: 'face-landmarker', handEngine: 'disabled' }); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

function faceLandmarks(cx = .7, cy = .4) {
  const points = Array.from({ length: 468 }, () => ({ x: cx, y: cy }));
  points[234] = { x: cx - .05, y: cy }; points[454] = { x: cx + .05, y: cy };
  points[10] = { x: cx, y: cy - .1 }; points[152] = { x: cx, y: cy + .1 };
  return points;
}

function handLandmarks(x, y, open = false) {
  const points = Array.from({ length: 21 }, () => ({ x, y }));
  points[0] = { x, y: y + 36 };
  points[4] = { x: x - 62, y: y - 12 };
  for (const [base, offset] of [[5, -20], [9, -7], [13, 7], [17, 20]]) {
    points[base] = { x: x + offset, y: y - 18 };
    points[base + 1] = { x: x + offset, y: y - 42 };
    points[base + 2] = { x: x + offset, y: y + (open ? -65 : -10) };
    points[base + 3] = { x: x + offset, y: y + (open ? -90 : 8) };
  }
  return points.map(point => ({ x: point.x / 1280, y: point.y / 720 }));
}

test('a tracked face disappearing during flight or after landing does not become a default target', () => {
  for (const phase of ['flying', 'worn']) {
    const h = cameraHarness(); h.run("source = 'mouse-camera';");
    h.track({ faces: [faceLandmarks(.8, .4)] });
    h.run('launch(restPose(), currentTarget())');
    assert.equal(h.state().flight.target.manual, false);
    h.run(`phase = '${phase}'`);
    h.track({ faces: [] });
    assert.equal(h.state().receiver, null);
    assert.equal(h.run('currentTarget()'), null);
    assert.equal(h.state().flight.target.x, 1024, 'the flight keeps its last intended destination');
    h.track({ faces: [faceLandmarks(.75, .45)] });
    assert.equal(h.state().receiver.x, 960, 'face tracking can resume when the person returns');
  }
});

test('a clicked manual target keeps its position and manual flag throughout flight and landing', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera'; mouseCameraRoles();");
  h.point('pointerdown', 1030, 240);
  h.run('launch(restPose(), currentTarget())');
  assert.equal(h.state().flight.target.manual, true);
  for (const phase of ['flying', 'worn']) {
    h.run(`phase = '${phase}'`);
    h.track({ faces: [faceLandmarks(.3, .6)] });
    h.track({ faces: [] });
    assert.equal(h.state().receiver.x, 1030);
    assert.equal(h.state().receiver.y, 240);
    assert.equal(h.run('currentTarget().manual'), true);
    assert.equal(h.state().receiver, h.state().manualTarget);
  }
});

test('a fist made outside the pumpkin can grab it while still closed and throw at sparse camera intervals', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  const faces = [faceLandmarks(.25, .4), faceLandmarks(.75, .4)];
  const frame = (time, x, y, open = false) => {
    h.setNow(time);
    h.track({ faces, hands: [handLandmarks(x, y, open)],
      handedness: [[{ categoryName: 'Right', score: .99 }]],
      gestures: [[{ categoryName: open ? 'Open_Palm' : 'Closed_Fist', score: .95 }]],
    });
  };
  frame(1000, 180, 430);
  frame(1500, 180, 430);
  assert.equal(h.state().phase, 'ready');
  assert.equal(h.effects.begin, 0, 'an off-pumpkin fist must not grab from a distance');
  frame(1750, 350, 430);
  assert.equal(h.state().phase, 'held', 'moving an already closed hand into reach must grab');
  assert.equal(h.effects.begin, 1);
  frame(2000, 570, 390);
  frame(2250, 790, 350);
  assert.equal(h.state().phase, 'held');
  frame(2500, 840, 340, true);
  assert.equal(h.effects.release, 1);
  assert.equal(h.state().phase, 'flying');
  assert.equal(h.state().flight.target.x, 960);
});

test('face tracking never cancels or releases an active mouse drag over live video', () => {
  const h = cameraHarness();
  h.run("source = 'mouse-camera'; mouseCameraRoles();");
  const rest = h.run('restPose()');
  h.point('pointerdown', rest.x, rest.y);
  const held = h.state().heldPose, cancellations = h.effects.cancel;
  assert.equal(h.state().phase, 'held');
  h.track({ faces: [faceLandmarks()] });
  h.track({ faces: [] });
  assert.equal(h.state().pointer, 7);
  assert.equal(h.state().phase, 'held');
  assert.equal(h.state().heldPose, held);
  assert.equal(h.effects.cancel, cancellations);
  assert.equal(h.effects.release, 0);
  h.setNow(1100); h.point('pointermove', 740, 390);
  h.track({ faces: [] });
  assert.equal(h.state().heldPose.x, 740);
  h.setNow(1140); h.point('pointerup', 850, 360);
  assert.equal(h.effects.release, 1, 'the pointer release is the only throw trigger');
  assert.equal(h.state().pointer, null);
  assert.equal(h.state().phase, 'flying');
});

test('mouse camera has a usable target without faces and a clicked target survives later detection', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera'; mouseCameraRoles();");
  assert.equal(h.state().receiver.manual, true);
  assert.equal(h.state().receiver.sample, false);
  assert.ok(h.run('currentTarget()'));
  h.point('pointerdown', 1030, 240);
  assert.equal(h.state().manualTarget.x, 1030);
  assert.equal(h.state().manualTarget.y, 240);
  assert.equal(h.element('target-auto').hidden, false);
  h.track({ faces: [faceLandmarks(.3, .6)] });
  h.track({ faces: [] });
  assert.equal(h.state().receiver, h.state().manualTarget);
  assert.equal(h.state().receiver.x, 1030);
  assert.equal(h.state().receiver.y, 240);
  assert.equal(h.effects.begin, 0, 'aiming at a face must not grab the pumpkin');
});

test('switching to mouse camera reuses the stream and stops only the previous worker', async () => {
  const h = cameraHarness(), media = mediaStream();
  const previous = { terminated: 0, terminate() { this.terminated++; } };
  h.attach(media, previous);
  const starting = h.start(false, 'mouse'); await h.settle();
  assert.equal(h.mediaRequests.length, 0);
  assert.equal(previous.terminated, 1);
  assert.equal(media.track.stops, 0);
  assert.equal(h.video.srcObject, media);
  assert.equal(h.workers.at(-1).messages[0].detectHands, false);
  h.ready(); await starting;
  assert.equal(h.state().source, 'mouse-camera');
  assert.equal(h.state().stream, media);
  assert.equal(h.state().workerReady, true);
  h.stop();
  assert.equal(media.track.stops, 1);
  assert.equal(h.workers.at(-1).terminated, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.state().stream, null);
});

test('a failed tracking worker leaves the live camera available for mouse throws', async () => {
  const media = mediaStream(), h = cameraHarness({ getUserMedia: () => Promise.resolve(media) });
  const starting = h.start(false, 'hand'); await h.settle();
  h.workers.at(-1).fail(); await starting;
  assert.equal(h.state().source, 'mouse-camera');
  assert.equal(h.state().stream, media);
  assert.equal(h.video.srcObject, media);
  assert.equal(media.track.stops, 0);
  assert.equal(h.state().worker, null);
  assert.equal(h.state().loading, false);
  assert.equal(h.element('loading').hidden, true);
  assert.ok(h.state().receiver, 'mouse throwing remains usable without the detector');
});

test('permission denial exits camera loading cleanly without a worker or attached stream', async () => {
  const error = new Error('permission denied'); error.name = 'NotAllowedError';
  const h = cameraHarness({ getUserMedia: () => Promise.reject(error) });
  await h.start(false, 'mouse');
  assert.equal(h.state().source, 'mouse');
  assert.equal(h.state().stream, null);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.workers.length, 0);
  assert.equal(h.state().loading, false);
  assert.match(h.element('message').textContent, /許可/);
});

test('cancelling while camera permission is pending stops a stream that arrives afterwards', async () => {
  const pending = deferred(), h = cameraHarness({ getUserMedia: () => pending.promise });
  const starting = h.start(false, 'mouse');
  h.stop();
  const late = mediaStream(); pending.resolve(late); await starting;
  assert.equal(late.track.stops, 1);
  assert.equal(h.state().stream, null);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.workers.length, 0);
  assert.equal(h.state().loading, false);
});

test('an older permission request cannot replace or stop the newer camera session', async () => {
  const first = deferred(), second = deferred(); let request = 0;
  const h = cameraHarness({ getUserMedia: () => ++request === 1 ? first.promise : second.promise });
  const oldStart = h.start(false, 'hand');
  const newStart = h.start(false, 'mouse');
  const current = mediaStream(); second.resolve(current); await h.settle();
  h.ready(); await newStart;
  const late = mediaStream(); first.resolve(late); await oldStart;
  assert.equal(late.track.stops, 1);
  assert.equal(current.track.stops, 0);
  assert.equal(h.state().stream, current);
  assert.equal(h.video.srcObject, current);
  assert.equal(h.workers.length, 1);
  assert.equal(h.state().source, 'mouse-camera');
});

test('cancelling model initialization releases its camera and ignores the old worker response', async () => {
  const media = mediaStream(), h = cameraHarness({ getUserMedia: () => Promise.resolve(media) });
  const starting = h.start(false, 'hand'); await h.settle();
  const oldWorker = h.workers.at(-1);
  h.stop(); await starting;
  assert.equal(media.track.stops, 1);
  assert.equal(oldWorker.terminated, 1);
  assert.equal(h.state().stream, null);
  assert.equal(h.state().workerReady, false);
  h.ready(oldWorker);
  assert.equal(h.state().workerReady, false);
  assert.equal(h.video.srcObject, null);
});
