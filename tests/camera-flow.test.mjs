import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clamp, distance, isPinched } from '../public/interaction.mjs';
import { resolveRoles, chooseControlHand, classifyThrowHand, TossGesture, DwellAction, HELD_HAND_GRACE_MS } from '../public/exhibit-logic.mjs';
import { FACE_OVAL, measureFace, fallbackFacePose, manualFaceTarget } from '../public/face-fit.mjs';
import { HandMotion, SoftFollow } from '../public/hand-motion.mjs';
import { MotionRelease } from '../public/motion-release.mjs';
import { InferenceRate } from '../public/inference-rate.mjs';
import { RenderPerformance } from '../public/render-performance.mjs';
import { DEFAULT_TRACKING_TUNING, normalizeTrackingTuning } from '../public/tracking-tuning.mjs';

const experience = readFileSync(new URL('../public/experience.mjs', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
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
  section("$('target-auto').onclick", "$('stop-camera').onclick"),
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

function cameraHarness({ getUserMedia, play, videoFrameCallbacks = true } = {}) {
  let now = 1000, timerId = 0;
  const elements = new Map(), timers = new Map(), workers = [], mediaRequests = [], notices = [];
  const videoCallbacks = new Map(), animationCallbacks = new Map();
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
  if (videoFrameCallbacks) {
    video.requestVideoFrameCallback = callback => { videoCallbacks.set(++timerId, callback); return timerId; };
    video.cancelVideoFrameCallback = id => { videoCallbacks.delete(id); };
  }
  const scaleInput = page.match(/<input\b[^>]*\bid="face-fit-scale"[^>]*>/)?.[0];
  assert.ok(scaleInput, 'the fit slider must be available in the actual page');
  for (const name of ['min', 'max', 'value']) element('face-fit-scale')[name] = scaleInput.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
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
    art: { cancel() {}, base: null }, toss, dwell: new DwellAction(), pumpkin: undefined,
    clamp, distance, isPinched, resolveRoles, chooseControlHand, classifyThrowHand, HandMotion, SoftFollow, MotionRelease, InferenceRate, RenderPerformance, HELD_HAND_GRACE_MS,
    normalizeTrackingTuning, loadTrackingTuning: () => ({ ...DEFAULT_TRACKING_TUNING }),
    measureFace, fallbackFacePose, manualFaceTarget,
    faceQuaternion: () => null,
    performance: { now: () => now }, getComputedStyle: () => ({ objectFit: 'contain' }),
    matchMedia: () => ({ matches: false }),
    navigator: { mediaDevices: {
      getUserMedia(options) { mediaRequests.push(options); return getUserMedia ? getUserMedia(options) : Promise.resolve(mediaStream()); },
      enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'usb-camera', label: 'USB Camera' }]),
    } },
    Option: function Option(label, value) { this.label = label; this.value = value; }, Worker: FakeWorker,
    createImageBitmap: async () => ({ close() {} }),
    requestAnimationFrame(callback) { animationCallbacks.set(++timerId, callback); return timerId; },
    cancelAnimationFrame(id) { animationCallbacks.delete(id); },
    setTimeout(callback, duration) { timers.set(++timerId, { callback, duration }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(executable, context);
  return {
    context, elements, element, effects, mediaRequests, workers, video, timers, notices, videoCallbacks, animationCallbacks,
    state: () => vm.runInContext('({ source, phase, pointer, heldPose, flight, faces, caster, receiver, manualTarget, mouseTrackedFace, stream, worker, workerReady, faceWorker, faceWorkerReady, loading, session })', context),
    run: code => vm.runInContext(code, context),
    setNow: time => { now = time; },
    point: (type, x, y, pointerId = 7) => canvas.listeners.get(type)?.({ clientX: x, clientY: y, pointerId }),
    track: data => context.acceptTracking({ faces: [], hands: [], matrices: [], time: now, ...data }),
    receive: data => context.acceptTracking(data),
    start: (...args) => context.startCamera(...args),
    stop: () => context.stopCamera(),
    attach(media, oldWorker = null, oldFaceWorker = null) {
      context.existingStream = media; context.existingWorker = oldWorker; context.existingFaceWorker = oldFaceWorker;
      vm.runInContext('stream = existingStream; video.srcObject = stream; worker = existingWorker; faceWorker = existingFaceWorker;', context);
    },
    ready(worker) {
      for (const selected of worker ? [worker] : workers.filter(item => !item.terminated)) {
        const init = selected.messages.find(message => message.type === 'init') || {};
        selected.emit({ type: 'ready', faceEngine: init.detectFaces === false ? 'disabled' : 'face-landmarker',
          handEngine: init.detectHands === false ? 'disabled' : 'hand-landmarker' });
      }
    },
    videoFrame(time, mediaTime = video.currentTime + 1 / 30) {
      now = time; video.currentTime = mediaTime;
      const callbacks = [...videoCallbacks.values()]; videoCallbacks.clear();
      callbacks.forEach(callback => callback(time, { mediaTime }));
    },
    animationFrame(time) {
      now = time;
      const callbacks = [...animationCallbacks.values()]; animationCallbacks.clear();
      callbacks.forEach(callback => callback(time));
    },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

function faceLandmarks(cx = .7, cy = .4, width = .1, height = .2, roll = 0) {
  const points = Array.from({ length: 468 }, () => ({ x: cx, y: cy }));
  FACE_OVAL.forEach((index, i) => {
    const angle = i * Math.PI * 2 / FACE_OVAL.length;
    const x = Math.sin(angle) * width * 1280 / 2, y = -Math.cos(angle) * height * 720 / 2;
    points[index] = { x: cx + (x * Math.cos(roll) - y * Math.sin(roll)) / 1280,
      y: cy + (x * Math.sin(roll) + y * Math.cos(roll)) / 720 };
  });
  return points;
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message || 'value'}: ${actual} ≈ ${expected}`);
}

test('measured camera targets scale with near and far faces without the old fixed pixel limits', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.6, .45, .02, .04)] });
  const far = h.run('currentTarget()');
  assert.equal(h.state().receiver.measured, true);
  assert.ok(far.w < 150 && far.h < 170, 'a distant face must not be enlarged to a fixed minimum');
  h.track({ faces: [faceLandmarks(.6, .45, .32, .64)] });
  const near = h.run('currentTarget()');
  assert.ok(near.w > 400 && near.h > 440, 'a nearby face must not be cut off by a fixed maximum');
  close(near.w / far.w, 16, 'width follows the measured distance change');
  close(near.h / far.h, 16, 'height follows the measured distance change');
  close(near.x, .6 * 1280); close(near.y, .45 * 720 - h.state().receiver.h * .19);
});

test('measured sizes follow the selected receiver when two people swap roles or detection order changes', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  const left = faceLandmarks(.25, .4, .08, .16), right = faceLandmarks(.75, .4, .16, .32);
  h.track({ faces: [left, right] });
  close(h.state().caster.x, 320); close(h.state().receiver.x, 960);
  const rightPose = h.run('currentTarget()');
  h.track({ faces: [right, left] });
  close(h.run('currentTarget().w'), rightPose.w, 'detector array order does not transfer the other face size');
  h.run('swapped = true'); h.track({ faces: [right, left] });
  close(h.state().caster.x, 960); close(h.state().receiver.x, 320);
  close(h.run('currentTarget().w') / rightPose.w, .5);
  close(h.run('currentTarget().h') / rightPose.h, .5);
});

test('camera measurement applies letterboxing and mirroring before fitting the face', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.video.videoWidth = 640; h.video.videoHeight = 480;
  const face = faceLandmarks(.25, .4, .2, .3);
  h.track({ faces: [face] });
  const normal = h.run('currentTarget()');
  close(h.state().receiver.x, 400, '4:3 image has a 160px horizontal offset');
  close(h.state().receiver.y, 288);
  close(h.state().receiver.w, 192); close(h.state().receiver.h, 216);
  h.element('mirror').checked = true;
  h.track({ faces: [face] });
  const mirrored = h.run('currentTarget()');
  close(mirrored.x, 880); close(mirrored.y, normal.y);
  close(mirrored.w, normal.w); close(mirrored.h, normal.h);
});

test('a tilted face keeps its dimensions while the pumpkin head centre follows the tilted upward offset', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.7, .45, .15, .3)] });
  const upright = h.run('currentTarget()');
  h.track({ faces: [faceLandmarks(.7, .45, .15, .3, .55)] });
  const tilted = h.run('currentTarget()');
  close(tilted.w, upright.w); close(tilted.h, upright.h);
  const face = h.state().receiver, offset = face.h * .19;
  close(tilted.roll, .55);
  close(tilted.x, face.x + Math.sin(.55) * offset);
  close(tilted.y, face.y - Math.cos(.55) * offset);
  assert.ok(tilted.x > upright.x, 'the offset follows head tilt instead of only moving vertically');
});

test('camera and mouse camera cover ear and hair margins in either mirror setting without moving face roles', () => {
  for (const source of ['camera', 'mouse-camera']) {
    for (const mirrored of [false, true]) {
      const h = cameraHarness(); h.run(`source = '${source}';`);
      h.element('mirror').checked = mirrored;
      h.track({ faces: [faceLandmarks(.25, .4, .1, .2, -.35), faceLandmarks(.75, .45, .12, .24, .55)] });
      const face = h.state().receiver, target = h.run('currentTarget()');
      close(face.x, 960, 'role selection still uses the face centre');
      close(face.y, mirrored ? .4 * 720 : .45 * 720);
      assert.equal(face.measured, true);
      // Check actual rendered fallback ellipse against expected ear/top hair
      // margins; these are synthetic head extents, not segmentation of real hair.
      for (const [u, v] of [[-.7, 0], [.7, 0], [0, -.9], [-.5, -.75], [.5, -.75], [0, .5]]) {
        const x = face.x + u * face.w * Math.cos(face.roll) - v * face.h * Math.sin(face.roll);
        const y = face.y + u * face.w * Math.sin(face.roll) + v * face.h * Math.cos(face.roll);
        const dx = x - target.x, dy = y - target.y;
        const localX = dx * Math.cos(target.roll) + dy * Math.sin(target.roll);
        const localY = -dx * Math.sin(target.roll) + dy * Math.cos(target.roll);
        const ellipse = (localX / (target.w * .39)) ** 2 + (localY / (target.h * .4)) ** 2;
        assert.ok(ellipse <= 1, `${source}, mirror=${mirrored}: head margin ${u},${v} is covered`);
      }
      close(h.state().receiver.x, face.x); close(h.state().receiver.y, face.y);
    }
  }
});

test('the shifted head centre cannot move a valid receiver across the role boundary', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ faces: [faceLandmarks(.25, .4), faceLandmarks(.56, .45, .15, .3, -.65)] });
  const face = h.state().receiver, target = h.run('currentTarget()');
  assert.ok(face.x > 1280 * .55);
  assert.ok(target.x < 1280 * .55, 'tilted head offset crosses the screen zone boundary');
  close(face.x, .56 * 1280);
  h.setNow(1500);
  h.track({ faces: [faceLandmarks(.25, .4), faceLandmarks(.56, .45, .15, .3, -.65)] });
  assert.equal(h.state().phase, 'ready', 'the facial landmarks still define two valid participants');
});

test('the real size control reaches 160 percent, updates its label, and resets the cached head fit', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  const slider = h.element('face-fit-scale');
  assert.equal(slider.max, '160');
  assert.equal(slider.value, '100');
  h.track({ faces: [faceLandmarks(.75, .45)] });
  const normal = h.run('currentTarget()');
  slider.value = slider.max; slider.oninput();
  assert.equal(h.element('face-fit-value').textContent, '160%');
  const enlarged = h.run('currentTarget()');
  close(enlarged.w / normal.w, 1.6); close(enlarged.h / normal.h, 1.6);
  h.element('face-fit-reset').onclick();
  assert.equal(slider.value, '100');
  assert.equal(h.element('face-fit-value').textContent, '100%');
  close(h.run('currentTarget().w'), normal.w); close(h.run('currentTarget().h'), normal.h);
});

test('clicking a different face copies that face size and keeps it after detection disappears', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.25, .3, .08, .15), faceLandmarks(.75, .5, .18, .3)] });
  const selected = h.state().faces.find(face => face.x < 640);
  assert.ok(h.state().receiver.w > selected.w);
  h.point('pointerdown', 320, 216);
  assert.equal(h.state().manualTarget.measured, true);
  close(h.state().manualTarget.w, selected.w); close(h.state().manualTarget.h, selected.h);
  const pinned = h.run('currentTarget()');
  h.track({ faces: [faceLandmarks(.75, .5, .3, .5)] });
  h.track({ faces: [] });
  close(h.run('currentTarget().w'), pinned.w); close(h.run('currentTarget().h'), pinned.h);
  close(h.state().receiver.x, 320); close(h.state().receiver.y, 216);
  assert.equal(h.run('currentTarget().manual'), true);
});

test('clicking away from detected faces retains the current measured size instead of a fixed default', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.75, .4, .2, .3)] });
  const before = h.run('currentTarget()');
  h.point('pointerdown', 700, 110);
  close(h.run('currentTarget().w'), before.w); close(h.run('currentTarget().h'), before.h);
  close(h.state().receiver.x, 700); close(h.state().receiver.y, 110);
  assert.equal(h.state().receiver.manual, true);
});

test('an invalid face contour is excluded without breaking the other face or the camera flow', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  const invalid = faceLandmarks(.25, .4); invalid[FACE_OVAL[7]].x = NaN;
  const flat = Array.from({ length: 468 }, () => ({ x: .3, y: .4 }));
  assert.doesNotThrow(() => h.track({ faces: [invalid, [], flat, faceLandmarks(.75, .4)] }));
  assert.equal(h.state().faces.length, 1);
  assert.equal(h.state().caster, null);
  assert.equal(h.state().phase, 'ready', 'missing the thrower face must not hide the pumpkin');
  close(h.state().receiver.x, 960);
  assert.ok(Number.isFinite(h.run('currentTarget().w')));
});

test('fit adjustment and pumpkin shape update a cached target without needing another camera frame', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks()] });
  const original = h.run('currentTarget()');
  h.element('face-fit-scale').value = '120';
  const enlarged = h.run('currentTarget()');
  close(enlarged.w / original.w, 1.2); close(enlarged.h / original.h, 1.2);
  h.run("shape = 'wide'");
  const wide = h.run('currentTarget()');
  close(wide.w / enlarged.w, 1.22); close(wide.h, enlarged.h);
});

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

// A gentle finger bend, well short of the folded fist used above. Finger
// chains turn 35 degrees per joint while the palm and wrist remain fixed.
function relaxedHandLandmarks(x, y, bentFingers = 4) {
  const points = handLandmarks(x, y, true).map(p => ({ x: p.x * 1280, y: p.y * 720 }));
  for (const [i, base] of [5, 9, 13, 17].entries()) {
    if (i >= bentFingers) continue;
    for (const [step, length] of [[2, 23], [3, 25]]) {
      const angle = (step - 1) * 35 * Math.PI / 180, previous = points[base + step - 1];
      points[base + step] = { x: previous.x + length * Math.sin(angle), y: previous.y - length * Math.cos(angle) };
    }
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
    assert.equal(h.state().receiver.x, 1024, 'a short miss keeps the last observed face');
    h.setNow(2401); h.run('expireTracking(2401)');
    assert.equal(h.state().receiver, null);
    assert.equal(h.run('currentTarget()'), null);
    assert.equal(h.state().flight.target.x, 1024, 'the flight keeps its last intended destination');
    h.track({ faces: [faceLandmarks(.75, .45)] });
    assert.equal(h.state().receiver.x, 960, 'face tracking can resume when the person returns');
  }
});

test('losing the receiver never transfers a flying or worn pumpkin to the other participant', () => {
  for (const phase of ['flying', 'worn']) {
    for (const swapped of [false, true]) {
      const h = cameraHarness(); h.run(`source = 'mouse-camera'; swapped = ${swapped};`);
      const targetX = swapped ? .25 : .75, otherX = swapped ? .75 : .25;
      h.track({ faces: [faceLandmarks(otherX), faceLandmarks(targetX)] });
      const selected = h.state().receiver;
      h.run('launch(restPose(), currentTarget())'); h.run(`phase = '${phase}'`);
      h.track({ faces: [faceLandmarks(otherX)] });
      assert.equal(h.state().receiver, selected, 'retain the original face instead of the remaining participant');
      h.setNow(2401); h.track({ faces: [faceLandmarks(otherX)] });
      assert.equal(h.state().receiver, null, 'the remaining participant is outside the tracking gate after grace expires');
      assert.equal(h.state().mouseTrackedFace, selected, 'remember the lost destination for reacquisition');
      const returnedX = targetX + (swapped ? .03 : -.03);
      h.track({ faces: [faceLandmarks(otherX), faceLandmarks(returnedX)] });
      close(h.state().receiver.x, returnedX * 1280);
    }
  }
});

test('tracking chooses the closest nearby face during a throw instead of a new rightmost bystander', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.7)] });
  h.run('launch(restPose(), currentTarget())');
  h.track({ faces: [faceLandmarks(.82), faceLandmarks(.69)] });
  close(h.state().receiver.x, .69 * 1280);
});

test('repeated mouse-camera renders cannot renew a cached face after the real observation expires', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.75)] });
  h.run('launch(restPose(), currentTarget()); phase = "worn";');
  for (const time of [1300, 1900, 2400]) {
    h.setNow(time); h.run(`expireTracking(${time}); mouseCameraRoles()`);
    close(h.state().receiver.x, 960);
    assert.equal(h.run('mouseFaceSeenAt'), 1000, 'renders use the original capture time');
  }
  h.setNow(2401); h.run('expireTracking(2401); mouseCameraRoles()');
  assert.equal(h.state().receiver, null);
  assert.equal(h.run('mouseFaceSeenAt'), 1000);
});

test('late face results older than grace cannot revive the destination in either camera mode', () => {
  for (const mode of ['camera', 'mouse-camera']) {
    const h = cameraHarness(); h.run(`source = '${mode}';`);
    h.track({ faces: [faceLandmarks(.75)] });
    h.run('launch(restPose(), currentTarget()); phase = "worn";');
    h.setNow(2600); h.run('expireTracking(2600)');
    assert.equal(h.state().receiver, null);
    h.receive({ time: 1100, faceTime: 1100, facesUpdated: true, faces: [faceLandmarks(.75)], matrices: [] });
    assert.equal(h.state().receiver, null, 'an old capture remains expired even when delivered now');
    h.receive({ time: 2600, faceTime: 2600, facesUpdated: true, faces: [faceLandmarks(.74)], matrices: [] });
    close(h.state().receiver.x, .74 * 1280, 'a fresh observation can reacquire');
  }
});

test('resetting a round or stopping the camera clears its destination lock for the next visitor', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.75)] });
  h.run('launch(restPose(), currentTarget())');
  h.track({ faces: [faceLandmarks(.25)] });
  close(h.state().receiver.x, 960, 'keep the original destination briefly');
  h.run('resetRound()');
  assert.equal(h.state().mouseTrackedFace, null);
  h.track({ faces: [faceLandmarks(.25)] });
  close(h.state().receiver.x, 320, 'a single face anywhere is still usable before throwing');
  h.stop();
  assert.equal(h.state().mouseTrackedFace, null);
});

test('switching a manual target back to automatic tracking explicitly chooses a fresh face', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.25, .3), faceLandmarks(.75, .4)] });
  close(h.state().mouseTrackedFace.x, 960);
  h.point('pointerdown', 320, 216);
  h.run('launch(restPose(), currentTarget()); phase = "worn";');
  h.track({ faces: [faceLandmarks(.25, .3)] });
  assert.equal(h.state().receiver.manual, true);
  h.element('target-auto').onclick();
  assert.equal(h.state().manualTarget, null);
  close(h.state().receiver.x, 320);
  assert.equal(h.state().receiver.manual, undefined);
  assert.equal(h.state().mouseTrackedFace, h.state().receiver);
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

function handFlow(h, { swapped = false, faces = true, y = 400, delay = 0 } = {}) {
  h.run("source = 'camera'; swapped = " + swapped + "; resetRound();");
  return (time, x, bent = 4, extra = {}) => {
    h.setNow(time + delay);
    h.track({ time, faces: faces ? [faceLandmarks(swapped ? .25 : .75)] : [],
      hands: x === null ? [] : [relaxedHandLandmarks(swapped ? 1280 - x : x, y, bent)],
      handEngine: 'hand-landmarker', gestures: [], ...extra });
  };
}

test('three observed forward motion windows launch closed, partial, and fully open hands on either side', () => {
  for (const swapped of [false, true]) for (const bent of [4, 1, 0]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 150, 4);
    assert.equal(h.state().phase, 'held', 'a slight curl acquires without a fist classifier');
    for (const [time, x] of [[1100, 230], [1200, 310]]) {
      frame(time, x, bent); assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    }
    frame(1300, 390, bent);
    assert.equal(h.state().phase, 'flying', 'finger geometry cannot veto an observed forward swing');
    assert.equal(h.effects.release, 1);
    assert.equal(h.state().flight.target.x, swapped ? 320 : 960);
    frame(1400, 470, bent); frame(1500, null);
    assert.equal(h.effects.release, 1, 'a completed throw is not replayed');
  }
});

test('an initially open hand must curl slightly once before movement can auto release', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    for (const [time, x] of [[1000, 150], [1100, 230], [1200, 310], [1300, 390]]) {
      frame(time, x, 0); assert.equal(h.state().phase, 'ready'); assert.equal(h.effects.release, 0);
    }
    assert.equal(h.run('debugReason'), 'waiting-grip');
    frame(1400, 200, 4); assert.equal(h.state().phase, 'held');
    frame(1500, 280, 0); frame(1600, 360, 0); frame(1700, 440, 0);
    assert.equal(h.state().phase, 'flying');
  }
});

test('motion release remains usable at 15, 30, 60, 90, and 120 FPS without requiring consecutive perfect palm labels', () => {
  for (const fps of [15, 30, 60, 90, 120]) for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    const step = 1000 / fps;
    frame(1000, 150, 4);
    let releaseTime = null;
    for (let i = 1; i <= Math.ceil(300 / step); i++) {
      const time = 1000 + i * step;
      frame(time, 150 + (time - 1000) * .8, i % 3 === 0 ? 0 : i % 3 === 1 ? 4 : 1);
      if (h.state().phase === 'flying') { releaseTime = time; break; }
    }
    assert.ok(releaseTime !== null, fps + ' FPS must launch from real movement');
    assert.ok(releaseTime >= 1075, 'high cadence cannot collapse three independent motion windows');
    assert.equal(h.effects.release, 1);
  }
});

test('stationary, slow, reverse, and mainly vertical hands keep holding despite open fingers', () => {
  for (const scenario of [
    { name: 'stationary', positions: [150, 150, 150, 150], ys: [400, 400, 400, 400] },
    { name: 'slow', positions: [150, 155, 160, 165], ys: [400, 400, 400, 400] },
    { name: 'reverse', positions: [450, 370, 290, 210], ys: [400, 400, 400, 400] },
    { name: 'vertical', positions: [150, 170, 190, 210], ys: [600, 500, 400, 300] },
  ]) {
    const h = cameraHarness(), frame = handFlow(h);
    for (let i = 0; i < scenario.positions.length; i++) {
      frame(1000 + i * 100, scenario.positions[i], i ? 0 : 4,
        { hands: [relaxedHandLandmarks(scenario.positions[i], scenario.ys[i], i ? 0 : 4)] });
    }
    assert.equal(h.state().phase, 'held', scenario.name);
    assert.equal(h.effects.release, 0, scenario.name); assert.equal(h.state().flight, null, scenario.name);
  }
});

test('one large landmark jump followed by stationary observations is never an automatic throw', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150); frame(1100, 500, 0); frame(1200, 500, 0); frame(1300, 500, 0);
  assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
});

test('a natural backswing needs three fresh forward windows and may release before the original grip position', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 450); frame(1100, 350); frame(1200, 250);
    frame(1300, 300, 1); frame(1400, 350, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    frame(1500, 400, 4);
    assert.equal(h.state().phase, 'flying'); assert.equal(h.effects.release, 1);
  }
});

test('reversing after two forward windows resets the count and requires a new complete swing', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 150); frame(1100, 230); frame(1200, 310); frame(1300, 240, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.run('motionRelease.frames'), 0);
    frame(1400, 300, 1); frame(1500, 360, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    frame(1600, 420, 0); assert.equal(h.state().phase, 'flying');
  }
});

test('a held hand can wait without a receiver, but only new target-directed motion can release after a face appears', () => {
  const h = cameraHarness(), frame = handFlow(h, { faces: false });
  frame(1000, 150); frame(1100, 230); frame(1200, 310); frame(1300, 390);
  assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0); assert.equal(h.state().receiver, null);
  assert.equal(h.run('debugReason'), 'no-receiver');
  const seen = { faces: [faceLandmarks(.75)] };
  frame(1400, 390, 0, seen); frame(1500, 470, 1, seen); frame(1600, 550, 4, seen);
  assert.equal(h.state().phase, 'held');
  frame(1700, 630, 0, seen); assert.equal(h.state().phase, 'flying');
  assert.equal(h.state().caster, null, 'only the receiving face is necessary');
});

test('a slow attempt can transition to a new faster swing without another grip', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150); frame(1100, 155, 0); frame(1200, 160, 0); frame(1300, 165, 0);
  assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
  frame(1400, 245, 0); frame(1500, 325, 0); frame(1600, 405, 0);
  assert.equal(h.state().phase, 'flying');
});

test('a hand can summon and hold a pumpkin before either face is detected', () => {
  const h = cameraHarness(), frame = handFlow(h, { faces: false });
  frame(1000, 150);
  assert.equal(h.state().phase, 'held'); assert.ok(h.state().heldPose); assert.equal(h.state().receiver, null);
  assert.match(h.element('live-status').textContent, /手にかぼちゃ.*顔/);
  frame(1200, 220); assert.equal(h.state().phase, 'held');
});

test('a brief face miss retains the receiver, but an expired face never becomes a throw destination', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150);
  for (const [time, x] of [[1300, 160], [1700, 170], [2300, 180]]) frame(time, x, 4, { faces: [] });
  assert.equal(h.state().receiver.x, 960, 'the face grace period tolerates brief misses');
  frame(2450, 260, 0, { faces: [] });
  assert.equal(h.state().receiver, null);
  frame(2550, 340, 0, { faces: [] }); frame(2650, 420, 0, { faces: [] });
  assert.equal(h.state().phase, 'held'); assert.equal(h.state().flight, null);
  assert.equal(h.run('debugReason'), 'no-receiver');
});

test('receiver expiration between hand samples clears progress before a face returns', () => {
  for (const lossPath of ['face-only', 'expiration']) {
    const h = cameraHarness(), frame = handFlow(h);
    frame(1000, 150);
    frame(2000, 150, 4, { facesUpdated: false }); frame(2100, 230, 0, { facesUpdated: false });
    frame(2200, 310, 0, { facesUpdated: false });
    assert.equal(h.run('motionRelease.frames'), 2);
    h.setNow(2401);
    if (lossPath === 'face-only') h.receive({ time: 2401, faces: [] }); else h.run('expireTracking(2401)');
    assert.equal(h.state().receiver, null); assert.equal(h.run('motionRelease.frames'), 0);
    frame(2450, 330, 0); frame(2550, 410, 0); frame(2650, 490, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    frame(2750, 570, 0); assert.equal(h.state().phase, 'flying');
  }
});

test('a missing hand never finishes two observed motion windows and reacquisition requires fresh movement', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 150); frame(1100, 230); frame(1200, 310, 0); frame(1250, null);
    assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    assert.equal(h.run('motionRelease.frames'), 0);
    frame(1300, 390, 0);
    assert.equal(h.run('toss.history.length'), 1, 'unobserved travel never supplies mouse-equivalent release velocity');
    frame(1400, 470, 0); frame(1500, 550, 0);
    assert.equal(h.effects.release, 0);
    frame(1600, 630, 0); assert.equal(h.state().phase, 'flying');
  }
});

test('hand loss retains the held pose for 1.5 seconds without releasing and then cancels safely', () => {
  const h = cameraHarness(), frame = handFlow(h, { faces: false });
  frame(1000, 150); const held = h.state().heldPose;
  frame(1300, null); assert.equal(h.state().phase, 'held'); assert.equal(h.state().heldPose, held);
  frame(2200, null); assert.equal(h.state().phase, 'held');
  assert.match(h.element('live-status').textContent, /持ったまま待っています/);
  frame(2501, null); assert.equal(h.state().phase, 'ready'); assert.equal(h.state().heldPose, null);
  assert.equal(h.effects.release, 0);
  frame(2600, 150); assert.equal(h.state().phase, 'held');
});

test('a long observation gap resets motion even when the detector never explicitly reports a missing hand', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150); frame(1100, 230); frame(1200, 310);
  frame(1900, 430, 0);
  assert.equal(h.state().phase, 'held'); assert.equal(h.run('motionRelease.frames'), 0);
  assert.equal(h.run('toss.history.length'), 1);
  frame(2000, 510, 0); frame(2100, 590, 0); assert.equal(h.effects.release, 0);
  frame(2200, 670, 0); assert.equal(h.state().phase, 'flying');
});

test('duplicate, reversed, future, and stale timestamps cannot complete a movement throw', () => {
  for (const failure of ['duplicate', 'reversed', 'future', 'stale']) {
    const h = cameraHarness(), frame = handFlow(h);
    frame(1000, 150); frame(1100, 230); frame(1200, 310);
    h.setNow(failure === 'stale' ? 2000 : 1300);
    h.receive({ time: failure === 'duplicate' ? 1200 : failure === 'reversed' ? 1150 : failure === 'future' ? 1400 : 1300,
      facesUpdated: false, hands: [relaxedHandLandmarks(390, 400, 0)] });
    assert.equal(h.state().phase, 'held', failure); assert.equal(h.effects.release, 0, failure);
  }
});

test('a chronological camera pipeline delayed by 250 ms can still release from fresh observed motion', () => {
  const h = cameraHarness(), frame = handFlow(h, { delay: 250 });
  frame(1000, 150); frame(1250, 250, 1); frame(1500, 350, 0);
  assert.equal(h.state().phase, 'held'); close(h.state().heldPose.x, 350);
  frame(1750, 450, 1); assert.equal(h.state().phase, 'flying'); assert.equal(h.effects.release, 1);
});

test('face-only results, rendered prediction, and worker silence cannot supply a third motion window', () => {
  for (const trigger of ['face-only', 'render', 'worker-stall']) {
    const h = cameraHarness(), frame = handFlow(h);
    frame(1000, 150); frame(1100, 230); frame(1200, 310);
    h.setNow(1300);
    if (trigger === 'face-only') h.receive({ time: 1300, faces: [faceLandmarks(.75)] });
    if (trigger === 'render') for (const time of [1250, 1275, 1300]) h.run('displayHeldPose(' + time + '); expireTracking(' + time + ')');
    if (trigger === 'worker-stall') { h.setNow(2100); h.run('expireTracking(2100)'); }
    assert.equal(h.state().phase, 'held', trigger); assert.equal(h.effects.release, 0, trigger);
  }
});

test('a new round cannot inherit previous motion confirmation', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150); frame(1100, 230); frame(1200, 310);
  h.run('resetRound()'); assert.equal(h.run('motionRelease.frames'), 0);
  frame(1300, 150); frame(1400, 230, 0); assert.equal(h.effects.release, 0);
  frame(1500, 310, 0); assert.equal(h.effects.release, 0);
  frame(1600, 390, 0); assert.equal(h.state().phase, 'flying');
});

test('finite palm movement near cropped fingers can complete a motion throw without full-open geometry', () => {
  for (const y of [45, 710]) for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped, y });
    frame(1000, 150); frame(1100, 230, 1); frame(1200, 310, 1); frame(1300, 390, 1);
    assert.equal(h.state().phase, 'flying'); assert.equal(h.effects.release, 1);
  }
});

test('a palm outside the actual camera rectangle cannot supply a motion confirmation window', () => {
  const h = cameraHarness(), frame = handFlow(h);
  frame(1000, 150); frame(1100, 230); frame(1200, 310);
  frame(1300, 390, 0, { hands: [relaxedHandLandmarks(390, 725, 0)] });
  assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
  assert.equal(h.run('motionRelease.frames'), 0);
});

test('a returning hand near the camera boundary uses only new observed motion', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 30); frame(1700, null); frame(2100, 80, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.run('toss.history.length'), 1);
    frame(2200, 160, 0); frame(2300, 240, 0); assert.equal(h.effects.release, 0);
    frame(2400, 320, 0); assert.equal(h.state().phase, 'flying');
  }
});

test('a brief worker stall shares hold grace and eventually clears stale tracking', () => {
  const h = cameraHarness(), frame = handFlow(h); frame(1000, 100);
  h.run('expireTracking(2000)'); assert.equal(h.state().phase, 'held'); assert.equal(h.state().receiver.x, 960);
  h.run('expireTracking(2400)'); assert.equal(h.state().receiver.x, 960);
  h.run('expireTracking(2401)'); assert.equal(h.state().receiver, null); assert.equal(h.effects.release, 0);
  h.run('expireTracking(2501)'); assert.equal(h.state().phase, 'ready'); assert.equal(h.state().heldPose, null);
});

test('empty results before a worker stall cannot renew the held hand grace period', () => {
  const h = cameraHarness(), frame = handFlow(h, { faces: false }); frame(1000, 100); frame(2200, null);
  assert.equal(h.state().phase, 'held'); h.run('expireTracking(2501)');
  assert.equal(h.state().phase, 'ready'); assert.equal(h.effects.release, 0);
});

test('a face crossing the middle cannot remain cached as its own receiver', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(); h.run("source = 'camera'; swapped = " + swapped + "; resetRound();");
    h.track({ faces: [faceLandmarks(swapped ? .47 : .53)] }); assert.ok(h.state().receiver);
    h.setNow(1100); h.track({ faces: [faceLandmarks(swapped ? .53 : .47)] });
    assert.ok(h.state().caster); assert.equal(h.state().receiver, null);
  }
});

test('an invalid hand is ignored and cannot prevent a valid relaxed grip from grabbing', () => {
  const h = cameraHarness(), frame = handFlow(h);
  const bad = handLandmarks(150, 400); bad[5].x = NaN;
  assert.doesNotThrow(() => frame(1000, 250, 4, { hands: [[], bad, relaxedHandLandmarks(250, 400)] }));
  assert.equal(h.state().phase, 'held');
});

test('quality changes camera transfer size without changing stage coordinates or upscaling small streams', async () => {
  const h = cameraHarness(), sizes = [];
  h.context.createImageBitmap = async (video, options) => { sizes.push(options); return { close() {} }; };
  h.run("source = 'camera'; workerReady = true; worker = { postMessage() {} };");
  await h.run('requestFrame(1000)');
  assert.equal(sizes[0].resizeWidth, 768); assert.equal(sizes[0].resizeHeight, 432);
  h.run("applyTrackingTuning({ quality: 'high' }); processing = false;"); h.video.currentTime++;
  await h.run('requestFrame(1100)');
  assert.equal(sizes[1].resizeWidth, 960); assert.equal(sizes[1].resizeHeight, 540);
  h.video.videoWidth = 640; h.video.videoHeight = 480; h.video.currentTime++;
  h.run('processing = false'); await h.run('requestFrame(1200)');
  assert.equal(sizes[2].resizeWidth, 640); assert.equal(sizes[2].resizeHeight, 480);
});

test('hand results and completion do not wait for the independent face worker', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  h.run('processing = true; faceProcessing = true');
  const [worker, faceWorker] = h.workers;
  assert.equal(worker.messages[0].detectFaces, false);
  assert.equal(faceWorker.messages[0].detectHands, false);
  worker.emit({ type: 'hands', time: 1000, hands: [handLandmarks(180, 400)], gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
  assert.equal(h.state().phase, 'held', 'hand interaction is usable without waiting for the face result');
  assert.equal(h.run('processing'), true);
  assert.equal(h.effects.begin, 1);
  worker.emit({ type: 'result', time: 1000, facesUpdated: false });
  assert.equal(h.run('processing'), false);
  assert.equal(h.run('faceProcessing'), true, 'hand completion does not release the face slot');
  faceWorker.emit({ type: 'result', time: 1000, facesUpdated: true, faceTime: 1000, faces: [faceLandmarks(.75)], matrices: [] });
  assert.equal(h.run('faceProcessing'), false);
  assert.equal(h.state().phase, 'held');
  assert.equal(h.effects.begin, 1, 'a completion cannot replay the hand sample');
  close(h.state().receiver.x, 960);
});

const workerFrames = worker => worker.messages.filter(message => message.type === 'frame');

test('fresh hand frames continue while face inference stays busy and face messages cannot replace hand statistics', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  const [handWorker, faceWorker] = h.workers;
  for (const [index, time] of Array.from({ length: 17 }, (_, i) => 1000 + i * 33).entries()) {
    h.videoFrame(time); await h.settle();
    assert.equal(workerFrames(handWorker).length, index + 1, 'hand throughput is independent of unfinished face work');
    assert.equal(workerFrames(faceWorker).length, 1, 'a busy face worker cannot accumulate queued frames');
    h.setNow(time + 8);
    handWorker.emit({ type: 'result', time, hands: [], facesUpdated: false,
      handEngine: 'hand-landmarker', faceEngine: 'disabled', handMs: 8 });
    await h.settle();
  }
  const handFps = h.run('trackingInfo.handFps');
  assert.ok(handFps >= 29 && handFps <= 31, `measured hand rate remains near 30fps: ${handFps}`);
  h.setNow(1540);
  faceWorker.emit({ type: 'result', time: 1000, facesUpdated: true, faceTime: 1000,
    faces: [faceLandmarks(.75)], hands: [], faceEngine: 'face-landmarker', handEngine: 'disabled', faceMs: 540 });
  assert.equal(h.run('trackingInfo.handEngine'), 'hand-landmarker');
  assert.equal(h.run('trackingInfo.faceEngine'), 'face-landmarker');
  assert.equal(h.run('trackingInfo.handFps'), handFps, 'face-only completion is not counted as a hand observation');
  assert.equal(h.run('trackingInfo.handLatencyMs'), 8, 'slow face work cannot overwrite the measured hand latency');
  h.stop();
});

test('video capture keeps only the latest frame while hands are busy and does not resend an identical frame', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  const [handWorker, faceWorker] = h.workers;
  h.videoFrame(1000); await h.settle();
  h.videoFrame(1033); h.videoFrame(1066); await h.settle();
  assert.equal(workerFrames(handWorker).length, 1);
  assert.equal(workerFrames(faceWorker).length, 1);
  h.setNow(1070);
  handWorker.emit({ type: 'result', time: 1000, hands: [], facesUpdated: false });
  await h.settle();
  assert.equal(workerFrames(handWorker).length, 2, 'completion immediately captures the newest available video frame');
  h.setNow(1080);
  handWorker.emit({ type: 'result', time: 1070, hands: [], facesUpdated: false });
  await h.settle();
  assert.equal(workerFrames(handWorker).length, 2, 'completion without a new video frame does not create another inference');
  h.stop();
});

test('unique camera frames at jittered 60fps intervals are not throttled by a fixed frame gate', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  const handWorker = h.workers[0];
  for (const [index, time] of [1000, 1015, 1032, 1047, 1064, 1079].entries()) {
    h.videoFrame(time); await h.settle();
    assert.equal(workerFrames(handWorker).length, index + 1, `unique frame at ${time}ms is submitted`);
    h.setNow(time + 4);
    handWorker.emit({ type: 'result', time, hands: [], facesUpdated: false });
    await h.settle();
  }
  h.stop();
});

test('successful captures on one worker cannot erase consecutive capture failures on the other worker', async () => {
  for (const failingLane of [0, 1]) {
    const media = mediaStream(), h = cameraHarness({ getUserMedia: async () => media });
    let captures = 0;
    h.context.createImageBitmap = async () => {
      const lane = captures++ % 2;
      if (lane === failingLane) throw new Error('synthetic capture failure');
      return { close() {} };
    };
    const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
    const healthyWorker = h.workers[1 - failingLane];
    for (const [index, time] of [1000, 1100, 1200].entries()) {
      h.videoFrame(time); await h.settle();
      if (index < 2) {
        assert.equal(h.state().source, 'camera', 'one or two capture failures permit a retry');
        assert.equal(workerFrames(healthyWorker).length, index + 1, 'the other lane continues capturing successfully');
        h.setNow(time + 8);
        healthyWorker.emit(failingLane === 0
          ? { type: 'result', time, facesUpdated: true, faceTime: time, faces: [] }
          : { type: 'result', time, facesUpdated: false, hands: [] });
        await h.settle();
      }
    }
    assert.equal(h.state().source, 'mouse-camera', 'three consecutive failures on either lane trigger the usable mouse fallback');
    assert.equal(h.state().stream, media, 'fallback preserves the live camera');
    assert.equal(media.track.stops, 0);
    assert.equal(h.state().worker, null);
    assert.equal(h.state().faceWorker, null);
    for (const worker of h.workers) assert.equal(worker.terminated, 1);
    h.stop();
  }
});

test('background tab time neither triggers detector fallback nor consumes the remaining response timeout', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  h.videoFrame(1000); await h.settle();
  h.setNow(1100);
  h.context.document.hidden = true;
  h.context.document.listeners.get('visibilitychange')();
  h.setNow(10100); await h.run('requestFrame(10100)');
  assert.equal(h.state().source, 'camera', 'nine hidden seconds are not a detector failure');
  for (const worker of h.workers) assert.equal(worker.terminated, 0);
  h.context.document.hidden = false;
  h.context.document.listeners.get('visibilitychange')();
  await h.run('requestFrame(10100)');
  assert.equal(h.state().source, 'camera', 'resuming a backgrounded tab does not immediately fall back');
  h.setNow(17999); await h.run('requestFrame(17999)');
  assert.equal(h.state().source, 'camera', 'the original 100ms of visible waiting leaves 7900ms after resuming');
  h.setNow(18001); await h.run('requestFrame(18001)');
  assert.equal(h.state().source, 'mouse-camera', 'an actual eight-second visible stall still falls back');
  h.stop();
});

test('stopping camera inference terminates both workers and cancels video or animation callbacks', async () => {
  for (const videoFrameCallbacks of [true, false]) {
    const media = mediaStream(), h = cameraHarness({ videoFrameCallbacks, getUserMedia: async () => media });
    const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
    assert.equal(videoFrameCallbacks ? h.videoCallbacks.size : h.animationCallbacks.size, 1);
    if (videoFrameCallbacks) h.videoFrame(1000); else h.animationFrame(1000);
    await h.settle();
    assert.equal(workerFrames(h.workers[0]).length, 1);
    assert.equal(workerFrames(h.workers[1]).length, 1);
    h.stop();
    assert.equal(h.videoCallbacks.size, 0);
    assert.equal(h.animationCallbacks.size, 0);
    assert.equal(media.track.stops, 1);
    assert.equal(h.state().worker, null);
    assert.equal(h.state().faceWorker, null);
    for (const worker of h.workers) assert.equal(worker.terminated, 1);
  }
});

test('bitmaps completing after camera stop are closed rather than delivered to either worker', async () => {
  const h = cameraHarness(), captures = [deferred(), deferred()], bitmaps = [{ closes: 0 }, { closes: 0 }];
  bitmaps.forEach(bitmap => { bitmap.close = () => { bitmap.closes++; }; });
  let capture = 0;
  h.context.createImageBitmap = () => captures[capture++].promise;
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  h.videoFrame(1000); await h.settle();
  assert.equal(capture, 2, 'each detector owns its separate transferable bitmap');
  h.stop();
  captures.forEach((pending, index) => pending.resolve(bitmaps[index])); await h.settle();
  assert.deepEqual(bitmaps.map(bitmap => bitmap.closes), [1, 1]);
  for (const worker of h.workers) assert.equal(workerFrames(worker).length, 0);
  assert.equal(h.videoCallbacks.size, 0);
});

test('skipping face inference preserves a recent target but cannot renew an old face indefinitely', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.receive({ time: 1000, facesUpdated: true, faceTime: 1000, faces: [faceLandmarks(.75)], matrices: [] });
  for (const time of [1200, 1600, 1800, 2200, 2400]) {
    h.setNow(time);
    h.receive({ type: 'hands', time, hands: [handLandmarks(180, 400)] });
    h.receive({ type: 'result', time, facesUpdated: false, faceTime: 1000, faces: [] });
    close(h.state().receiver.x, 960);
  }
  h.setNow(2401);
  h.receive({ type: 'hands', time: 2401, hands: [handLandmarks(180, 400)] });
  h.receive({ type: 'result', time: 2401, facesUpdated: false, faceTime: 1000, faces: [] });
  assert.equal(h.state().receiver, null);
  assert.equal(h.state().phase, 'held');
});

test('large but observed steps still need three movement windows on either side', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h, { swapped });
    frame(1000, 150); frame(1040, 200); frame(1120, 600, 0);
    assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
    frame(1160, 680, 1);
    assert.equal(h.state().phase, 'flying'); assert.equal(h.effects.release, 1);
  }
});

test('completed throw diagnostics preserve release evidence while missing or receiver-side hands keep updating live bones', () => {
  for (const phase of ['flying', 'worn']) {
    const h = cameraHarness(), snapshots = [], boneFrames = [];
    h.context.snapshots = snapshots; h.context.boneFrames = boneFrames; h.context.c = {};
    h.run(`source = 'camera'; resetRound(); debugControls = {
      isOpen: () => true, update: snapshot => snapshots.push(snapshot),
      draw: (context, hands, activeHand) => boneFrames.push({hands, activeHand})
    };`);
    h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(330, 400)],
      gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
    h.setNow(1040); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(380, 395)],
      gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
    h.setNow(1080); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(500, 380)], gestures: [] });
    h.setNow(1160); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(820, 360, true)],
      gestures: [[{ categoryName: 'Open_Palm', score: .95 }]] });
    assert.equal(h.state().phase, 'flying');
    const release = h.run('lastThrowMetrics');
    assert.equal(release.ok, true); assert.equal(release.gap, 80);
    if (phase === 'worn') h.run("phase = 'worn'; debugReason = 'landed';");
    h.run('updateDeveloper(1160)');
    const expectedReason = phase === 'flying' ? 'launched' : 'landed';
    for (const [time, hands] of [[1500, []], [2000, [handLandmarks(950, 400, true)]]]) {
      h.setNow(time); h.track({ faces: [faceLandmarks(.8)], hands });
      h.run(`updateDeveloper(${time})`);
      const snapshot = snapshots.at(-1);
      assert.equal(snapshot.phase, phase); assert.equal(snapshot.reason, expectedReason);
      assert.equal(snapshot.gap, release.gap, 'after release the gap describes the release observation, not the growing hand absence');
      assert.equal(snapshot.speed, release.speed); assert.equal(snapshot.travel, release.distance);
      assert.equal(snapshot.duration, release.duration); assert.equal(snapshot.missing, false);
      assert.equal(snapshot.handCount, hands.length);
      assert.equal(boneFrames.at(-1).hands.length, hands.length, 'current skeleton data is still refreshed');
      assert.equal(boneFrames.at(-1).activeHand, null, 'a receiver-side hand is not relabeled as the thrower');
      assert.equal(h.effects.release, 1, 'later hand frames never replay the completed release');
    }
    h.setNow(3200); h.run('expireTracking(3200); updateDeveloper(3200)');
    assert.equal(snapshots.at(-1).reason, expectedReason, 'an inference stall after launch cannot rewrite the completed throw as cancelled');
    assert.equal(snapshots.at(-1).gap, release.gap);
    assert.equal(h.state().phase, phase);
  }
});

test('live motion-frame tuning changes the required number of observed windows', () => {
  for (const required of [2, 3, 5]) {
    const h = cameraHarness(), frame = handFlow(h);
    h.context.tuning = { motionFrames: required };
    h.run('applyTrackingTuning(tuning)');
    assert.equal(h.run('motionRelease.requiredFrames'), required);
    frame(1000, 150);
    for (let i = 1; i <= required; i++) {
      frame(1000 + i * 100, 150 + i * 70, 0);
      assert.equal(h.state().phase, i === required ? 'flying' : 'held');
      assert.equal(h.effects.release, i === required ? 1 : 0);
    }
  }
});

test('live speed and distance tuning still gate the common mouse-equivalent release', () => {
  for (const relaxed of [false, true]) {
    const h = cameraHarness(), frame = handFlow(h);
    h.context.tuning = { minSpeed: relaxed ? 100 : 600, minDistance: relaxed ? 20 : 100, motionFrames: 3 };
    h.run('applyTrackingTuning(tuning)');
    frame(1000, 150); frame(1100, 180, 0); frame(1200, 210, 0); frame(1300, 240, 0);
    assert.equal(h.state().phase, relaxed ? 'flying' : 'held');
    assert.equal(h.effects.release, relaxed ? 1 : 0);
    if (!relaxed) {
      assert.equal(h.run('motionRelease.frames'), 0, 'sub-threshold speed cannot count a motion window');
      frame(1400, null);
      assert.equal(h.effects.release, 0);
    }
  }
});

test('confirmed movement still respects the minimum throw distance and retains a rejection explanation', () => {
  const h = cameraHarness(), frame = handFlow(h);
  h.context.tuning = { minSpeed: 100, minDistance: 160, motionFrames: 3 };
  h.run('applyTrackingTuning(tuning)');
  frame(1000, 150); frame(1100, 180, 0); frame(1200, 210, 0); frame(1300, 240, 0);
  assert.equal(h.run('motionRelease.frames'), 3);
  assert.equal(h.state().phase, 'held'); assert.equal(h.effects.release, 0);
  assert.equal(h.run('lastThrowReason'), 'slow');
  close(h.run('lastThrowMetrics.distance'), 90);
  assert.ok(h.run('lastThrowMetrics.speed') > 100, 'distance still gates a swing with adequate speed');
  frame(1400, null);
  assert.equal(h.run('lastThrowReason'), 'slow', 'a later missed frame keeps the useful rejection explanation');
});

test('finished exhibition pauses hand work, and opening the developer view resumes it', async () => {
  const h = cameraHarness(), sentHands = [], sentFaces = [];
  h.context.sentHands = sentHands; h.context.sentFaces = sentFaces;
  h.context.createImageBitmap = async () => ({ close() {} });
  h.run(`source = 'camera'; phase = 'worn'; workerReady = faceWorkerReady = true;
    worker = { postMessage(data) { sentHands.push(data); } };
    faceWorker = { postMessage(data) { sentFaces.push(data); } };`);
  h.element('throw-result').hidden = false;
  await h.run('requestFrame(1000)');
  assert.equal(sentHands.length, 0, 'completed exhibitions do not spend work on the hand detector');
  assert.equal(sentFaces[0].detectHands, false); assert.equal(sentFaces[0].faceIntervalMs, 100);
  h.run('faceProcessing = false; debugControls = {isOpen: () => true};'); h.video.currentTime++;
  await h.run('requestFrame(1200)');
  assert.equal(sentHands[0].detectHands, true);
  assert.equal(sentFaces.length, 2, 'face tracking continues independently');
  h.setNow(1300); h.receive({time:1300, facesUpdated:true, faces:[faceLandmarks(.75)]});
  assert.equal(h.run('lastResult'), 1300, 'face-only results keep the finished live camera active');
});

test('an unknown distant open hand cannot create a fast swing from a stationary grip', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(440, 400)], handedness: [[{ categoryName: 'Right' }]] });
  for (const time of [1100, 1200]) {
    h.setNow(time); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(900, 400, true)],
      handedness: [[{ categoryName: 'Right' }]], gestures: [[{ categoryName: 'Open_Palm', score: .99 }]] });
    assert.equal(h.state().phase, 'held');
    close(h.state().heldPose.x, 440);
    assert.equal(h.effects.release, 0);
  }
});

test('display compensation moves only the rendered pumpkin, never the measured throw history', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.setNow(1080); h.track({ time: 1000, faces: [faceLandmarks(.8)], hands: [handLandmarks(330, 400)] });
  h.setNow(1160); h.track({ time: 1080, faces: [faceLandmarks(.8)], hands: [handLandmarks(530, 400)] });
  const raw = h.state().heldPose.x, displayed = h.run('displayHeldPose(1160)');
  assert.ok(displayed.x > raw && displayed.x <= raw + 160);
  close(h.run('toss.history.at(-1).x'), raw);
  close(h.state().heldPose.x, raw);
  assert.equal(h.state().phase, 'held', 'predicted movement cannot release a pumpkin');
  h.setNow(1300); h.track({ time: 1200, faces: [faceLandmarks(.8)], hands: [] });
  assert.equal(h.effects.release, 0, 'losing a fast moving hand never invents a release');
});

test('a fresh 30fps camera frame is not throttled by the previous 40ms gate', async () => {
  const h = cameraHarness(); let frames = 0;
  h.context.createImageBitmap = async () => { frames++; return { close() {} }; };
  h.run("source = 'camera'; workerReady = true; worker = { postMessage() {} };");
  await h.run('requestFrame(1000)');
  h.run('processing = false'); h.video.currentTime = .033;
  await h.run('requestFrame(1033)');
  assert.equal(frames, 2);
  h.run('processing = false'); await h.run('requestFrame(1066)');
  assert.equal(frames, 2, 'identical video frames must still be skipped');
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

test('switching to mouse camera reuses the stream and stops both previous workers', async () => {
  const h = cameraHarness(), media = mediaStream();
  const previous = { terminated: 0, terminate() { this.terminated++; } };
  const previousFace = { terminated: 0, terminate() { this.terminated++; } };
  h.attach(media, previous, previousFace);
  const starting = h.start(false, 'mouse'); await h.settle();
  assert.equal(h.mediaRequests.length, 0);
  assert.equal(previous.terminated, 1);
  assert.equal(previousFace.terminated, 1);
  assert.equal(media.track.stops, 0);
  assert.equal(h.video.srcObject, media);
  assert.equal(h.workers.at(-1).messages[0].detectHands, false);
  assert.equal(h.workers.length, 1, 'mouse camera needs only a face detector');
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
  h.workers[0].fail(); await starting;
  assert.equal(h.state().source, 'mouse-camera');
  assert.equal(h.state().stream, media);
  assert.equal(h.video.srcObject, media);
  assert.equal(media.track.stops, 0);
  assert.equal(h.state().worker, null);
  assert.equal(h.state().faceWorker, null);
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
  const oldWorkers = [...h.workers];
  h.stop(); await starting;
  assert.equal(media.track.stops, 1);
  for (const oldWorker of oldWorkers) assert.equal(oldWorker.terminated, 1);
  assert.equal(h.state().stream, null);
  assert.equal(h.state().workerReady, false);
  for (const oldWorker of oldWorkers) h.ready(oldWorker);
  assert.equal(h.state().workerReady, false);
  assert.equal(h.state().faceWorkerReady, false);
  assert.equal(h.video.srcObject, null);
});
