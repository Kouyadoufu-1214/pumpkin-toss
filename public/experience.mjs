import { clamp, distance, isPinched } from './interaction.mjs';
import { resolveRoles, chooseControlHand, handGrip, TossGesture, DwellAction, flightPose } from './exhibit-logic.mjs?v=20261024-camera';
import { Pumpkin3D, faceQuaternion, blendOrientation } from './pumpkin-3d.mjs?v=20261025-head-cover';
import { measureFace, faceCoverRegion, fallbackFacePose, manualFaceTarget, smoothFacePose } from './face-fit.mjs?v=20261025-head-cover';
import { PumpkinArt } from './pumpkin-art.mjs?v=20261020-blank';
import { outlineInfo } from './carving-path.mjs';
import { encodeMask, decodeMask, validateArtwork, MAX_GALLERY_MASK_LENGTH } from './artwork-codec.mjs';
import { GALLERY_URL } from './gallery-config.mjs';
import { drawWorkshopScene } from './workshop-scene.mjs';

const $ = id => document.getElementById(id);
const canvas = $('screen'), c = canvas.getContext('2d'), video = $('camera-video');
const W = 1280, H = 720, art = new PumpkinArt(), toss = new TossGesture(), dwell = new DwellAction();
let pumpkin, pumpkin3DVisible = false;
try { pumpkin = new Pumpkin3D(art.canvas, W, H); $('renderer-status').textContent = '3D PUMPKIN'; }
catch (error) { $('renderer-status').textContent = '簡易表示'; console.warn('3D renderer unavailable', error); }
let source = 'guide', solo = false, swapped = false, phase = 'ready', carving = false, shape = 'round';
let guideStart = performance.now(), heldPose = null, flight = null, wornSince = 0, roleSince = 0;
let caster = null, receiver = null, controlHand = null, gripped = false, pinched = false;
let lastResult = 0, faces = [], hands = [], smoothTarget = null, pointer = null, messageTimer, lastCue = '';
let session = 0, stream = null, worker = null, workerReady = false, processing = false, lastFrame = 0, lastVideoTime = -1, loading = false, initTimer, requestReject;
let manualTarget = null, mouseTrackedFace = null, handSeenAt = 0, trackingInfo = {}, lastTrackingText = '', frameFailures = 0;
let renderTime = 0;
const facePoseCache = new WeakMap();
const cameraActive = () => source === 'camera' || source === 'mouse-camera';
const mouseControl = () => source === 'mouse' || source === 'mouse-camera';
let audioContext;
const DRAFT_KEY = 'pumpkin-toss-artwork-v1';
let draftTimer;
function artworkData() { return { version: 1, shape, mask: encodeMask((art.base || art.ctx.getImageData(0, 0, 512, 512)).data) }; }
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(artworkData())); $('draft-status').textContent = 'この端末に保存済み'; }
  catch { $('draft-status').textContent = '自動保存できません。「作品ファイルを保存」で残せます'; }
}
function queueDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 500); }
function downloadArtwork() {
  art.cancel();
  const url = URL.createObjectURL(new Blob([JSON.stringify(artworkData())], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'my-pumpkin.pumpkin.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function restoreDraft() {
  try {
    const saved = localStorage.getItem(DRAFT_KEY); if (!saved) return;
    const draft = validateArtwork(JSON.parse(saved));
    art.ctx.putImageData(new ImageData(decodeMask(draft.mask), 512, 512), 0, 0); art.changed = true; shape = draft.shape;
    document.querySelectorAll('[data-shape]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.shape === shape)));
    $('draft-status').textContent = '前回の続きから制作できます';
  } catch { $('draft-status').textContent = '前回の保存を読み込めませんでした'; }
}
const colors = { orange: '#ffb76b', violet: '#beafff', paper: '#f4efdf' };
const shapeScale = () => shape === 'tall' ? [.86, 1.18] : shape === 'wide' ? [1.22, .87] : [1, 1];
const roleOptions = () => ({ width: W, swapped, solo });
const carvingDonePoint = () => matchMedia('(max-width:620px)').matches ? { x: 850, y: 620 } : { x: 1050, y: 545 };
const sampleFace = side => ({ x: side === 'left' ? 330 : 950, y: 345, w: 103, h: 145, sample: true });
const sampleRoles = () => ({ caster: sampleFace(swapped ? 'right' : 'left'), receiver: sampleFace(swapped ? 'left' : 'right') });

function cue(step, title, detail) {
  const key = `${step}|${title}|${detail}`;
  if (key === lastCue) return;
  lastCue = key; $('cue-step').textContent = step; $('cue-title').textContent = title; $('cue-detail').textContent = detail;
}
function notice(text, duration = 3800) {
  clearTimeout(messageTimer); $('message').textContent = text; $('message').hidden = false;
  messageTimer = setTimeout(() => $('message').hidden = true, duration);
}
function hideThrowResult() {
  const result = $('throw-result');
  if (result.contains(document.activeElement)) $('cue-title').focus({ preventScroll: true });
  result.hidden = true; $('exhibit').classList.remove('throw-complete');
}
function updateThrowResult(time) {
  const result = $('throw-result');
  if (!result.hidden || carving || (loading && source !== 'mouse-camera') || source === 'guide' || phase !== 'worn' || !receiver || time - wornSince < 1200) return;
  if (!$('settings').hidden || $('setup-dialog').open) return;
  dwell.reset(); result.hidden = false; $('exhibit').classList.add('throw-complete');
  $('throw-result-title').focus({ preventScroll: true }); result.scrollIntoView({ block: 'nearest' });
}
function resetRound() {
  hideThrowResult();
  phase = source === 'camera' ? 'waiting' : 'ready'; toss.cancel(); heldPose = flight = smoothTarget = mouseTrackedFace = null;
  controlHand = null; gripped = pinched = false; dwell.reset(); art.cancel(); pointer = null; roleSince = 0;
  $('restart').hidden = true;
}
function cancelHold(message) {
  if (phase === 'held') { toss.cancel(); heldPose = null; phase = 'ready'; if (message) notice(message); }
  gripped = false; controlHand = null;
  if (!carving || pointer === null) {
    if (carving && art.base) carvingFeedback('手を見失ったので、下書きを取り消しました。もう一度描こう');
    art.cancel();
  }
  pinched = false;
}
function restPose(time = performance.now()) {
  const person = caster || sampleRoles().caster;
  const side = person.x > W / 2 ? -1 : 1;
  const [sx, sy] = shapeScale();
  return { x: clamp(person.x + side * Math.max(115, person.w), 175, W - 175), y: clamp(person.y + person.h * .85, 350, 555) + Math.sin(time / 650) * 5, w: 240 * sx, h: 215 * sy, yaw: Math.sin(time / 1400) * .08 };
}
function targetPose(face) {
  if (!face) return null;
  if (!face.sample) {
    const scale = (Number($('face-fit-scale').value) || 100) / 100;
    const cached = facePoseCache.get(face);
    if (cached && cached.scale === scale && cached.shape === shape && cached.geometry === pumpkin?.geometry) return cached.pose;
    const options = { scale, shape };
    const pose = pumpkin?.fitFacePose(face, options) || fallbackFacePose(face, options);
    facePoseCache.set(face, { scale, shape, geometry: pumpkin?.geometry, pose });
    return pose;
  }
  const [sx, sy] = shapeScale();
  return { x: face.x, y: face.y - face.h * .05, w: clamp(face.w * 2.35, 150, 400) * sx, h: clamp(face.h * 1.55, 170, 440) * sy, quaternion: face.quaternion, manual: !!face.manual, yaw: face.sample ? Math.sin(performance.now() / 1100) * .12 : 0 };
}
function currentTarget() { return targetPose(receiver); }
function launch(from, target) {
  if (!target) { cancelHold(); notice('かぶる人の顔が映ってから投げよう'); return; }
  hideThrowResult();
  flight = { start: { ...from }, target: { ...target }, since: performance.now() };
  phase = 'flying'; toss.cancel(); gripped = false; heldPose = null; dwell.reset(); tone('throw');
}
function tone(type) {
  if (!$('sound').checked) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume();
    const osc = audioContext.createOscillator(), gain = audioContext.createGain(), now = audioContext.currentTime;
    osc.type = 'sine'; osc.frequency.setValueAtTime(type === 'throw' ? 250 : 680, now);
    osc.frequency.exponentialRampToValueAtTime(type === 'throw' ? 600 : 180, now + .17);
    gain.gain.setValueAtTime(.09, now); gain.gain.exponentialRampToValueAtTime(.001, now + .22);
    osc.connect(gain).connect(audioContext.destination); osc.start(now); osc.stop(now + .25);
  } catch { /* Audio is optional and may be blocked until a click. */ }
}
function startSample(mode) {
  stopCamera(); source = mode; solo = false; guideStart = performance.now(); resetRound();
  $('source-badge').textContent = mode === 'guide' ? '● お手本 / 自動で再生' : '● マウスで体験';
  $('stage-note').textContent = mode === 'guide' ? 'この2人はお手本です。カメラの映像ではありません。' : 'カボチャをドラッグして、相手の方向へはなす';
  $('live-status').hidden = true; $('target-auto').hidden = true;
}

function mouseCameraRoles() {
  caster = sampleRoles().caster;
  const trackingThrow = (phase === 'flying' || phase === 'worn') && flight && !manualTarget;
  const previous = trackingThrow && mouseTrackedFace;
  // Detector array order and left/right extremes are not person identities.
  // Keep the last destination through a missed detection instead of attaching
  // the pumpkin to the other participant who is still visible.
  const reach = previous ? Math.max(120, Math.min(W * .3, previous.h * 1.2)) : 0;
  const detected = previous
    ? faces.filter(face => distance(face, previous) <= reach).sort((a, b) => distance(a, previous) - distance(b, previous))[0]
    : [...faces].sort((a, b) => swapped ? a.x - b.x : b.x - a.x)[0];
  if (detected && !manualTarget) mouseTrackedFace = detected;
  const trackingLost = trackingThrow && (mouseTrackedFace || !flight.target.manual);
  receiver = manualTarget || detected || (trackingLost ? null : { ...sampleRoles().receiver, sample: false, manual: true });
}
function updateCameraLabels() {
  $('source-badge').textContent = source === 'mouse-camera' ? '● LIVE / マウスで投げる' : solo ? '● LIVE / 手で投げる・ひとり練習' : '● LIVE / 手で投げる・2人プレイ';
  $('stage-note').textContent = source === 'mouse-camera' ? 'かぼちゃをドラッグして投げる。顔をクリックすると、かぶせる位置を指定できます。' : solo ? '左でグー → 相手へ動かしてパー。つまんで、はなしてもOK。' : '左右に立ち、かぼちゃの近くでグー → 相手へ動かしてパー。';
  $('live-status').hidden = false;
  $('target-auto').hidden = source !== 'mouse-camera' || !manualTarget;
}
function updateTrackingStatus(elapsed = 0) {
  const engine = trackingInfo.handEngine === 'gesture-recognizer' ? 'グー・パー認識' : trackingInfo.handEngine === 'hand-landmarker' ? '指の位置で認識' : '手の認識なし';
  const status = phase === 'worn' ? receiver?.measured && !receiver.manual ? '髪・耳まで覆うサイズで追従中' : '投球完了 · カメラ映像はそのまま表示中' : source === 'mouse-camera'
    ? manualTarget ? '位置を指定中 · マウスで投げられます' : faces.length ? '頭全体にサイズ調整中 · マウスで投げられます' : '顔をクリックして位置を指定できます'
    : `顔 ${faces.length}人 · 手 ${hands.length}本 · ${phase === 'held' ? 'つかんだ！ 相手へ動かしてパー' : controlHand ? gripped ? 'グーを認識' : 'パー・手を認識' : '手をカメラに見せよう'}`;
  if (status !== lastTrackingText) { $('live-status').textContent = status; lastTrackingText = status; }
  $('tracking-status').textContent = `${engine} / 顔 ${faces.length}人 / 手 ${hands.length}本 / 検出 ${elapsed ? Math.round(1000 / elapsed) : '—'}回/秒`;
}

function cameraRect() {
  const width = video.videoWidth || 1280, height = video.videoHeight || 720;
  const scale = Math.min(W / width, H / height);
  return { x: (W - width * scale) / 2, y: (H - height * scale) / 2, w: width * scale, h: height * scale };
}
function screenPoint(point) {
  const rect = cameraRect();
  return { x: rect.x + ($('mirror').checked ? 1 - point.x : point.x) * rect.w, y: rect.y + point.y * rect.h };
}
function stopCamera(keepStream = false) {
  session++; clearTimeout(initTimer); requestReject?.(new Error('cancelled')); requestReject = null;
  worker?.terminate(); worker = null; workerReady = processing = loading = false;
  if (!keepStream) { stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; }
  faces = []; hands = []; lastResult = 0; caster = receiver = null; cancelHold();
  handSeenAt = 0; trackingInfo = {}; manualTarget = mouseTrackedFace = null; lastTrackingText = ''; frameFailures = 0;
  $('loading').hidden = true; $('stop-camera').hidden = true;
  $('loading').classList.remove('camera-live');
  $('live-status').hidden = true; $('target-auto').hidden = true;
  $('play-pair').disabled = $('play-solo').disabled = false; $('tracking-status').textContent = 'カメラは停止中';
}
function trackingFallback(message) {
  clearTimeout(initTimer); worker?.terminate(); worker = null; workerReady = processing = false;
  const reject = requestReject; requestReject = null;
  loading = false; $('loading').hidden = true;
  $('play-pair').disabled = $('play-solo').disabled = false;
  source = 'mouse-camera'; solo = false; resetRound(); mouseCameraRoles(); updateCameraLabels(); updateTrackingStatus();
  reject?.(new Error('tracking-fallback'));
  notice(message, 9000);
}
async function refreshCameraList() {
  try {
    const selected = $('camera-device').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    $('camera-device').replaceChildren(new Option('自動で選ぶ', ''));
    devices.forEach((device, index) => $('camera-device').add(new Option(device.label || `カメラ ${index + 1}`, device.deviceId)));
    const active = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    $('camera-device').value = devices.some(device => device.deviceId === selected) ? selected : active || '';
  } catch { /* A device list is optional; the default camera still works. */ }
}
async function startCamera(practice = false, input = 'hand', reuse = true) {
  const keepStream = reuse && stream?.getVideoTracks().some(track => track.readyState === 'live');
  stopCamera(keepStream); const id = session; solo = practice; if (solo) swapped = false;
  source = input === 'mouse' ? 'mouse-camera' : 'camera'; resetRound();
  loading = true; $('loading').hidden = false; $('stop-camera').hidden = false;
  $('loading-title').textContent = 'カメラを準備しています';
  $('loading-detail').textContent = 'カメラの使用を許可してください。';
  updateCameraLabels();
  const finishLoading = () => { clearTimeout(initTimer); loading = false; $('loading').hidden = true; };
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザーではカメラが使えません。localhostまたはHTTPSで開いてください。');
    initTimer = setTimeout(() => { if (id === session) { startSample('mouse'); notice('カメラの許可と接続を確認して、もう一度お試しください。', 8000); } }, 60000);
    if (!keepStream) {
      const deviceId = $('camera-device').value;
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: $('facing').value } }) } });
      if (id !== session) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media; video.srcObject = media;
    }
    await video.play();
    if (id !== session) return;
    clearTimeout(initTimer); refreshCameraList();
    stream.getVideoTracks()[0].onended = () => { if (id === session) { startSample('mouse'); notice('カメラが切断されました。接続して再開してください。'); } };
    $('loading').classList.add('camera-live');
    $('loading-title').textContent = input === 'mouse' ? '顔への自動追従を準備中' : 'グー・パーの認識を準備中';
    $('loading-detail').textContent = input === 'mouse' ? '映像を見ながら、先にマウスで投げられます。' : '映像は表示中です。「映像＋マウスで投げる」にも切り替えられます。';
    if (input === 'mouse') { mouseCameraRoles(); updateTrackingStatus(); }
    initTimer = setTimeout(() => { if (id === session) trackingFallback('認識の準備に時間がかかっています。映像を残してマウス操作に切り替えました。'); }, 45000);
    worker = new Worker('./tracker-worker.js?v=20261024-camera');
    await new Promise((resolve, reject) => {
      requestReject = reject;
      worker.onerror = () => {
        if (id !== session) return;
        trackingFallback('認識を起動できませんでした。映像を残してマウス操作に切り替えました。');
      };
      worker.onmessage = ({ data }) => {
        if (id !== session) return;
        if (data.type === 'ready') { workerReady = true; trackingInfo = data; requestReject = null; resolve(); }
        else if (data.type === 'result') { processing = false; acceptTracking(data); }
        else if (data.type === 'status') {
          trackingInfo = data;
          if (source === 'camera' && (data.handEngine === 'unavailable' || data.faceEngine === 'unavailable')) {
            source = 'mouse-camera'; solo = false; resetRound(); mouseCameraRoles(); updateCameraLabels();
            notice('手・顔の認識が止まったため、映像を残してマウス操作に切り替えました。', 8000);
          }
          updateTrackingStatus();
        }
        else if (data.type === 'error') {
          processing = false;
          trackingFallback('認識が止まったため、映像を残してマウス操作に切り替えました。');
        }
      };
      worker.postMessage({ type: 'init', detectHands: input !== 'mouse' });
    });
    if (id !== session) return;
    finishLoading(); lastFrame = 0; lastVideoTime = -1;
    if (source === 'camera' && (trackingInfo.handEngine === 'unavailable' || trackingInfo.faceEngine === 'unavailable')) {
      source = 'mouse-camera'; solo = false; resetRound(); mouseCameraRoles(); updateCameraLabels();
      notice('手・顔の認識を準備できませんでした。映像を残してマウス操作に切り替えました。', 9000);
    }
    updateTrackingStatus();
  } catch (error) {
    if (id !== session) return;
    if (error.message === 'tracking-fallback') return;
    if (stream && video.readyState >= 2) { trackingFallback('認識を準備できませんでした。映像を残してマウス操作に切り替えました。'); return; }
    startSample('mouse');
    const reasons = { NotAllowedError: 'カメラが許可されていません。ブラウザーのカメラ許可を確認してください。', NotFoundError: 'カメラが見つかりません。接続を確認してください。', NotReadableError: 'カメラを開けません。他のカメラアプリを閉じて、もう一度お試しください。' };
    notice(reasons[error.name] || `準備できませんでした：${error.message}`, 8000);
  }
}
async function requestFrame(time) {
  if (processing && time - lastFrame > 8000) { trackingFallback('認識の応答が止まりました。映像を残してマウス操作に切り替えました。'); return; }
  if (!workerReady || processing || video.readyState < 2 || document.hidden || time - lastFrame < 40 || video.currentTime === lastVideoTime) return;
  const id = session; processing = true; lastFrame = time; lastVideoTime = video.currentTime;
  try {
    const scale = Math.min(640 / video.videoWidth, 640 / video.videoHeight, 1);
    const bitmap = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale) });
    if (id !== session || !worker) { bitmap.close(); return; }
    worker.postMessage({ type: 'frame', bitmap, time }, [bitmap]);
    frameFailures = 0;
  } catch {
    if (id === session) {
      processing = false;
      if (++frameFailures >= 3) trackingFallback('映像を認識処理に渡せませんでした。映像を残してマウス操作に切り替えました。');
    }
  }
}
function acceptTracking(data) {
  const now = performance.now(), time = data.time ?? now, elapsed = lastResult ? now - lastResult : 0; lastResult = now;
  trackingInfo = { ...trackingInfo, ...data };
  faces = data.faces.map((points, index) => measureFace(points, screenPoint, faceQuaternion(data.matrices?.[index], $('mirror').checked))).filter(Boolean);
  if (source === 'mouse-camera') { mouseCameraRoles(); updateTrackingStatus(elapsed); return; }
  const roles = resolveRoles(faces, roleOptions()); caster = roles.caster; receiver = solo ? sampleFace('right') : roles.receiver;
  hands = data.hands.map((points, index) => {
    const mapped = points.map(screenPoint), palm = { x: (mapped[0].x + mapped[5].x + mapped[17].x) / 3, y: (mapped[0].y + mapped[5].y + mapped[17].y) / 3 };
    return { points: mapped, wrist: mapped[0], palm, label: data.handedness?.[index]?.[0]?.categoryName, gesture: data.gestures?.[index]?.[0] };
  });
  updateTrackingStatus(elapsed);
  if (caster && receiver) {
    roleSince ||= time;
    if (phase === 'waiting' && time - roleSince > 400) phase = 'ready';
  } else {
    roleSince = 0;
    if (phase === 'held') cancelHold('2人の顔が映ってから、もう一度つかもう');
    if (phase === 'ready') phase = 'waiting';
  }
  // Pointer drags must never be released or cancelled by a hand inference.
  if (!carving && pointer !== null) return;
  const previous = controlHand, gap = handSeenAt ? time - handSeenAt : elapsed;
  controlHand = chooseControlHand(hands, phase === 'held' || carving ? previous : null, { ...roleOptions(), elapsed: gap, anchor: restPose(time) });
  if (!controlHand) {
    // A brief missed frame can keep the held pose, but never creates a release.
    if (!carving && phase === 'held' && previous && gap <= 220) { controlHand = previous; return; }
    cancelHold(previous && phase === 'held' ? '手を見失いました。かぼちゃの近くで、もう一度グーにしよう' : null); dwell.reset(); return;
  }
  handSeenAt = time;
  if (carving) {
    const pinch = isPinched(controlHand.points, pinched);
    if (pointer === null) {
      if (pinch) carveAt(controlHand.points[8]); else if (pinched) finishStroke();
    }
    pinched = pinch;
    if (dwell.update(!pinch && distance(controlHand.palm, carvingDonePoint()) < 70, time)) finishCarving();
    return;
  }
  if (phase === 'worn') {
    if (!$('throw-result').hidden) { dwell.reset(); return; }
    if (dwell.update(distance(controlHand.palm, { x: 640, y: 625 }) < 60, time)) resetRound();
    return;
  }
  const grip = handGrip(controlHand.points, gripped, controlHand.gesture), point = controlHand.palm;
  if (phase === 'ready' && grip && distance(point, restPose(time)) < 170) {
    toss.begin(point, time); phase = 'held'; heldPose = { ...restPose(time), x: point.x, y: point.y };
  } else if (phase === 'held') {
    heldPose.x = point.x; heldPose.y = point.y;
    if (grip) toss.move(point, time);
    else {
      const from = { ...heldPose }, target = currentTarget(), result = toss.release(point, time, target);
      if (result.ok) launch(from, target);
      else { cancelHold(); notice(result.reason === 'no-receiver' ? '相手の顔をカメラに映そう' : '相手のほうへ、少し大きく振って手を開こう'); }
    }
  }
  gripped = grip;
  updateTrackingStatus(elapsed);
}

