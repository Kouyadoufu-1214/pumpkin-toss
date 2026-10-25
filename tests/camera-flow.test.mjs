import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clamp, distance, isPinched } from '../public/interaction.mjs';
import { resolveRoles, chooseControlHand, handGrip, TossGesture, DwellAction } from '../public/exhibit-logic.mjs';
import { FACE_OVAL, measureFace, fallbackFacePose, manualFaceTarget } from '../public/face-fit.mjs';
import { HandMotion } from '../public/hand-motion.mjs';

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
    clamp, distance, isPinched, resolveRoles, chooseControlHand, handGrip, HandMotion,
    measureFace, fallbackFacePose, manualFaceTarget,
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
    state: () => vm.runInContext('({ source, phase, pointer, heldPose, flight, faces, caster, receiver, manualTarget, mouseTrackedFace, stream, worker, workerReady, loading, session })', context),
    run: code => vm.runInContext(code, context),
    setNow: time => { now = time; },
    point: (type, x, y, pointerId = 7) => canvas.listeners.get(type)?.({ clientX: x, clientY: y, pointerId }),
    track: data => context.acceptTracking({ faces: [], hands: [], matrices: [], time: now, ...data }),
    receive: data => context.acceptTracking(data),
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

test('losing the receiver never transfers a flying or worn pumpkin to the other participant', () => {
  for (const phase of ['flying', 'worn']) {
    for (const swapped of [false, true]) {
      const h = cameraHarness(); h.run(`source = 'mouse-camera'; swapped = ${swapped};`);
      const targetX = swapped ? .25 : .75, otherX = swapped ? .75 : .25;
      h.track({ faces: [faceLandmarks(otherX), faceLandmarks(targetX)] });
      const selected = h.state().receiver;
      h.run('launch(restPose(), currentTarget())'); h.run(`phase = '${phase}'`);
      h.track({ faces: [faceLandmarks(otherX)] });
      assert.equal(h.state().receiver, null, 'the remaining participant is outside the tracking gate');
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

test('resetting a round or stopping the camera clears its destination lock for the next visitor', () => {
  const h = cameraHarness(); h.run("source = 'mouse-camera';");
  h.track({ faces: [faceLandmarks(.75)] });
  h.run('launch(restPose(), currentTarget())');
  h.track({ faces: [faceLandmarks(.25)] });
  assert.equal(h.state().receiver, null);
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

test('a fist anywhere on the throwing side grabs immediately and throws at sparse camera intervals', () => {
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
  assert.equal(h.state().phase, 'held', 'a fist away from the resting pumpkin can summon it');
  frame(1500, 180, 430);
  frame(1750, 350, 430);
  assert.equal(h.state().phase, 'held');
  assert.equal(h.effects.begin, 1);
  frame(2000, 570, 390);
  frame(2250, 790, 350);
  assert.equal(h.state().phase, 'held');
  frame(2500, 840, 340, true);
  assert.equal(h.state().phase, 'held', 'one open observation cannot release the pumpkin');
  frame(2750, 845, 340, true);
  assert.equal(h.effects.release, 1);
  assert.equal(h.state().phase, 'flying');
  assert.equal(h.state().flight.target.x, 960);
});

test('a fist can summon and hold a pumpkin before either face is detected', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ hands: [handLandmarks(150, 250)], gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
  assert.equal(h.state().phase, 'held');
  assert.ok(h.state().heldPose);
  assert.equal(h.state().receiver, null);
  assert.match(h.element('live-status').textContent, /つかんだ.*顔/);
  h.setNow(1200); h.track({ hands: [handLandmarks(220, 250)] });
  assert.equal(h.state().phase, 'held', 'missing faces cannot cancel a held pumpkin');
});

test('only the receiver face is needed to complete a hand throw', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  for (const [time, x, open] of [[1000, 160, false], [1200, 330, false], [1350, 470, true], [1450, 480, true]]) {
    h.setNow(time); h.track({ faces: [faceLandmarks(.75)], hands: [handLandmarks(x, 400, open)],
      gestures: [[{ categoryName: open ? 'Open_Palm' : 'Closed_Fist', score: .95 }]] });
  }
  assert.equal(h.state().caster, null);
  assert.equal(h.state().phase, 'flying');
  close(h.state().flight.target.x, 960);
});

test('a brief face miss retains the receiver, but an expired face never becomes a throw destination', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ faces: [faceLandmarks(.75)], hands: [handLandmarks(150, 400)] });
  h.setNow(1300); h.track({ hands: [handLandmarks(160, 400)] });
  assert.equal(h.state().receiver.x, 960);
  assert.equal(h.state().phase, 'held');
  h.setNow(1700); h.track({ hands: [handLandmarks(170, 400)] });
  h.setNow(1900); h.track({ hands: [handLandmarks(350, 400)] });
  assert.equal(h.state().receiver, null, 'cached faces expire after 850ms');
  assert.equal(h.state().phase, 'held');
  for (const time of [2000, 2100]) {
    h.setNow(time); h.track({ hands: [handLandmarks(450, 400, true)], gestures: [[{ categoryName: 'Open_Palm', score: .95 }]] });
  }
  assert.equal(h.state().phase, 'ready');
  assert.equal(h.state().flight, null);
  assert.match(h.element('message').textContent, /相手の顔/);
});

test('brief hand loss retains the held pose without releasing and longer loss cancels safely', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ hands: [handLandmarks(150, 400)] });
  const held = h.state().heldPose;
  h.setNow(1300); h.track({});
  assert.equal(h.state().phase, 'held');
  assert.equal(h.state().heldPose, held);
  assert.equal(h.effects.release, 0);
  h.setNow(1600); h.track({});
  assert.equal(h.state().phase, 'ready');
  assert.equal(h.state().heldPose, null);
  assert.equal(h.effects.release, 0);
  h.setNow(1700); h.track({ hands: [handLandmarks(150, 400)] });
  assert.equal(h.state().phase, 'held', 'another fist starts a fresh hold after loss');
});

