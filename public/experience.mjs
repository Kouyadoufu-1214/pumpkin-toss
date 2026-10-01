import { clamp, distance, isPinched } from './interaction.mjs';
import { resolveRoles, chooseControlHand, handGrip, TossGesture, DwellAction, flightPose } from './exhibit-logic.mjs';
import { Pumpkin3D, faceQuaternion, blendOrientation } from './pumpkin-3d.mjs';
import { PumpkinArt } from './pumpkin-art.mjs';

const $ = id => document.getElementById(id);
const canvas = $('screen'), c = canvas.getContext('2d'), video = $('camera-video');
const W = 1280, H = 720, art = new PumpkinArt(), toss = new TossGesture(), dwell = new DwellAction();
let pumpkin;
try { pumpkin = new Pumpkin3D(art.canvas, W, H); $('renderer-status').textContent = '3D PUMPKIN'; }
catch (error) { $('renderer-status').textContent = '簡易表示'; console.warn('3D renderer unavailable', error); }
let source = 'guide', solo = false, swapped = false, phase = 'ready', carving = false, shape = 'round';
let guideStart = performance.now(), heldPose = null, flight = null, wornSince = 0, roleSince = 0;
let caster = null, receiver = null, controlHand = null, gripped = false, pinched = false;
let lastResult = 0, faces = [], hands = [], smoothTarget = null, pointer = null, messageTimer, lastCue = '';
let session = 0, stream = null, worker = null, workerReady = false, processing = false, lastFrame = 0, lastVideoTime = -1, loading = false, initTimer, requestReject;
let audioContext;
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
function resetRound() {
  phase = source === 'camera' ? 'waiting' : 'ready'; toss.cancel(); heldPose = flight = smoothTarget = null;
  controlHand = null; gripped = pinched = false; dwell.reset(); art.end(); pointer = null; roleSince = 0;
  $('restart').hidden = true;
}
function cancelHold(message) {
  if (phase === 'held') { toss.cancel(); heldPose = null; phase = 'ready'; if (message) notice(message); }
  gripped = false; controlHand = null; art.end(); pinched = false;
}
function restPose(time = performance.now()) {
  const person = caster || sampleRoles().caster;
  const side = person.x > W / 2 ? -1 : 1;
  const [sx, sy] = shapeScale();
  return { x: clamp(person.x + side * Math.max(115, person.w), 175, W - 175), y: clamp(person.y + person.h * .85, 350, 555) + Math.sin(time / 650) * 5, w: 240 * sx, h: 215 * sy, yaw: Math.sin(time / 1400) * .08 };
}
function targetPose(face) {
  if (!face) return null;
  const [sx, sy] = shapeScale();
  return { x: face.x, y: face.y - face.h * .05, w: clamp(face.w * 2.35, 150, 400) * sx, h: clamp(face.h * 1.55, 170, 440) * sy, quaternion: face.quaternion, yaw: face.sample ? Math.sin(performance.now() / 1100) * .12 : 0 };
}
function currentTarget() { return targetPose(receiver); }
function launch(from, target) {
  if (!target) { cancelHold(); notice('かぶる人の顔が映ってから投げよう'); return; }
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
function stopCamera() {
  session++; clearTimeout(initTimer); requestReject?.(new Error('cancelled')); requestReject = null;
  worker?.terminate(); worker = null; workerReady = processing = loading = false;
  stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null;
  faces = []; hands = []; lastResult = 0; caster = receiver = null; cancelHold();
  $('loading').hidden = true; $('stop-camera').hidden = true;
  $('play-pair').disabled = $('play-solo').disabled = false; $('tracking-status').textContent = 'カメラは停止中';
}
async function startCamera(practice = false) {
  stopCamera(); const id = session; solo = practice; if (solo) swapped = false;
  source = 'camera'; resetRound(); loading = true; $('loading').hidden = false; $('stop-camera').hidden = false;
  $('play-pair').disabled = $('play-solo').disabled = true;
  $('source-badge').textContent = solo ? '● カメラ / ひとりで練習' : '● カメラ / 2人プレイ';
  $('stage-note').textContent = solo ? '左に映って遊ぼう。右の相手は練習用です。' : '顔と手が映る距離で、左右に分かれて立とう';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザーではカメラが使えません。localhostまたはHTTPSで開いてください。');
    initTimer = setTimeout(() => { if (id === session) { startSample('mouse'); notice('準備が完了しませんでした。カメラの許可と接続を確認して、もう一度お試しください。', 8000); } }, 60000);
    const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: $('facing').value } } });
    if (id !== session) { media.getTracks().forEach(track => track.stop()); return; }
    stream = media; video.srcObject = media; await video.play();
    if (id !== session) return;
    worker = new Worker('./tracker-worker.js');
    await new Promise((resolve, reject) => {
      requestReject = reject;
      worker.onerror = () => {
        if (id !== session) return;
        if (!workerReady) reject(new Error('検出モデルを読み込めませんでした。再起動してください。'));
        else { startSample('mouse'); notice('検出が止まりました。カメラを再開してください。', 6000); }
      };
      worker.onmessage = ({ data }) => {
        if (id !== session) return;
        if (data.type === 'ready') { workerReady = true; requestReject = null; resolve(); }
        else if (data.type === 'result') { processing = false; acceptTracking(data); }
        else if (data.type === 'error') {
          processing = false;
          if (!workerReady) reject(new Error(data.message));
          else { startSample('mouse'); notice('検出が止まりました。カメラを再開してください。', 6000); }
        }
      };
      worker.postMessage({ type: 'init' });
    });
    if (id !== session) return;
    clearTimeout(initTimer); loading = false; $('loading').hidden = true;
    $('play-pair').disabled = $('play-solo').disabled = false; lastFrame = 0; lastVideoTime = -1;
    stream.getVideoTracks()[0].onended = () => { if (id === session) { startSample('mouse'); notice('カメラが切断されました。接続して再開してください。'); } };
  } catch (error) {
    if (id !== session) return;
    startSample('mouse');
    const reasons = { NotAllowedError: 'カメラが許可されていません。ブラウザーのカメラ許可を確認してください。', NotFoundError: 'カメラが見つかりません。接続を確認してください。', NotReadableError: 'カメラを開けません。他のカメラアプリを閉じて、もう一度お試しください。' };
    notice(reasons[error.name] || `準備できませんでした：${error.message}`, 8000);
  }
}
async function requestFrame(time) {
  if (!workerReady || processing || video.readyState < 2 || document.hidden || time - lastFrame < 80 || video.currentTime === lastVideoTime) return;
  const id = session; processing = true; lastFrame = time; lastVideoTime = video.currentTime;
  try {
    const scale = Math.min(640 / video.videoWidth, 640 / video.videoHeight, 1);
    const bitmap = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale) });
    if (id !== session || !worker) { bitmap.close(); return; }
    worker.postMessage({ type: 'frame', bitmap, time }, [bitmap]);
  } catch { if (id === session) processing = false; }
}
function acceptTracking(data) {
  const time = performance.now(), elapsed = lastResult ? time - lastResult : 0; lastResult = time;
  faces = data.faces.map((points, index) => {
    const a = screenPoint(points[234]), b = screenPoint(points[454]), top = screenPoint(points[10]), bottom = screenPoint(points[152]);
    return { x: (a.x + b.x) / 2, y: (top.y + bottom.y) / 2, w: distance(a, b), h: distance(top, bottom), quaternion: faceQuaternion(data.matrices?.[index], $('mirror').checked) };
  });
  const roles = resolveRoles(faces, roleOptions()); caster = roles.caster; receiver = solo ? sampleFace('right') : roles.receiver;
  hands = data.hands.map((points, index) => {
    const mapped = points.map(screenPoint), palm = { x: (mapped[0].x + mapped[5].x + mapped[17].x) / 3, y: (mapped[0].y + mapped[5].y + mapped[17].y) / 3 };
    return { points: mapped, wrist: mapped[0], palm, label: data.handedness?.[index]?.[0]?.categoryName };
  });
  $('tracking-status').textContent = `顔 ${faces.length}人 / 手 ${hands.length}本 / 検出 ${elapsed ? Math.round(1000 / elapsed) : '—'}回/秒`;
  if (caster && receiver) {
    roleSince ||= time;
    if (phase === 'waiting' && time - roleSince > 400) phase = 'ready';
  } else {
    roleSince = 0;
    if (phase === 'held') cancelHold('2人の顔が映ってから、もう一度つかもう');
    if (phase === 'ready') phase = 'waiting';
  }
  const previous = controlHand;
  controlHand = chooseControlHand(hands, previous, roleOptions());
  if (!controlHand) { cancelHold(previous && phase === 'held' ? '手を見失いました。カボチャをもう一度つかもう' : null); dwell.reset(); return; }
  if (carving) {
    const pinch = isPinched(controlHand.points, pinched);
    if (pinch) carveAt(controlHand.points[8]); else art.end();
    pinched = pinch;
    if (dwell.update(!pinch && distance(controlHand.palm, carvingDonePoint()) < 70, time)) finishCarving();
    return;
  }
  if (phase === 'worn') {
    if (dwell.update(distance(controlHand.palm, { x: 640, y: 625 }) < 60, time)) resetRound();
    return;
  }
  const grip = handGrip(controlHand.points, gripped), point = controlHand.palm;
  if (phase === 'ready' && grip && !gripped && distance(point, restPose(time)) < 140) {
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
}

function openCarving() {
  if (source === 'guide') startSample('mouse');
  resetRound(); carving = true; $('exhibit').classList.add('carving'); $('workshop').hidden = false;
  $('stage-note').textContent = 'カボチャの表面をなぞって、目や口をほろう';
}
function finishCarving() {
  carving = false; $('exhibit').classList.remove('carving'); $('workshop').hidden = true; resetRound();
  $('stage-note').textContent = source === 'camera' ? '作ったカボチャを、つかんで投げよう' : '作ったカボチャをドラッグして、相手へはなす';
}
const carvingPose = () => { const [sx, sy] = shapeScale(); return { x: 640, y: 422, w: 530 * sx, h: 480 * sy }; };
function carveAt(point) {
  const pose = carvingPose();
  const hit = pumpkin ? pumpkin.hit(point, pose, true) : { x: (point.x - pose.x) / pose.w * 512 + 256, y: (point.y - pose.y) / pose.h * 512 + 256 };
  art.stroke(hit, Number($('brush').value));
}
function pointerPoint(event) {
  const box = canvas.getBoundingClientRect();
  const scale = getComputedStyle(canvas).objectFit === 'cover' ? Math.max(box.width / W, box.height / H) : Math.min(box.width / W, box.height / H);
  return { x: (event.clientX - box.left - (box.width - W * scale) / 2) / scale, y: (event.clientY - box.top - (box.height - H * scale) / 2) / scale };
}
canvas.addEventListener('pointerdown', event => {
  if (loading) return;
  const point = pointerPoint(event);
  if (carving) { pointer = event.pointerId; canvas.setPointerCapture(pointer); carveAt(point); return; }
  if (source === 'guide') return;
  if (phase === 'worn' && distance(point, { x: 640, y: 625 }) < 70) { resetRound(); return; }
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
  if (carving) { art.end(); return; }
  if (phase !== 'held') return;
  const from = { ...heldPose }, target = currentTarget();
  const result = toss.release(pointerPoint(event), performance.now(), target);
  if (result.ok) launch(from, target);
  else { cancelHold(); notice('相手の方向へ、シュッと動かしてはなそう'); }
});
canvas.addEventListener('pointercancel', () => { pointer = null; cancelHold(); });
window.addEventListener('blur', () => { pointer = null; cancelHold(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelHold(); lastResult = 0; } });
window.addEventListener('pagehide', stopCamera);

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
  if (!pose) return;
  if (pumpkin) { if (art.changed) { pumpkin.updateMask(); art.changed = false; } pumpkin.draw(c, pose); return; }
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
  if (carving) { cue('MAKE YOUR PUMPKIN', 'どんな顔にする？', '指先でつまんで動かすと、光がもれる穴になる。'); return; }
  if (source === 'guide') return;
  if (phase === 'waiting') cue('GET READY', solo ? '左に映って、手を見せよう' : '2人で、左右の枠に入ろう', solo ? '右のお手本の相手に投げてみよう。' : 'オレンジが投げる人。むらさきがかぶる人。');
  if (phase === 'ready') cue('01 / つかむ', 'カボチャを、つかもう。', source === 'mouse' ? 'カボチャをマウスでつかんで、相手のほうへ。' : '画面のカボチャに手を重ねて、にぎる。つまんでもOK。');
  if (phase === 'held') cue('02 / 投げる', '相手へ振って、パッとはなす！', source === 'mouse' ? '少し大きく動かして、マウスをはなそう。' : '相手の方向へ手を動かしながら、手を開こう。');
  if (phase === 'flying') cue('02 / 投げる', 'いっけー！', 'カボチャが、相手の頭へ。');
  if (phase === 'worn') cue('03 / かぶる', receiver ? 'スポッ！ お似合い！' : 'かぶる人は、同じ側へ戻ってね', receiver ? '顔を動かすと、カボチャもついてくる。' : '顔が映ったら、カボチャが戻ります。');
}

