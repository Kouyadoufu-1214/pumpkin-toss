import { GrabGesture, isPinched, chooseFace, distance, clamp } from './interaction.mjs';

const $ = id => document.getElementById(id);
const canvas = $('stage'), ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const video = $('video');
const mask = document.createElement('canvas'); mask.width = mask.height = 512;
const ink = mask.getContext('2d', { willReadFrequently: true });
const texture = document.createElement('canvas'); texture.width = texture.height = 512;
const glow = document.createElement('canvas'); glow.width = glow.height = 512;
const tex = texture.getContext('2d'), light = glow.getContext('2d');
const gesture = new GrabGesture();
const state = {
  mode: 'carve', shape: 'round', brush: 24, camera: false, loading: false,
  worker: null, ready: false, busy: false, lastFrame: 0, lastVideo: -1, session: 0,
  faces: [], target: null, hand: null, pinched: false, handTime: 0,
  stroke: null, undo: [], dirty: true, particles: [], flight: null,
  pumpkin: null, dwell: 0, sound: false, audio: null, lastSound: 0,
  pointerDown: false, grabSource: null, inferTimes: [],
  viewYaw: -Math.PI / 12, spin: false, handSize: 0, grabSize: 0,
};
const shapeScale = { round: [1, 1], tall: [0.85, 1.12], wide: [1.16, 0.88] };
const defaultPumpkin = () => state.mode === 'carve' ? { x: 363, y: 339, w: 415, h: 415 } : { x: 295, y: 468, w: 245, h: 245 };
const doneZone = { x: 735, y: 99, w: 256, h: 66 };
let pumpkin3d = null, threeHelpers = null;