test('a face crossing the middle cannot remain cached as its own receiver', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(); h.run(`source = 'camera'; swapped = ${swapped}; resetRound();`);
    h.track({ faces: [faceLandmarks(swapped ? .47 : .53)] });
    assert.ok(h.state().receiver);
    h.setNow(1100); h.track({ faces: [faceLandmarks(swapped ? .53 : .47)] });
    assert.ok(h.state().caster);
    assert.equal(h.state().receiver, null, 'a currently visible face takes precedence over its previous position');
  }
});

test('a single false open classification during a swing does not drop or throw the pumpkin', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  const frame = (time, x, open) => {
    h.setNow(time); h.track({ faces: [faceLandmarks(.75)], hands: [handLandmarks(x, 400, open)],
      gestures: [[{ categoryName: open ? 'Open_Palm' : 'Closed_Fist', score: .95 }]] });
  };
  frame(1000, 150, false); frame(1150, 300, true); frame(1250, 350, false);
  assert.equal(h.state().phase, 'held');
  assert.equal(h.effects.release, 0);
  frame(1350, 450, true); frame(1380, 460, true);
  assert.equal(h.effects.release, 0, 'opening must persist for at least 60ms');
  frame(1430, 470, true);
  assert.equal(h.state().phase, 'flying');
  assert.equal(h.effects.release, 1);
});

test('pulling an open hand back during release confirmation cancels instead of throwing', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  for (const [time, x, open] of [[1000, 150, false], [1150, 300, false], [1300, 450, true], [1400, 350, true]]) {
    h.setNow(time); h.track({ faces: [faceLandmarks(.75)], hands: [handLandmarks(x, 400, open)],
      gestures: [[{ categoryName: open ? 'Open_Palm' : 'Closed_Fist', score: .95 }]] });
  }
  assert.equal(h.state().phase, 'ready');
  assert.equal(h.effects.release, 0);
  assert.equal(h.state().flight, null);
});

test('an invalid hand is ignored and cannot prevent a valid fist from grabbing', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  const bad = handLandmarks(150, 400); bad[5].x = NaN;
  assert.doesNotThrow(() => h.track({ hands: [[], bad, handLandmarks(250, 400)] }));
  assert.equal(h.state().phase, 'held');
});