function render(time) {
  requestAnimationFrame(render); background(time);
  if (source === 'camera') {
    drawCamera(); requestFrame(time);
    if (lastResult && time - lastResult > 650) { lastResult = 0; faces = []; hands = []; caster = null; receiver = solo ? sampleFace('right') : null; cancelHold(); roleSince = 0; if (phase === 'ready') phase = 'waiting'; }
    if (solo && !carving) person(sampleFace('right'), false, time);
  } else { const roles = sampleRoles(); caster = roles.caster; receiver = roles.receiver; }
  if (carving) {
    c.fillStyle = '#17111ca8'; c.fillRect(0, 0, W, H); drawPumpkin(carvingPose());
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
        if (!smoothTarget) smoothTarget = { ...target };
        for (const key of ['x', 'y', 'w', 'h']) smoothTarget[key] += (target[key] - smoothTarget[key]) * .25;
        smoothTarget.quaternion = blendOrientation(smoothTarget.quaternion, target.quaternion, .25); smoothTarget.yaw = target.yaw;
        pose = smoothTarget; burst(pose, time);
      } else { pose = null; smoothTarget = null; }
      if (source === 'camera') dwellButton(640, 625, 'もう一度', time);
    }
    const roles = sampleRoles();
    if (source === 'mouse' || phase !== 'waiting') {
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
  if (source === 'mouse' && phase === 'ready') { text('つかんで →', restPose(time).x, restPose(time).y - 127, 17, colors.orange, 700); }
}