function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function beep(freq = 260, length = 0.05, volume = 0.025) {
  if (!state.sound) return;
  try {
    state.audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (state.audio.state === 'suspended') state.audio.resume();
    const osc = state.audio.createOscillator(), amp = state.audio.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, state.audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.65, state.audio.currentTime + length);
    amp.gain.setValueAtTime(volume, state.audio.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.001, state.audio.currentTime + length);
    osc.connect(amp); amp.connect(state.audio.destination); osc.start(); osc.stop(state.audio.currentTime + length);
  } catch {}
}
function setMode(mode) {
  endStroke(); gesture.reset(); state.grabSource = null;
  state.mode = mode; state.pumpkin = defaultPumpkin(); state.dwell = 0;
  document.querySelectorAll('[data-step]').forEach(el => el.classList.toggle('active', el.dataset.step === mode));
  const copy = {
    carve: ['01 / CARVE', 'きみだけの顔を、彫ってみよう。', 'できた！ 投げる →'],
    throw: ['02 / THROW', 'つかんで、振って、パッとはなそう。', '投げる！ ↗'],
    flying: ['02 / THROW', 'カボチャが飛んでいく！', 'とんでいます…'],
    worn: ['03 / WEAR', 'お似合い！ きみだけのカボチャ。', 'もう一度つくる ↶'],
  }[mode];
  $('mode-label').textContent = copy[0]; $('action-title').textContent = copy[1]; $('next').textContent = copy[2];
  $('next').disabled = mode === 'flying';
  if (mode !== 'carve') setSpin(false);
  document.querySelectorAll('[data-shape], #brush, #undo, #clear, #template, #rotation, #front, #spin').forEach(el => el.disabled = mode !== 'carve');
  if (!pumpkin3d) document.querySelectorAll('#rotation, #front, #spin').forEach(el => el.disabled = true);
  $('receiver').disabled = mode === 'flying' || mode === 'worn';
  updateInstructions();
}
function updateInstructions() {
  const live = state.camera;
  const lines = {
    carve: live ? ['親指と人差し指をつまんでなぞると削れます。', '「できた」に指を1秒ほど置くと、投げる準備ができます。'] : ['カボチャをドラッグして、自由に削ってみよう。', 'マウスでなぞると、内側の光が見えてきます。'],
    throw: live ? ['カボチャの上で指をつまむ → 手を振って、指を開く。', 'かぶる人は顔をカメラへ。下のボタンでも投げられます。'] : ['カボチャをつかんで、サッと動かしてはなそう。', '下のボタンでも投げられます。カメラなしでは人形にかぶせます。'],
    flying: ['そーれっ！', '相手の頭に向かって、カボチャが飛んでいきます。'],
    worn: live ? ['顔を左右・上下に向けてみよう。立体のカボチャも回ります。', '次の人は「もう一度つくる」。描いた顔はそのまま残ります。'] : ['完成！ カメラを使うと、この立体のカボチャをかぶれます。', '「もう一度つくる」で、顔を描き直せます。'],
  }[state.mode];
  $('stage-instruction').textContent = lines[0]; $('action-hint').textContent = lines[1];
}
function pushUndo() {
  state.undo.push(ink.getImageData(0, 0, 512, 512));
  if (state.undo.length > 20) state.undo.shift();
}
function endStroke() { state.stroke = null; }
function pumpkinDimensions(p = state.pumpkin || defaultPumpkin()) {
  const [sx, sy] = shapeScale[state.shape]; return { ...p, w: p.w * sx, h: p.h * sy };
}
function pumpkinPose(p = state.pumpkin, angle = 0) {
  return {
    ...pumpkinDimensions(p), roll: angle,
    yaw: p.yaw ?? (state.mode === 'carve' ? state.viewYaw : -.12),
    pitch: p.pitch ?? (state.mode === 'carve' ? .04 : -.04),
  };
}
function localPoint(point) {
  const p = pumpkinDimensions();
  return { x: (point.x - p.x) / p.w * 512 + 256, y: (point.y - p.y) / p.h * 512 + 256 };
}
function inBody(point) { return ((point.x - 256) / 204) ** 2 + ((point.y - 288) / 191) ** 2 < 1; }
function overPumpkin(point) { return pumpkin3d ? !!pumpkin3d.hit(point, pumpkinPose()) : inBody(localPoint(point)); }
function carve(point, source) {
  if (state.spin) { endStroke(); return; }
  const local = pumpkin3d ? pumpkin3d.hit(point, pumpkinPose(), true) : localPoint(point);
  if (!local || (!pumpkin3d && !inBody(local))) { endStroke(); return; }
  if (!state.stroke || state.stroke.source !== source) {
    pushUndo(); state.stroke = { ...local, source };
  }
  ink.strokeStyle = 'white'; ink.fillStyle = 'white'; ink.lineCap = 'round'; ink.lineJoin = 'round'; ink.lineWidth = state.brush;
  ink.beginPath(); ink.moveTo(state.stroke.x, state.stroke.y); ink.lineTo(local.x, local.y); ink.stroke();
  ink.beginPath(); ink.arc(local.x, local.y, state.brush / 2, 0, Math.PI * 2); ink.fill();
  state.stroke = { ...local, source }; state.dirty = true;
  if (Math.random() > 0.4) state.particles.push({ x: point.x, y: point.y, vx: (Math.random() - .5) * 150, vy: -90 - Math.random() * 110, life: 0.65, color: '#ed8b34', size: 3 + Math.random() * 5 });
  if (performance.now() - state.lastSound > 90) { beep(180 + Math.random() * 120); state.lastSound = performance.now(); }
}
function applyTemplate() {
  pushUndo(); ink.clearRect(0, 0, 512, 512); ink.fillStyle = 'white';
  const poly = points => { ink.beginPath(); points.forEach(([x, y], i) => i ? ink.lineTo(x, y) : ink.moveTo(x, y)); ink.closePath(); ink.fill(); };
  poly([[123, 245], [196, 191], [214, 259]]); poly([[298, 259], [316, 191], [389, 245]]);
  poly([[256, 260], [230, 302], [279, 302]]);
  poly([[136, 327], [190, 350], [218, 339], [242, 361], [270, 344], [297, 358], [327, 339], [376, 319], [345, 381], [299, 405], [247, 414], [195, 397], [156, 369]]);
  state.dirty = true;
}
function bodyPath(c) { c.beginPath(); c.ellipse(256, 286, 209, 193, 0, 0, Math.PI * 2); }
function renderTexture() {
  if (!state.dirty) return; state.dirty = false;
  if (pumpkin3d) { pumpkin3d.updateMask(); return; }
  tex.clearRect(0, 0, 512, 512);
  tex.save();
  tex.beginPath(); tex.moveTo(232, 118); tex.bezierCurveTo(233, 82, 247, 59, 275, 54); tex.lineTo(292, 77); tex.bezierCurveTo(261, 81, 258, 108, 262, 124); tex.closePath();
  const stem = tex.createLinearGradient(230, 60, 281, 128); stem.addColorStop(0, '#71844a'); stem.addColorStop(1, '#34482a'); tex.fillStyle = stem; tex.fill();
  tex.strokeStyle = '#9aa466'; tex.lineWidth = 3; tex.beginPath(); tex.moveTo(246, 110); tex.quadraticCurveTo(248, 80, 274, 71); tex.stroke();
  bodyPath(tex); tex.clip();
  const base = tex.createRadialGradient(200, 194, 10, 250, 284, 249); base.addColorStop(0, '#ffc063'); base.addColorStop(.55, '#ec7e24'); base.addColorStop(1, '#8b371a'); tex.fillStyle = base; tex.fillRect(0, 0, 512, 512);
  for (const [cx, rx, darkness] of [[138, 76, .14], [209, 88, .12], [303, 88, .10], [373, 76, .16]]) {
    const rib = tex.createLinearGradient(cx - rx, 0, cx + rx, 0); rib.addColorStop(0, `rgba(105,38,9,${darkness})`); rib.addColorStop(.28, 'rgba(255,205,110,.16)'); rib.addColorStop(.7, 'rgba(255,191,80,.03)'); rib.addColorStop(1, `rgba(88,25,4,${darkness + .1})`);
    tex.fillStyle = rib; tex.beginPath(); tex.ellipse(cx, 286, rx, 199, 0, 0, Math.PI * 2); tex.fill();
  }
  tex.strokeStyle = '#ffda9a35'; tex.lineWidth = 3; tex.beginPath(); tex.ellipse(256, 287, 101, 189, 0, 0, Math.PI * 2); tex.stroke();
  light.clearRect(0, 0, 512, 512); light.globalCompositeOperation = 'source-over'; light.drawImage(mask, 0, 0);
  light.globalCompositeOperation = 'source-in';
  const shine = light.createLinearGradient(0, 190, 0, 430); shine.addColorStop(0, '#fff5b8'); shine.addColorStop(.55, '#ffdb6a'); shine.addColorStop(1, '#ffb43e'); light.fillStyle = shine; light.fillRect(0, 0, 512, 512);
  light.globalCompositeOperation = 'source-over';
  tex.shadowColor = '#703408'; tex.shadowOffsetY = -4; tex.shadowBlur = 2; tex.drawImage(glow, 0, 0);
  tex.shadowOffsetY = 0; tex.shadowColor = '#ffe774'; tex.shadowBlur = 10; tex.globalAlpha = .25; tex.drawImage(glow, 0, 0);
  tex.restore();
}
function drawPumpkin(p, angle = 0, opacity = 1) {
  if (pumpkin3d) { pumpkin3d.draw(ctx, pumpkinPose(p, angle)); return; }
  const dims = pumpkinDimensions(p); ctx.save(); ctx.translate(dims.x, dims.y); ctx.rotate(angle); ctx.globalAlpha = opacity;
  ctx.shadowColor = '#0006'; ctx.shadowBlur = 25; ctx.shadowOffsetY = 16;
  ctx.drawImage(texture, -dims.w / 2, -dims.h / 2, dims.w, dims.h); ctx.restore();
}
function roundedRect(x, y, w, h, radius, fill, stroke) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function label(text, x, y, size = 18, color = '#f6eadc', align = 'center') {
  ctx.font = `500 ${size}px "Yu Gothic UI", Meiryo, sans-serif`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
}
function drawDemo(time) {
  const bg = ctx.createRadialGradient(350, 280, 20, 530, 320, 680); bg.addColorStop(0, '#433042'); bg.addColorStop(.55, '#2d2437'); bg.addColorStop(1, '#1a182b'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.strokeStyle = '#ad8aaf0c'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 56) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 56) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  for (let i = 0; i < 22; i++) {
    const x = (i * 139 + 35) % W, y = (i * 83 + 43) % 590;
    const a = .12 + .1 * Math.sin(time / 1300 + i);
    ctx.fillStyle = `rgba(255,214,142,${a})`; ctx.beginPath(); ctx.arc(x, y, i % 4 === 0 ? 2 : 1, 0, Math.PI * 2); ctx.fill();
  }
  const target = demoFace(time);
  ctx.save(); ctx.translate(target.x, target.y);
  ctx.fillStyle = '#615572'; ctx.beginPath(); ctx.ellipse(0, 230, 111, 135, 0, Math.PI, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#d1b298'; ctx.fillRect(-18, 61, 36, 55);
  ctx.fillStyle = '#e7cbb1'; ctx.beginPath(); ctx.ellipse(0, 0, 56, 75, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#362b3b'; ctx.beginPath(); ctx.ellipse(-4, -41, 59, 36, -.1, Math.PI, 2.5 * Math.PI); ctx.fill();
  ctx.fillStyle = '#665253'; ctx.beginPath(); ctx.arc(-19, 7, 3, 0, 7); ctx.arc(19, 7, 3, 0, 7); ctx.fill();
  ctx.strokeStyle = '#a47566'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 28, 12, .3, Math.PI - .3); ctx.stroke();
  ctx.restore();
  label('おためしの相手', target.x, target.y + 190, 16, '#bcaec8');
}
function demoFace(time) { return { x: 853 + Math.sin(time / 1800) * 9, y: 347 + Math.sin(time / 2300) * 5, w: 175, h: 214, angle: Math.sin(time / 1700) * .025, yaw: Math.sin(time / 1900) * .48, pitch: Math.sin(time / 2400) * .12 }; }
function sourceRect() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.max(W / vw, H / vh);
  return { width: vw * scale, height: vh * scale, x: (W - vw * scale) / 2, y: (H - vh * scale) / 2 };
}
function screenPoint(lm) {
  const r = sourceRect(); return { x: r.x + (1 - lm.x) * r.width, y: r.y + lm.y * r.height };
}
function facePosition(lms, matrix) {
  const l = screenPoint(lms[234]), r = screenPoint(lms[454]);
  const forehead = screenPoint(lms[10]), chin = screenPoint(lms[152]);
  const a = screenPoint(lms[33]), b = screenPoint(lms[263]);
  const eyes = a.x < b.x ? [a, b] : [b, a];
  const imageWidth = sourceRect().width;
  // Include estimated landmark depth so the shell does not collapse in width
  // when the wearer turns sideways. This is a visual fit, not metric SLAM.
  const faceWidth = Math.hypot(distance(l, r), (lms[234].z - lms[454].z) * imageWidth);
  const faceHeight = Math.hypot(distance(forehead, chin), (lms[10].z - lms[152].z) * imageWidth);
  return { x: (l.x + r.x) / 2, y: (forehead.y + chin.y) / 2 - 12, w: faceWidth * 1.9, h: faceHeight * 1.72, angle: Math.atan2(eyes[1].y - eyes[0].y, eyes[1].x - eyes[0].x), quaternion: threeHelpers?.faceQuaternion(matrix) || null };
}
function currentTarget(time) { return state.camera ? state.target : demoFace(time); }
function updateTarget(faces) {
  const next = chooseFace(faces, $('receiver').value);
  if (!next) { state.target = null; return; }
  if (!state.target || distance(next, state.target) > 160) { state.target = next; return; }
  for (const key of ['x', 'y', 'w', 'h', 'angle']) state.target[key] += (next[key] - state.target[key]) * .38;
  state.target.quaternion = threeHelpers?.blendOrientation(state.target.quaternion, next.quaternion) || null;
}
function targetRing(target) {
  if (!target) return;
  ctx.save(); ctx.strokeStyle = '#d6c6ee77'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 9]);
  ctx.beginPath(); ctx.ellipse(target.x, target.y, target.w * .65, target.h * .62, target.angle, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  label('この人にかぶせる', target.x, target.y - target.h * .67 - 17, 15, '#e1d4ee');
}
function burst(p, count = 35) {
  for (let i = 0; i < count; i++) state.particles.push({ x: p.x, y: p.y, vx: (Math.random() - .5) * 380, vy: -80 - Math.random() * 280, life: 1 + Math.random(), color: ['#ffb558', '#e3cbff', '#fff0ad'][i % 3], size: 3 + Math.random() * 6 });
}
function launch(from = state.pumpkin) {
  if (state.mode !== 'throw') return;
  const target = currentTarget(performance.now());
  if (!target) { notice('かぶる人の顔が見つかりません。顔をカメラに向けて、もう一度投げてください。'); state.pumpkin = defaultPumpkin(); return; }
  notice(); const start = { ...from };
  setMode('flying'); state.flight = { start, target: { ...target }, started: performance.now() }; beep(600, .25, .045);
}
function handleHand(lms, now) {
  if (!lms) {
    // Losing a hand must never count as releasing a throw.
    state.hand = null; state.pinched = false; state.dwell = 0;
    if (state.grabSource === 'hand') { gesture.reset(); state.grabSource = null; state.pumpkin = defaultPumpkin(); }
    if (state.stroke?.source === 'hand') endStroke();
    return;
  }
  const raw = screenPoint({ x: (lms[4].x + lms[8].x) / 2, y: (lms[4].y + lms[8].y) / 2 });
  const point = state.hand ? { x: state.hand.x + (raw.x - state.hand.x) * .68, y: state.hand.y + (raw.y - state.hand.y) * .68 } : raw;
  const pinch = isPinched(lms, state.pinched), was = state.pinched;
  state.handSize = distance(screenPoint(lms[5]), screenPoint(lms[17]));
  state.hand = point; state.handTime = now;
  if (state.mode === 'carve') {
    if (pinch && !state.pointerDown) carve(point, 'hand'); else if (state.stroke?.source === 'hand') endStroke();
    const overDone = point.x > doneZone.x && point.x < doneZone.x + doneZone.w && point.y > doneZone.y && point.y < doneZone.y + doneZone.h;
    if (overDone && !pinch) { state.dwell ||= now; if (now - state.dwell > 1200) { setMode('throw'); beep(420, .15); } } else state.dwell = 0;
  } else if (state.mode === 'throw' && state.grabSource !== 'pointer') {
    if (pinch && !was && overPumpkin(point)) { gesture.begin(point, now); state.grabSource = 'hand'; state.grabSize = Math.max(20, state.handSize); }
    if (gesture.active && state.grabSource === 'hand') {
      const size = 245 * clamp(state.handSize / state.grabSize, .65, 1.7);
      const palmWidth = Math.max(.025, distance(lms[5], lms[17]));
      const yaw = clamp((lms[5].z - lms[17].z) / palmWidth, -.9, .9);
      state.pumpkin = { ...state.pumpkin, x: point.x, y: point.y, w: size, h: size, yaw, depth: 245 / size };
      if (pinch) gesture.move(point, now);
      else {
        const tossed = gesture.release(point, now); state.grabSource = null;
        if (tossed) launch(); else { state.pumpkin = defaultPumpkin(); $('action-hint').textContent = 'つかんだ手をサッと動かし、動いている途中で指を開いてみよう。'; }
      }
    }
  }
  state.pinched = pinch;
}