test('recognition preserves more camera detail without upscaling a small camera stream', async () => {
  const h = cameraHarness(), sizes = [];
  h.context.createImageBitmap = async (video, options) => { sizes.push(options); return { close() {} }; };
  h.run('workerReady = true; worker = { postMessage() {} };');
  await h.run('requestFrame(1000)');
  assert.equal(sizes[0].resizeWidth, 960); assert.equal(sizes[0].resizeHeight, 540);
  h.video.videoWidth = 640; h.video.videoHeight = 480; h.video.currentTime++;
  h.run('processing = false'); await h.run('requestFrame(1200)');
  assert.equal(sizes[1].resizeWidth, 640); assert.equal(sizes[1].resizeHeight, 480);
});

test('hands are applied before face work finishes without releasing the in-flight frame slot', async () => {
  const h = cameraHarness();
  const starting = h.start(false, 'hand'); await h.settle(); h.ready(); await starting;
  h.run('processing = true');
  const worker = h.workers.at(-1);
  worker.emit({ type: 'hands', time: 1000, hands: [handLandmarks(180, 400)], gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
  assert.equal(h.state().phase, 'held', 'hand interaction is usable without waiting for the face result');
  assert.equal(h.run('processing'), true);
  assert.equal(h.effects.begin, 1);
  worker.emit({ type: 'result', time: 1000, facesUpdated: true, faceTime: 1000, faces: [faceLandmarks(.75)], matrices: [] });
  assert.equal(h.run('processing'), false);
  assert.equal(h.state().phase, 'held');
  assert.equal(h.effects.begin, 1, 'a completion cannot replay the hand sample');
  close(h.state().receiver.x, 960);
});

test('skipping face inference preserves a recent target but cannot renew an old face indefinitely', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.receive({ time: 1000, facesUpdated: true, faceTime: 1000, faces: [faceLandmarks(.75)], matrices: [] });
  for (const time of [1200, 1600, 1800]) {
    h.setNow(time);
    h.receive({ type: 'hands', time, hands: [handLandmarks(180, 400)] });
    h.receive({ type: 'result', time, facesUpdated: false, faceTime: 1000, faces: [] });
    close(h.state().receiver.x, 960);
  }
  h.setNow(1900);
  h.receive({ type: 'hands', time: 1900, hands: [handLandmarks(180, 400)] });
  h.receive({ type: 'result', time: 1900, facesUpdated: false, faceTime: 1000, faces: [] });
  assert.equal(h.state().receiver, null);
  assert.equal(h.state().phase, 'held');
});

test('fast observed swings across a large frame jump can launch on a single confident open hand', () => {
  for (const swapped of [false, true]) {
    const h = cameraHarness(); h.run(`source = 'camera'; swapped = ${swapped}; resetRound();`);
    const start = swapped ? 950 : 330, direction = swapped ? -1 : 1;
    h.setNow(1000); h.track({ faces: [faceLandmarks(swapped ? .2 : .8)], hands: [handLandmarks(start, 400)],
      handedness: [[{ categoryName: 'Right' }]], gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
    h.setNow(1040); h.track({ faces: [faceLandmarks(swapped ? .2 : .8)], hands: [handLandmarks(start + direction * 50, 395)],
      handedness: [[{ categoryName: 'Right' }]], gestures: [[{ categoryName: 'Closed_Fist', score: .95 }]] });
    h.setNow(1120); h.track({ faces: [faceLandmarks(swapped ? .2 : .8)], hands: [handLandmarks(start + direction * 490, 360, true)],
      handedness: [[{ categoryName: 'Right' }]], gestures: [[{ categoryName: 'Open_Palm', score: .95 }]] });
    assert.equal(h.state().phase, 'flying', 'the real hand moved farther than the old 190px reach');
    assert.equal(h.effects.release, 1);
  }
});

test('an uncertain open frame still waits for confirmation even during a fast swing', () => {
  const h = cameraHarness(); h.run("source = 'camera'; resetRound();");
  h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(330, 400)] });
  h.setNow(1040); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(380, 395)] });
  h.setNow(1120); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(820, 360, true)],
    gestures: [[{ categoryName: 'Open_Palm', score: .75 }]] });
  assert.equal(h.state().phase, 'held');
  assert.equal(h.effects.release, 0);
  h.setNow(1190); h.track({ faces: [faceLandmarks(.8)], hands: [handLandmarks(825, 360, true)],
    gestures: [[{ categoryName: 'Open_Palm', score: .75 }]] });
  assert.equal(h.state().phase, 'flying');
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
  h.run('workerReady = true; worker = { postMessage() {} };');
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