function openCarving() {
  if (source === 'guide') startSample('mouse');
  resetRound(); carving = true; $('exhibit').classList.add('carving'); $('workshop').hidden = false;
  updateCarvingTools();
  $('stage-note').textContent = 'マウスでなぞろう。カメラでは親指と人差し指をつまんで動かします';
}
function finishCarving() {
  art.cancel(); saveDraft();
  carving = false; $('exhibit').classList.remove('carving'); $('workshop').hidden = true; resetRound();
  if (cameraActive()) updateCameraLabels();
  else $('stage-note').textContent = '作ったカボチャをドラッグして、相手へはなす';
  updateCue(); $('theater').scrollIntoView({ block: 'start' }); $('cue-title').focus({ preventScroll: true });
}
const carvingPose = () => { const [sx, sy] = shapeScale(); return { x: 640, y: 422, w: 530 * sx, h: 480 * sy }; };
function carveAt(point) {
  const pose = carvingPose();
  const hit = pumpkin3DVisible && pumpkin ? pumpkin.hit(point, pose, true) : { x: (point.x - pose.x) / (pose.w * .76) * 512 + 256, y: (point.y - pose.y) / (pose.h * .76) * 512 + 256 };
  const valid = art.stroke(hit);
  carvingFeedback(!valid ? '表面から外れました。指をはなして、もう一度描こう' : art.options.mode === 'scrape' ? '皮を削っています。同じ場所を重ねてなぞると穴が開くよ' : art.options.mode === 'restore' ? 'なぞった部分を埋め直しています' : art.options.mode === 'line' ? '下書き中 · はなすと線を削ります' : outlineInfo(art.draft.points).closed ? '輪郭がつながった！ はなすと切り抜けます' : '下書き中 · 描き始めの丸まで戻ろう');
}
function carvingFeedback(message) { if ($('carving-feedback').textContent !== message) $('carving-feedback').textContent = message; }
function finishStroke() {
  const result = art.end();
  if (!result) return;
  const messages = { cut: 'きれいに削れた！ 次の目や口を描こう', open: 'まだ輪郭が開いています。始めの丸に戻ってから、はなそう', small: 'もう少し大きく描いてみよう', interrupted: '下書きを取り消しました。表面の中でもう一度描こう' };
  carvingFeedback(messages[result.kind]);
  if (result.kind === 'cut') { queueDraft(); $('undo').disabled = false; $('redo').disabled = true; }
}
function updateCarvingTools() {
  const cutout = art.options.mode === 'cutout';
  document.querySelectorAll('[data-carve-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.carveMode === art.options.mode)));
  $('brush-control').hidden = cutout;
  $('undo').disabled = !art.history.length; $('redo').disabled = !art.future.length;
  carvingFeedback(cutout ? '一筆で囲んで、始めの丸に戻ってはなす → 中を切り抜く' : art.options.mode === 'scrape' ? 'なぞって皮を削る → はなして、同じ場所を重ねて削ると穴が開く' : art.options.mode === 'restore' ? '埋めたい場所をなぞろう。あとから、また彫り直せます' : '好きな線を描いてはなす → なめらかな線で削る');
}
function pointerPoint(event) {
  const box = canvas.getBoundingClientRect();
  const scale = getComputedStyle(canvas).objectFit === 'cover' ? Math.max(box.width / W, box.height / H) : Math.min(box.width / W, box.height / H);
  return { x: (event.clientX - box.left - (box.width - W * scale) / 2) / scale, y: (event.clientY - box.top - (box.height - H * scale) / 2) / scale };
}
canvas.addEventListener('pointerdown', event => {
  if ((loading && !(source === 'mouse-camera' && stream && video.readyState >= 2)) || !$('throw-result').hidden) return;
  const point = pointerPoint(event);
  if (carving) { art.cancel(); pointer = event.pointerId; canvas.setPointerCapture(pointer); carveAt(point); return; }
  if (source === 'guide') return;
  if (phase === 'worn' && distance(point, { x: 640, y: 625 }) < 70) { resetRound(); return; }
  if (source === 'mouse-camera' && phase === 'ready' && distance(point, restPose()) > 140) {
    manualTarget = manualFaceTarget({ x: clamp(point.x, 80, W - 80), y: clamp(point.y, 100, H - 100) }, faces, receiver);
    mouseCameraRoles(); updateCameraLabels(); updateTrackingStatus(); return;
  }
  if (phase !== 'ready' || distance(point, restPose()) > 140) return;
  pointer = event.pointerId; canvas.setPointerCapture(pointer); toss.begin(point, performance.now()); phase = 'held'; heldPose = { ...restPose(), x: point.x, y: point.y };
});
canvas.addEventListener('pointermove', event => {
  if (pointer !== event.pointerId) return;
  const point = pointerPoint(event);
  if (carving) { carveAt(point); return; }
  if (phase !== 'held') return;
  heldPose.x = point.x; heldPose.y = point.y; toss.move(point, performance.now());
});
canvas.addEventListener('pointerup', event => {
  if (pointer !== event.pointerId) return;
  pointer = null;
  if (carving) { carveAt(pointerPoint(event)); finishStroke(); return; }
  if (phase !== 'held') return;
  const from = { ...heldPose }, target = currentTarget();
  const result = toss.release(pointerPoint(event), performance.now(), target);
  if (result.ok) launch(from, target);
  else { cancelHold(); notice('相手の方向へ、シュッと動かしてはなそう'); }
});
canvas.addEventListener('pointercancel', () => { pointer = null; cancelHold(); });
window.addEventListener('blur', () => { pointer = null; cancelHold(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelHold(); lastResult = 0; } });
window.addEventListener('pagehide', () => stopCamera());

function roundRect(x, y, w, h, r, fill, stroke) {
  c.beginPath(); c.roundRect(x, y, w, h, r); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}
function text(label, x, y, size = 18, color = colors.paper, weight = 500) {
  c.fillStyle = color; c.font = `${weight} ${size}px "Yu Gothic UI",Meiryo,sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, x, y);
}
function line(points, color, width = 3) {
  c.beginPath(); points.forEach((point, i) => i ? c.lineTo(point.x, point.y) : c.moveTo(point.x, point.y)); c.strokeStyle = color; c.lineWidth = width; c.lineCap = c.lineJoin = 'round'; c.stroke();
}
function circle(x, y, r, fill, stroke) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); } }
function background(time) {
  const gradient = c.createLinearGradient(0, 0, W, H); gradient.addColorStop(0, '#2b202a'); gradient.addColorStop(.48, '#231c30'); gradient.addColorStop(1, '#28213c');
  c.fillStyle = gradient; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(390, 390, 20, 390, 390, 400); glow.addColorStop(0, '#ffb76b13'); glow.addColorStop(1, '#ffb76b00'); c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#c8a9e810'; c.lineWidth = 1;
  for (let i = -8; i <= 8; i++) { c.beginPath(); c.moveTo(640 + i * 37, 580); c.lineTo(640 + i * 170, 720); c.stroke(); }
  for (const y of [580, 610, 653, 714]) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  for (let i = 0; i < 14; i++) circle(45 + (i * 173) % 1190, 170 + (i * 83) % 380 + Math.sin(time / 2200 + i) * 12, 1.6, i % 2 ? '#d6b8fa35' : '#ffd2a52b');
}
function drawCamera() {
  if (video.readyState < 2 || !stream) return;
  const rect = cameraRect(); c.save();
  if ($('mirror').checked) { c.translate(W, 0); c.scale(-1, 1); }
  c.drawImage(video, rect.x, rect.y, rect.w, rect.h); c.restore();
  const shade = c.createLinearGradient(0, 0, 0, 225); shade.addColorStop(0, '#130e22b8'); shade.addColorStop(1, '#130e2200'); c.fillStyle = shade; c.fillRect(0, 0, W, 225);
}
function person(face, isCaster, time, handPoint = null) {
  const x = face.x, y = face.y, bob = Math.sin(time / 1100 + (isCaster ? 0 : 1)) * 2;
  const shirt = isCaster ? '#b26949' : '#807294', shirtLight = isCaster ? '#dc9466' : '#a394c1';
  c.save(); c.translate(0, bob);
  c.fillStyle = '#110e1960'; c.beginPath(); c.ellipse(x, 631, 131, 23, 0, 0, Math.PI * 2); c.fill();
  line([{ x: x - 36, y: 548 }, { x: x - 45, y: 626 }], '#393443', 43); line([{ x: x + 36, y: 548 }, { x: x + 47, y: 626 }], '#393443', 43);
  roundRect(x - 65, y + 65, 130, 158, [44, 44, 20, 20], shirt);
  line([{ x: x - 26, y: y + 86 }, { x: x + 26, y: y + 86 }], shirtLight, 3);
  roundRect(x - 17, y + 44, 34, 38, 12, '#d8aa91');
  c.fillStyle = '#ecc4aa'; c.beginPath(); c.ellipse(x, y, 48, 61, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#372a31'; c.beginPath(); c.ellipse(x - 2, y - 39, 49, 29, -.15, Math.PI, Math.PI * 2); c.lineTo(x + 44, y - 17); c.quadraticCurveTo(x + 10, y - 53, x - 48, y - 20); c.closePath(); c.fill();
  circle(x - 17, y - 2, 3, '#563b39'); circle(x + 17, y - 2, 3, '#563b39');
  c.beginPath(); c.arc(x, y + 15, 13, .15, Math.PI - .15); c.strokeStyle = '#985d57'; c.lineWidth = 2.5; c.stroke();
  const direction = isCaster ? (swapped ? -1 : 1) : (swapped ? 1 : -1);
  const shoulder = { x: x + direction * 60, y: y + 95 };
  const hand = handPoint || { x: x + direction * 86, y: y + 193 };
  const elbow = { x: x + direction * 94, y: y + 145 };
  line([shoulder, elbow, hand], shirtLight, 28); circle(hand.x, hand.y, 17, '#ecc4aa');
  line([{ x: x - direction * 58, y: y + 95 }, { x: x - direction * 78, y: y + 190 }], shirt, 29); circle(x - direction * 78, y + 198, 16, '#ecc4aa');
  c.restore();
}
function rolePill(x, y, label, color) { roundRect(x - 100, y - 20, 200, 40, 20, '#17121ecd', `${color}65`); text(label, x, y, 15, color, 650); }
function zones() {
  c.save(); c.lineWidth = 2; c.setLineDash([10, 12]);
  for (const [x, isCaster] of [[85, !swapped], [755, swapped]]) {
    const color = isCaster ? colors.orange : colors.violet;
    roundRect(x, 225, 440, 385, 70, null, `${color}55`);
    text(isCaster ? '投げる人は、ここ' : 'かぶる人は、ここ', x + 220, 580, 21, color, 700);
  }
  c.restore();
}
function drawPumpkin(pose) {
  pumpkin3DVisible = false;
  if (!pose) return;
  if (pumpkin) {
    try {
      if (art.changed) { pumpkin.updateMask(); art.changed = false; }
      pumpkin3DVisible = pumpkin.draw(c, pose) === true;
    } catch (error) {
      // A broken renderer must not hide the artwork or retry the same error
      // every frame. The mask stays available for drawing, carving and saving.
      const failed = pumpkin; pumpkin = null;
      console.warn('3D drawing unavailable; using the 2D pumpkin.', error);
      try { failed.dispose(); } catch { /* Keep the artwork usable even if cleanup fails. */ }
    }
  }
  const status = pumpkin3DVisible ? '3D PUMPKIN' : '簡易表示';
  if ($('renderer-status').textContent !== status) $('renderer-status').textContent = status;
  if (pumpkin3DVisible) return;
  pose = pose.fallback || pose;
  c.save(); c.translate(pose.x, pose.y); c.rotate(pose.roll || 0);
  c.fillStyle = '#dc7320'; c.beginPath(); c.ellipse(0, 0, pose.w * .39, pose.h * .4, 0, 0, Math.PI * 2); c.fill();
  line([{ x: -2, y: -pose.h * .39 }, { x: 8, y: -pose.h * .5 }], '#60744b', 15);
  c.globalCompositeOperation = 'source-over'; c.drawImage(art.canvas, -pose.w * .38, -pose.h * .38, pose.w * .76, pose.h * .76); c.restore();
}
function handCursor(hand, active) {
  if (!hand) return;
  const p = carving ? hand.points[8] : hand.palm;
  circle(p.x, p.y, active ? 19 : 25, active ? '#ffb76b40' : '#ffffff15', active ? colors.orange : '#fff8');
  circle(p.x, p.y, 4, active ? colors.orange : '#fff');
}
function dwellButton(x, y, label, time) {
  circle(x, y, 43, '#221c2eea', '#beafff90');
  c.beginPath(); c.arc(x, y, 47, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dwell.progress(time)); c.strokeStyle = colors.orange; c.lineWidth = 5; c.stroke();
  text(label, x, y, 13, colors.paper, 700); text('手を重ねて待つ', x, y + 65, 11, '#c2b7ce');
}
function burst(pose, time) {
  const t = clamp((time - wornSince) / 1000, 0, 1); if (t >= 1 || !pose) return;
  c.save(); c.globalAlpha = 1 - t;
  for (let i = 0; i < 16; i++) {
    const angle = i / 16 * Math.PI * 2, radius = pose.w * .45 + 100 * t;
    circle(pose.x + Math.cos(angle) * radius, pose.y + Math.sin(angle) * radius, 4 - t * 2, i % 2 ? colors.violet : colors.orange);
  }
  c.restore();
}
function updateCue() {
  if (carving) { cue('HALLOWEEN WORKSHOP', '月夜のかぼちゃ工房', source === 'camera' ? '親指と人差し指をつまんで、きみだけの顔を彫ろう。' : 'マウスでひと彫り。きみだけのジャックオランタンに。'); return; }
  if (source === 'guide') return;
  if (phase === 'waiting') cue('GET READY', solo ? '左に映って、手を見せよう' : '2人で、左右の枠に入ろう', solo ? '右のお手本の相手に投げてみよう。' : 'オレンジが投げる人。むらさきがかぶる人。');
  if (phase === 'ready') cue('01 / つかむ', 'カボチャを、つかもう。', mouseControl() ? 'カボチャをマウスでつかんで、相手のほうへ。' : 'かぼちゃの近くでグー。つまんでもOK。手の丸印を重ねよう。');
  if (phase === 'held') cue('02 / 投げる', '相手へ振って、パッとはなす！', mouseControl() ? '少し大きく動かして、マウスをはなそう。' : '相手の方向へ手を動かしながら、パーにしよう。');
  if (phase === 'flying') cue('02 / 投げる', 'いっけー！', 'カボチャが、相手の頭へ。');
  if (phase === 'worn') cue('03 / かぶる', receiver ? 'スポッ！ お似合い！' : 'かぶる人は、同じ側へ戻ってね', receiver ? receiver.manual ? '指定した位置にかぶせました。もう一度投げたり、展示したりできます。' : '髪や耳まで、頭をすっぽり。近づいてもついてくる。' : '顔が映ったら、カボチャが戻ります。');
}

function render(time) {
  const elapsed = renderTime ? time - renderTime : 1000 / 60; renderTime = time;
  requestAnimationFrame(render); background(time);
  if (cameraActive()) {
    drawCamera(); requestFrame(time);
    if (lastResult && time - lastResult > 900) {
      lastResult = 0; faces = []; hands = [];
      if (source === 'camera') { caster = null; receiver = solo ? sampleFace('right') : null; cancelHold(); roleSince = 0; if (phase === 'ready') phase = 'waiting'; }
      updateTrackingStatus();
    }
    if (source === 'mouse-camera') mouseCameraRoles();
    if (solo && !carving) person(sampleFace('right'), false, time);
  } else { const roles = sampleRoles(); caster = roles.caster; receiver = roles.receiver; }
  if (carving) {
    drawWorkshopScene(c, { width: W, height: H, camera: cameraActive() }); drawPumpkin(carvingPose());
    if (source === 'camera') { const done = carvingDonePoint(); handCursor(controlHand, pinched); dwellButton(done.x, done.y, 'できた', time); }
    updateCue(); return;
  }
  let pose;
  if (source === 'guide') {
    const t = ((time - guideStart) % 12000) / 1000, rest = restPose(time), target = currentTarget(), direction = swapped ? -1 : 1;
    let demoHand = { x: rest.x - direction * 50, y: rest.y + 60 };
    if (t < 3) {
      const p = clamp(t / 2, 0, 1); demoHand = { x: rest.x - direction * 50 * (1 - p), y: rest.y + 60 * (1 - p) }; pose = rest;
      cue('お手本 / 01', 'カボチャを、つかもう。', 'カメラに映る自分の手で、ぎゅっとつかむ。');
    } else if (t < 5.2) {
      const p = (t - 3) / 2.2; demoHand = { x: rest.x + direction * (p * p * 180 - Math.sin(p * Math.PI) * 50), y: rest.y - p * 105 }; pose = { ...rest, ...demoHand };
      cue('お手本 / 02', '相手へ振って、パッとはなす！', '手を開くと、カボチャが画面の中を飛んでいく。');
    } else if (t < 6.5) {
      pose = flightPose({ ...rest, x: rest.x + direction * 180, y: rest.y - 105 }, target, (t - 5.2) / 1.3);
      demoHand = { x: rest.x + direction * 100, y: rest.y - 80 };
      cue('お手本 / 02', 'いっけー！', 'カボチャが、相手の頭へ。');
    } else {
      pose = target; cue('お手本 / 03', 'スポッ！ 友だちがカボチャに。', 'これを、スクリーンに映る自分たちで遊びます。');
    }
    person(caster, true, time, demoHand); person(receiver, false, time);
    rolePill(caster.x, 661, '① 投げる人', colors.orange); rolePill(receiver.x, 661, '② かぶる人', colors.violet);
  } else {
    if (source === 'mouse') { person(caster, true, time, phase === 'held' ? heldPose : null); person(receiver, false, time); }
    if (source === 'camera' && phase === 'waiting') zones();
    if (cameraActive() && receiver && !receiver.sample && (phase === 'ready' || phase === 'held')) {
      const head = faceCoverRegion(receiver, { scale: (Number($('face-fit-scale').value) || 100) / 100, shape });
      c.save(); c.setLineDash([7, 8]); c.lineWidth = 2; c.strokeStyle = colors.violet;
      c.beginPath(); c.ellipse(head.x, head.y, head.w / 2, head.h / 2, head.roll, 0, Math.PI * 2); c.stroke(); c.restore();
      text(receiver.manual ? 'ここにかぶせる · 位置固定' : '髪・耳まで覆うサイズに', head.x, head.y + head.h * .55 + 22, 14, colors.violet, 700);
    }
    if (phase === 'ready' || phase === 'held') pose = phase === 'held' ? heldPose : restPose(time);
    if (phase === 'flying' && flight) {
      const progress = (time - flight.since) / 1100;
      const target = currentTarget();
      if (target) flight.target = target;
      pose = flightPose(flight.start, flight.target, progress);
      if (progress >= 1) { phase = 'worn'; wornSince = time; smoothTarget = target; $('restart').hidden = false; tone('land'); }
    }
    if (phase === 'worn') {
      const target = currentTarget();
      if (target) {
        smoothTarget = smoothFacePose(smoothTarget, target, elapsed, blendOrientation);
        pose = smoothTarget; burst(pose, time);
      } else { pose = null; smoothTarget = null; }
      updateThrowResult(time);
      if (source === 'camera' && $('throw-result').hidden) dwellButton(640, 625, 'もう一度', time);
    }
    const roles = sampleRoles();
    if (mouseControl() || phase !== 'waiting') {
      rolePill(roles.caster.x, 661, '① 投げる人', colors.orange);
      rolePill(roles.receiver.x, 661, solo ? '② 練習用の相手' : '② かぶる人', colors.violet);
    }
    updateCue();
  }
  if (pose && phase !== 'worn') {
    c.save(); c.globalAlpha = .22; c.fillStyle = '#080611'; c.beginPath(); c.ellipse(pose.x, 591, pose.w * .3, 13, 0, 0, Math.PI * 2); c.fill(); c.restore();
  }
  drawPumpkin(pose);
  if (source === 'camera') handCursor(controlHand, gripped);
  if (mouseControl() && phase === 'ready') { text('つかんで →', restPose(time).x, restPose(time).y - 127, 17, colors.orange, 700); }
}

$('play-pair').onclick = () => { if (carving) finishCarving(); startCamera(false); };
$('play-solo').onclick = () => { if (carving) finishCarving(); startCamera(true); };
$('guide').onclick = () => { if (carving) finishCarving(); startSample('guide'); };
$('mouse').onclick = () => { if (carving) finishCarving(); startCamera(false, 'mouse'); };
$('mouse-sample').onclick = () => { if (carving) finishCarving(); startSample('mouse'); };
$('target-auto').onclick = () => { manualTarget = mouseTrackedFace = null; mouseCameraRoles(); updateCameraLabels(); updateTrackingStatus(); };
$('face-fit-scale').oninput = () => { $('face-fit-value').textContent = `${$('face-fit-scale').value}%`; };
$('face-fit-reset').onclick = () => { $('face-fit-scale').value = '100'; $('face-fit-value').textContent = '100%'; };
$('stop-camera').onclick = $('cancel-camera').onclick = () => { if (carving) finishCarving(); startSample('mouse'); };
$('restart').onclick = resetRound;
$('retry-throw').onclick = () => { resetRound(); updateCue(); $('theater').scrollIntoView({ block: 'start' }); };
$('edit-result').onclick = () => { openCarving(); updateCue(); $('theater').scrollIntoView({ block: 'start' }); };
$('customize').onclick = openCarving; $('finish-carving').onclick = finishCarving;
$('undo').onclick = () => { art.undo(); updateCarvingTools(); queueDraft(); };
$('redo').onclick = () => { art.redo(); updateCarvingTools(); queueDraft(); };
$('clear').onclick = () => { art.clear(); updateCarvingTools(); queueDraft(); };
$('template').onclick = () => { art.template(); updateCarvingTools(); queueDraft(); };
$('gallery-link').href = GALLERY_URL;
$('save-artwork').onclick = () => { try { downloadArtwork(); } catch (error) { notice(error.message); } };
$('exhibit-artwork').onclick = () => {
  try {
    art.cancel(); saveDraft();
    const artwork = artworkData();
    if (artwork.mask.length > MAX_GALLERY_MASK_LENGTH) {
      notice('この作品は細かいため、そのままでは展示できません。「もう少し彫り直す」から「作品ファイルを保存」で残すか、模様を少し減らして、もう一度試してください。', 12000);
      return;
    }
    const data = JSON.stringify(artwork);
    if (data.length > 45000) {
      downloadArtwork(); window.open(`${GALLERY_URL}?submit=1`, '_blank', 'noopener');
      notice('作品ファイルを保存しました。展示室でこのファイルを選んでください。', 8000);
    } else window.open(`${GALLERY_URL}?submit=1#draft=${encodeURIComponent(data)}`, '_blank', 'noopener');
  } catch (error) { notice(error.message); }
};
document.querySelectorAll('[data-carve-mode]').forEach(button => button.onclick = () => { art.configure({ mode: button.dataset.carveMode }); updateCarvingTools(); });
$('smoothing').onchange = () => { art.configure({ smoothing: Number($('smoothing').value) }); updateCarvingTools(); };
$('brush').oninput = () => art.configure({ size: Number($('brush').value) });
document.querySelectorAll('[data-shape]').forEach(button => button.onclick = () => { art.cancel(); shape = button.dataset.shape; document.querySelectorAll('[data-shape]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); queueDraft(); });
function toggleSettings(open) { $('settings').hidden = !open; $('settings-button').setAttribute('aria-expanded', String(open)); }
$('settings-button').onclick = () => { toggleSettings($('settings').hidden); if (!$('settings').hidden) refreshCameraList(); }; $('close-settings').onclick = () => toggleSettings(false);
$('switch-camera').onclick = () => { toggleSettings(false); startCamera(solo, source === 'mouse-camera' ? 'mouse' : 'hand', false); };
$('mirror').onchange = () => { faces = []; hands = []; caster = receiver = manualTarget = null; resetRound(); if (cameraActive()) updateCameraLabels(); };
$('swap').onclick = () => { if (solo) { notice('ひとり練習では左に立って遊びます'); return; } swapped = !swapped; manualTarget = null; resetRound(); notice(`投げる人は${swapped ? '右' : '左'}、かぶる人は${swapped ? '左' : '右'}です`); };
$('assist').onclick = () => {
  if (carving) finishCarving();
  if (source === 'guide') { startSample('mouse'); const roles = sampleRoles(); caster = roles.caster; receiver = roles.receiver; }
  if (!receiver || source === 'camera' && !caster) { notice('投げる人とかぶる人を、左右に映してください'); return; }
  if (phase === 'flying') return;
  toggleSettings(false); launch(heldPose || restPose(), currentTarget());
};
$('setup-button').onclick = () => $('setup-dialog').showModal();
$('close-setup').onclick = $('understood').onclick = () => $('setup-dialog').close();
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('exhibit').requestFullscreen) await $('exhibit').requestFullscreen(); else notice('このブラウザーでは全画面表示に対応していません'); }
  catch { notice('全画面にできませんでした。ブラウザーの全画面操作をお試しください。'); }
};
restoreDraft(); openCarving();
document.addEventListener('visibilitychange', () => { if (document.hidden) { art.cancel(); saveDraft(); } });
requestAnimationFrame(time => {
  try {
    render(time);
    window.dispatchEvent(new Event('pumpkin-ready'));
  } catch (error) {
    window.dispatchEvent(new CustomEvent('pumpkin-startup-error', { detail: { error } }));
    throw error;
  }
});