function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H };
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return; canvas.setPointerCapture(event.pointerId); state.pointerDown = true;
  const p = pointerPoint(event);
  if (state.mode === 'carve') carve(p, 'pointer');
  if (state.mode === 'throw' && overPumpkin(p)) { gesture.begin(p, performance.now()); state.grabSource = 'pointer'; }
});
canvas.addEventListener('pointermove', event => {
  if (!state.pointerDown) return; const p = pointerPoint(event);
  if (state.mode === 'carve') carve(p, 'pointer');
  if (state.mode === 'throw' && state.grabSource === 'pointer') { gesture.move(p, performance.now()); state.pumpkin = { ...state.pumpkin, x: p.x, y: p.y }; }
});
canvas.addEventListener('pointerup', event => {
  if (state.mode === 'throw' && state.grabSource === 'pointer') {
    const tossed = gesture.release(pointerPoint(event), performance.now()); state.grabSource = null;
    if (tossed) launch(); else state.pumpkin = defaultPumpkin();
  }
  state.pointerDown = false; endStroke();
});
const cancelPointer = () => { state.pointerDown = false; endStroke(); if (state.grabSource === 'pointer') { gesture.reset(); state.grabSource = null; state.pumpkin = defaultPumpkin(); } };
canvas.addEventListener('pointercancel', cancelPointer); canvas.addEventListener('lostpointercapture', cancelPointer); window.addEventListener('blur', cancelPointer);