$('play-pair').onclick = () => { if (carving) finishCarving(); startCamera(false); };
$('play-solo').onclick = () => { if (carving) finishCarving(); startCamera(true); };
$('guide').onclick = () => { if (carving) finishCarving(); startSample('guide'); };
$('mouse').onclick = () => { if (carving) finishCarving(); startSample('mouse'); };
$('stop-camera').onclick = $('cancel-camera').onclick = () => { if (carving) finishCarving(); startSample('mouse'); };
$('restart').onclick = resetRound;
$('customize').onclick = openCarving; $('finish-carving').onclick = finishCarving;
$('undo').onclick = () => art.undo(); $('clear').onclick = () => art.clear(); $('template').onclick = () => art.template();
document.querySelectorAll('[data-shape]').forEach(button => button.onclick = () => { shape = button.dataset.shape; document.querySelectorAll('[data-shape]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); });
function toggleSettings(open) { $('settings').hidden = !open; $('settings-button').setAttribute('aria-expanded', String(open)); }
$('settings-button').onclick = () => toggleSettings($('settings').hidden); $('close-settings').onclick = () => toggleSettings(false);
$('switch-camera').onclick = () => { toggleSettings(false); startCamera(solo); };
$('mirror').onchange = () => { faces = []; caster = receiver = null; resetRound(); };
$('swap').onclick = () => { if (solo) { notice('ひとり練習では左に立って遊びます'); return; } swapped = !swapped; resetRound(); notice(`投げる人は${swapped ? '右' : '左'}、かぶる人は${swapped ? '左' : '右'}です`); };
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
startSample('guide'); requestAnimationFrame(render);