$('next').addEventListener('click', () => {
  if (state.mode === 'carve') setMode('throw'); else if (state.mode === 'throw') launch(); else if (state.mode === 'worn') { notice(); setMode('carve'); }
});
$('brush').addEventListener('input', event => { state.brush = Number(event.target.value); $('brush-value').value = state.brush; });
$('undo').addEventListener('click', () => { endStroke(); if (state.undo.length) { ink.putImageData(state.undo.pop(), 0, 0); state.dirty = true; } });
$('clear').addEventListener('click', () => { endStroke(); pushUndo(); ink.clearRect(0, 0, 512, 512); state.dirty = true; });
$('template').addEventListener('click', () => { endStroke(); applyTemplate(); });
function setSpin(enabled) {
  state.spin = enabled; $('spin').setAttribute('aria-pressed', enabled);
  $('spin').textContent = enabled ? '■ 回転をとめる' : '↻ 一周見る';
}
function updateRotationControl() {
  const degrees = Math.round(state.viewYaw * 180 / Math.PI);
  $('rotation').value = degrees; $('rotation-value').value = `${degrees}°`;
}
$('rotation').addEventListener('input', event => { endStroke(); setSpin(false); state.viewYaw = Number(event.target.value) * Math.PI / 180; updateRotationControl(); });
$('front').addEventListener('click', () => { endStroke(); setSpin(false); state.viewYaw = 0; updateRotationControl(); });
$('spin').addEventListener('click', () => { endStroke(); setSpin(!state.spin); });
document.querySelectorAll('[data-shape]').forEach(button => button.addEventListener('click', () => {
  endStroke(); state.shape = button.dataset.shape;
  document.querySelectorAll('[data-shape]').forEach(el => { const selected = el === button; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', selected); });
}));
$('receiver').addEventListener('change', () => { state.target = null; updateTarget(state.faces); });
$('sound').addEventListener('click', () => { state.sound = !state.sound; $('sound').textContent = `効果音 ${state.sound ? 'ON' : 'OFF'}`; $('sound').setAttribute('aria-pressed', state.sound); beep(420, .1); });
$('fullscreen').addEventListener('click', async () => {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); } catch { notice('この画面では全画面表示が使えません。通常のブラウザで開いてください。'); }
});
document.addEventListener('fullscreenchange', () => $('fullscreen').textContent = document.fullscreenElement ? '全画面を閉じる ↙' : '全画面にする ↗');

function stopCamera() {
  state.session++; state.camera = false; state.loading = false; state.ready = false; state.busy = false;
  video.srcObject?.getTracks().forEach(track => track.stop()); video.srcObject = null;
  state.worker?.terminate(); state.worker = null; state.faces = []; state.target = null; state.hand = null; state.pinched = false;
  state.grabSource = null; gesture.reset(); state.dwell = 0; endStroke();
  $('camera').textContent = '◉ カメラでARをはじめる'; $('camera').classList.remove('running'); $('camera').disabled = false;
  $('render-badge').textContent = pumpkin3d ? '3D プレビュー' : '2D';
  $('status-dot').classList.remove('live'); $('camera-state').textContent = 'マウスでおためし'; $('tracking-state').textContent = 'カメラなしでも遊べます';
  setMode('carve');
}
async function startCamera() {
  if (state.camera || state.loading) { stopCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { notice('カメラを使うには http://localhost:4173 をEdgeかChromeで開いてください。'); return; }
  state.loading = true; const session = ++state.session;
  $('camera').textContent = '準備中…'; $('camera').disabled = true; notice('カメラと手・顔の検出を準備しています。初回は少し時間がかかります。');
  let initTimer;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 600 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
    if (session !== state.session) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream; await video.play();
    const worker = new Worker('./tracker-worker.js'); state.worker = worker;
    await new Promise((resolve, reject) => {
      initTimer = setTimeout(() => reject(new Error('INIT_TIMEOUT')), 60000);
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') resolve();
        if (data.type === 'error') reject(new Error(data.message));
      };
      worker.postMessage({ type: 'init' });
    });
    clearTimeout(initTimer);
    if (session !== state.session) return;
    state.camera = true; state.loading = false; state.ready = true; state.lastVideo = -1; state.inferTimes = [];
    setMode('carve');
    state.worker.onerror = event => { console.error(event.message); stopCamera(); notice('検出処理が止まりました。もう一度カメラを開始してください。'); };
    state.worker.onmessage = ({ data }) => {
      state.busy = false;
      if (data.type === 'error') { console.error(data.message); stopCamera(); notice('検出処理に問題が起きました。もう一度カメラを開始してください。'); return; }
      if (data.type !== 'result') return;
      const now = performance.now(); state.inferTimes.push(now); state.inferTimes = state.inferTimes.filter(t => now - t < 1000);
      state.faces = data.faces.map((landmarks, i) => facePosition(landmarks, data.matrices?.[i])); updateTarget(state.faces); handleHand(data.hands[0], now);
      $('tracking-state').textContent = `顔 ${data.faces.length}人 · 手 ${data.hands.length}本 · ${state.inferTimes.length}回/秒`;
    };
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (state.camera) { stopCamera(); notice('カメラが切断されました。接続を確認して再開してください。'); } });
    $('camera').textContent = '■ カメラをとめる'; $('camera').classList.add('running'); $('camera').disabled = false;
    $('camera-state').textContent = 'カメラで体験中'; $('status-dot').classList.add('live');
    $('render-badge').textContent = pumpkin3d ? '3D AR' : '2D'; notice();
  } catch (error) {
    clearTimeout(initTimer); console.error(error); stopCamera();
    const messages = {
      NotAllowedError: 'カメラが許可されていません。ブラウザのカメラ設定で許可して、もう一度押してください。',
      NotFoundError: 'カメラが見つかりません。内蔵カメラが有効か確認してください。',
      NotReadableError: 'カメラを開けません。カメラを使っているほかのアプリを閉じてから、もう一度試してください。',
    };
    notice(messages[error.name] || '手と顔の検出を開始できませんでした。通常のEdgeかChromeで開いてください。検出用データがない場合はREADMEの手順で準備できます。');
  }
}
$('camera').addEventListener('click', startCamera);
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) { handleHand(null, performance.now()); cancelPointer(); } });
async function requestInference(time) {
  if (!state.camera || !state.ready || state.busy || video.readyState < 2 || document.hidden || time - state.lastFrame < 80 || video.currentTime === state.lastVideo) return;
  state.busy = true; state.lastFrame = time; state.lastVideo = video.currentTime;
  const session = state.session;
  try {
    const bitmap = await createImageBitmap(video);
    if (session !== state.session || !state.worker) { bitmap.close(); return; }
    state.worker.postMessage({ type: 'frame', bitmap, time }, [bitmap]);
  } catch (error) {
    console.error(error); if (session === state.session) { stopCamera(); notice('カメラ映像を読み取れませんでした。もう一度開始してください。'); }
  }
}

let lastDraw = performance.now();
function draw(time) {
  const dt = Math.min(.05, (time - lastDraw) / 1000); lastDraw = time;
  if (state.spin && state.mode === 'carve') {
    state.viewYaw += dt * .8; if (state.viewYaw > Math.PI) state.viewYaw -= Math.PI * 2;
    updateRotationControl();
  }
  renderTexture();
  if (state.camera && video.readyState >= 2) {
    const r = sourceRect(); ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(video, r.x, r.y, r.width, r.height); ctx.restore();
    ctx.fillStyle = state.mode === 'carve' ? '#19102355' : '#19102315'; ctx.fillRect(0, 0, W, H);
  } else drawDemo(time);
  const target = currentTarget(time);
  if (state.mode === 'carve') {
    ctx.save(); ctx.fillStyle = '#100d1738'; ctx.beginPath(); ctx.ellipse(365, 574, 152, 22, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    drawPumpkin(state.pumpkin);
    label(pumpkin3d ? 'YOUR 3D PUMPKIN' : 'YOUR ORIGINAL', 365, 87, 14, '#ddc6b7');
    if (state.camera) {
      roundedRect(doneZone.x, doneZone.y, doneZone.w, doneZone.h, 14, '#251a31d9', '#d6ae7d');
      if (state.dwell) { const progress = clamp((time - state.dwell) / 1200, 0, 1); roundedRect(doneZone.x, doneZone.y, doneZone.w * progress, doneZone.h, 14, '#b9814a99'); }
      label('できた！ →', doneZone.x + doneZone.w / 2, doneZone.y + 23, 20, '#ffce8a');
      label('指をここに置いて待つ', doneZone.x + doneZone.w / 2, doneZone.y + 48, 12, '#dbcde3');
    } else {
      roundedRect(727, 115, 250, 57, 29, '#43334f', '#72517e'); label('カメラで教室に出現', 852, 144, 16, '#dac5e8');
    }
    label(state.spin ? '立体をぐるっと確認中' : state.camera ? 'つまんで、なぞろう' : 'ドラッグして、削ろう', 365, 597, 16, '#e8d9cf');
  } else if (state.mode === 'throw') {
    targetRing(target); drawPumpkin(state.pumpkin, gesture.active ? -.1 : Math.sin(time / 550) * .025);
    if (!gesture.active) label(state.camera ? 'ここをつまんで、つかむ' : 'つかんで、サッと投げる', 295, 613, 17, '#ffe1b2');
    if (!target) label('かぶる人の顔をカメラに映してね', W / 2, 86, 20, '#ffe1b2');
  } else if (state.mode === 'flying') {
    const f = state.flight, t = clamp((time - f.started) / 850, 0, 1), ease = 1 - (1 - t) ** 2;
    if (target) f.target = { ...target };
    const p = { x: f.start.x + (f.target.x - f.start.x) * ease, y: f.start.y + (f.target.y - f.start.y) * ease - Math.sin(t * Math.PI) * 150, w: f.start.w + (f.target.w - f.start.w) * ease, h: f.start.h + (f.target.h - f.start.h) * ease, yaw: (f.start.yaw || 0) + Math.sin(t * Math.PI) * Math.PI * 1.6, pitch: -Math.sin(t * Math.PI) * .6, depth: 1 + Math.sin(t * Math.PI) * .35 };
    drawPumpkin(p, Math.sin(t * Math.PI) * .6);
    if (t >= 1) { setMode('worn'); burst(f.target); beep(880, .25, .055); }
  } else if (state.mode === 'worn') {
    if (target) { drawPumpkin(target, target.angle); roundedRect(378, 63, 364, 63, 32, '#2b1d35d9', '#ae8054'); label('HAPPY HALLOWEEN!', W / 2, 95, 24, '#ffc781'); }
    else label('顔をカメラに向けると、またかぶれます', W / 2, 110, 21, '#ffe1b2');
  }
  for (const p of state.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 340 * dt; p.life -= dt; ctx.globalAlpha = clamp(p.life * 2, 0, 1); ctx.fillStyle = p.color; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.life * 4); ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); }
  ctx.globalAlpha = 1; state.particles = state.particles.filter(p => p.life > 0).slice(-150);
  if (state.hand && time - state.handTime < 500 && state.camera) {
    ctx.save(); ctx.strokeStyle = state.pinched ? '#ffb24f' : '#f1dfff'; ctx.lineWidth = 3; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(state.hand.x, state.hand.y, state.pinched ? 11 : 18, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(state.hand.x, state.hand.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  } else if (state.camera && state.hand && time - state.handTime >= 500) { handleHand(null, time); }
  requestInference(time); requestAnimationFrame(draw);
}
try {
  threeHelpers = await import('./pumpkin-3d.mjs');
  pumpkin3d = new threeHelpers.Pumpkin3D(mask, W, H);
  $('render-badge').textContent = '3D プレビュー';
} catch (error) {
  console.error(error); $('render-badge').textContent = '2D';
  notice('3D表示を開始できなかったため、2Dで表示しています。EdgeかChromeで開き直してください。');
}
state.pumpkin = defaultPumpkin(); setMode('carve'); requestAnimationFrame(draw);
