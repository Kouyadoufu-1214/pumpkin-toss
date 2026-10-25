import { DEFAULT_TRACKING_TUNING, normalizeTrackingTuning } from './tracking-tuning.mjs';

const STORAGE_KEY = 'pumpkin-tracking-tuning-v1';
const UPDATE_MS = 200;
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const FIELDS = [
  ['minSpeed', '投げる最低速度', 80, 600, 10, 'px/s'],
  ['minDistance', '投げる最低距離', 20, 160, 4, 'px'],
  ['openConfirmMs', 'パーの確認時間', 0, 180, 10, 'ms'],
  ['gestureConfidence', 'パーの信頼度', .5, .95, .05, '%'],
  ['smoothingMs', '表示のふわり補正', 0, 160, 5, 'ms'],
];
const PHASE_NAMES = { ready: '軽く握るのを待っています', held: '手に持っています', flying: '投球中', worn: '投球完了' };
const GESTURE_NAMES = { Closed_Fist: 'グー', Open_Palm: 'パー', None: '判別中', Unknown: '判別中' };
const QUALITY_NAMES = { auto: '自動', light: '軽量', high: '高画質' };
const REASON_NAMES = {
  ready: '投げる側で手を軽く握ると、かぼちゃを持てます。',
  'waiting-hand': '手を探しています。手のひら全体をカメラへ。',
  'waiting-grip': '手を少し丸めると、かぼちゃを持てます。強く握る必要はありません。',
  'wrong-side': '投げる人の側へ手を移してください。',
  gripping: 'ゆるく握った手を認識して保持しています。相手へ振り、指を開き切ってください。',
  swing: '相手へ手を振っています。指をしっかり開くと投げます。',
  opening: 'まだ指を開く途中です。開き切るまで、かぼちゃを持ち続けます。',
  'open-confirm': '開き切ったパーを確認中です。確認時間を下げると早く離せます。',
  'missing-hand': '手を見失っています。画面内へ戻るまで保持します。',
  'edge-hold': '手が見切れています。誤って離さず、そのまま保持します。',
  'no-receiver': '相手の顔が見つかりません。かぶる人をカメラへ。',
  direction: '相手の方向へ、もう少し大きく手を動かしてください。',
  slow: '速度・距離・観測時間が条件未達です。下の値で判定を調整できます。',
  cancelled: '保持を解除しました。投げる側でもう一度手を軽く握ってください。',
  launched: '投球を認識しました。',
  landed: 'かぼちゃが相手に届きました。',
};
const reasonText = reason => REASON_NAMES[reason] || reason || '';

function localStorageOrNull() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function loadTrackingTuning(storage = localStorageOrNull()) {
  try { return normalizeTrackingTuning(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null')); }
  catch { return normalizeTrackingTuning(DEFAULT_TRACKING_TUNING); }
}

function finite(value, digits = 0, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '—';
}

function isTyping(target) {
  return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
    || !!target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

/** Owns only the diagnostic UI. It never runs inference or changes a throw state. */
export function setupTrackingDebug({ onChange = () => {}, initialSettings, document: doc = globalThis.document,
  storage = localStorageOrNull() } = {}) {
  let settings = normalizeTrackingTuning(initialSettings ?? loadTrackingTuning(storage));
  let open = false, destroyed = false, lastPaint = -Infinity, latest = {}, latestTime = 0;
  let lastEvent = '', firstTime = null;
  const history = [], controls = new Map(), metrics = new Map();
  function element(tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  const panel = element('section', 'tracking-debug');
  panel.hidden = true;
  panel.id = 'tracking-debug';
  panel.setAttribute('aria-label', '手の認識と投球の開発者モード');
  const header = element('div', 'tracking-debug__header');
  const heading = element('h2', '', '手の認識・投球チェック');
  const close = element('button', 'tracking-debug__close', '閉じる');
  close.type = 'button'; close.setAttribute('aria-label', '開発者モードを閉じる');
  header.append(heading, close);
  const intro = element('p', 'tracking-debug__intro', 'F2 で表示切替。骨は補正前の検出位置です。橙＝操作する手、水色＝ほかの手。');
  const state = element('p', 'tracking-debug__state', 'カメラを開始すると認識状態が見られます。');
  const stages = element('ol', 'tracking-debug__stages');
  const stageNodes = ['軽く握る', '相手へ振る', 'しっかり開く', '投球'].map(text => {
    const node = element('li', '', text); stages.append(node); return node;
  });
  const reason = element('p', 'tracking-debug__reason');
  const lastFailure = element('p', 'tracking-debug__failure'); lastFailure.hidden = true;
  const releaseLabel = element('label', 'tracking-debug__release-label', 'パーの確認');
  releaseLabel.setAttribute('for', 'tracking-debug-release');
  const release = element('progress', 'tracking-debug__release');
  release.id = 'tracking-debug-release'; release.max = 1; release.value = 0;
  const values = element('dl', 'tracking-debug__metrics');
  for (const [key, label] of [
    ['renderFps', '画面の FPS'], ['handFps', '手の検出 / 秒'], ['handLatencyMs', '手の遅れ'], ['renderMs', '描画の処理時間'],
    ['handMs', '手の処理時間'], ['faceMs', '顔の処理時間'], ['gesture', 'モデルの手の形'], ['confidence', '形の信頼度'],
    ['openness', '指の開き具合'],
    ['handCount', '検出した手'], ['receiverSeen', '相手の顔'], ['speed', '相手方向の速度'], ['travel', '移動距離'],
    ['duration', '動作の観測時間'], ['gap', '観測の間隔'],
    ['quality', '描画品質'],
  ]) {
    const group = element('div'), term = element('dt', '', label), value = element('dd', '', '—');
    group.append(term, value); values.append(group); metrics.set(key, value);
  }
  const historyTitle = element('h3', '', '直近の動作');
  const events = element('ol', 'tracking-debug__events');
  const controlsTitle = element('h3', '', '反応を調整');
  const help = element('p', 'tracking-debug__help', '速度・距離・確認時間を下げるほど投げやすくなります。補正は表示だけに適用します。');
  const tuning = element('div', 'tracking-debug__tuning');
  for (const [key, label, min, max, step, unit] of FIELDS) {
    const group = element('div', 'tracking-debug__field');
    const title = element('label', '', label); title.setAttribute('for', `tracking-debug-${key}`);
    const output = element('output'); output.setAttribute('for', `tracking-debug-${key}`);
    const input = element('input'); input.type = 'range'; input.id = `tracking-debug-${key}`;
    input.min = String(min); input.max = String(max); input.step = String(step);
    const sync = () => {
      input.value = String(settings[key]);
      output.textContent = unit === '%' ? `${Math.round(settings[key] * 100)}%` : `${settings[key]} ${unit}`;
      input.setAttribute('aria-valuetext', output.textContent);
    };
    input.addEventListener('input', () => change({ ...settings, [key]: Number(input.value) }));
    group.append(title, output, input); tuning.append(group); controls.set(key, { input, sync }); sync();
  }
  const qualityGroup = element('div', 'tracking-debug__field');
  const qualityLabel = element('label', '', '描画品質'); qualityLabel.setAttribute('for', 'tracking-debug-quality');
  const quality = element('select'); quality.id = 'tracking-debug-quality';
  for (const [value, label] of Object.entries(QUALITY_NAMES)) {
    const option = element('option', '', label); option.value = value; quality.append(option);
  }
  quality.value = settings.quality;
  quality.addEventListener('change', () => change({ ...settings, quality: quality.value }));
  qualityGroup.append(qualityLabel, quality); tuning.append(qualityGroup);
  const reset = element('button', 'tracking-debug__reset', '標準に戻す'); reset.type = 'button';
  const feedback = element('p', 'tracking-debug__help'); feedback.setAttribute('role', 'status');
  reset.addEventListener('click', () => { change(DEFAULT_TRACKING_TUNING); feedback.textContent = '調整値を標準に戻しました。'; });
  const stored = element('p', 'tracking-debug__help', '調整値はこの端末だけに保存します。');
  panel.append(header, intro, state, stages, reason, lastFailure, releaseLabel, release, values, historyTitle, events,
    controlsTitle, help, tuning, reset, feedback, stored);
  // Fullscreen shows only descendants of #exhibit. Keep the panel inside that
  // root so F2 and the close button remain usable on the venue's screen.
  (doc.getElementById?.('exhibit') || doc.body).append(panel);

  function change(next) {
    settings = normalizeTrackingTuning(next);
    for (const control of controls.values()) control.sync();
    quality.value = settings.quality;
    feedback.textContent = '調整値を適用しました。';
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Private browsing can deny storage. */ }
    onChange({ ...settings });
  }
  function paint() {
    const snapshot = latest, phase = snapshot.phase || 'ready';
    const gestureName = typeof snapshot.gesture === 'object' ? snapshot.gesture?.categoryName : snapshot.gesture;
    const stage = phase === 'flying' || phase === 'worn' ? 3 : phase === 'held'
      ? snapshot.releaseProgress > 0 || snapshot.reason === 'opening' || snapshot.reason === 'open-confirm' ? 2 : 1 : 0;
    state.textContent = snapshot.missing ? '手を見失っています · 保持して復帰を待機' : PHASE_NAMES[phase] || phase;
    stageNodes.forEach((node, index) => {
      node.className = index === stage ? 'is-current' : index < stage ? 'is-complete' : '';
      if (index === stage) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
    reason.textContent = reasonText(snapshot.reason) || (snapshot.missing ? '手を画面内に戻してください。' : '軽く握る → 相手へ振る → しっかり開く、の順に確認します。');
    lastFailure.hidden = !snapshot.lastThrowReason;
    lastFailure.textContent = snapshot.lastThrowReason ? `直近の失敗：${reasonText(snapshot.lastThrowReason)}` : '';
    release.value = Math.max(0, Math.min(1, Number(snapshot.releaseProgress) || 0));
    const formatted = {
      renderFps: finite(snapshot.renderFps), handFps: finite(snapshot.handFps),
      handLatencyMs: finite(snapshot.handLatencyMs, 0, ' ms'), renderMs: finite(snapshot.renderMs, 1, ' ms'),
      handMs: finite(snapshot.handMs, 1, ' ms'), faceMs: finite(snapshot.faceMs, 1, ' ms'),
      gesture: GESTURE_NAMES[gestureName] || gestureName || '—', confidence: finite(Number.isFinite(snapshot.confidence) ? snapshot.confidence * 100 : NaN, 0, '%'),
      openness: finite(Number.isFinite(snapshot.openness) ? snapshot.openness * 100 : NaN, 0, '%'),
      handCount: finite(snapshot.handCount, 0, ' 本'), receiverSeen: snapshot.receiverSeen ? '検出あり' : '検出なし',
      speed: `${finite(snapshot.speed)} / ${finite(snapshot.minSpeed ?? settings.minSpeed)} px/s`,
      travel: `${finite(snapshot.travel)} / ${finite(snapshot.minDistance ?? settings.minDistance)} px`,
      duration: finite(snapshot.duration, 0, ' ms'), gap: finite(snapshot.gap, 0, ' ms'),
      quality: QUALITY_NAMES[snapshot.quality ?? settings.quality] || '—',
    };
    for (const [key, value] of Object.entries(formatted)) metrics.get(key).textContent = value;
    events.replaceChildren(...history.map(item => {
      const elapsed = Math.max(0, Math.floor((item.time - firstTime) / 1000));
      return element('li', '', `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} ${item.text}`);
    }));
    lastPaint = latestTime;
  }
  function toggle(force) {
    if (destroyed) return false;
    open = typeof force === 'boolean' ? force : !open;
    panel.hidden = !open;
    if (open) paint();
    return open;
  }
  function keydown(event) {
    if (event.key !== 'F2' || event.repeat || isTyping(event.target)) return;
    event.preventDefault(); toggle();
  }
  close.addEventListener('click', () => toggle(false));
  doc.addEventListener('keydown', keydown);
  function capture(snapshot, time) {
    if (firstTime === null) firstTime = time;
    const text = [PHASE_NAMES[snapshot.phase] || snapshot.phase || '', reasonText(snapshot.reason) || (snapshot.missing ? '手の再検出を待っています' : '')].filter(Boolean).join(' · ');
    if (text && text !== lastEvent) {
      lastEvent = text; history.unshift({ text, time }); if (history.length > 6) history.pop();
    }
  }
  return {
    isOpen: () => open,
    toggle,
    // Inference can pass brief transitions (for example a 40 ms open palm)
    // without adding DOM work or waiting for the next rendered snapshot.
    record(snapshot, time) {
      if (!open || destroyed || !snapshot) return;
      capture(snapshot, Number.isFinite(time) ? time : latestTime);
    },
    update(snapshot, time) {
      if (destroyed) return;
      latest = snapshot || {}; latestTime = Number.isFinite(time) ? time : 0;
      capture(latest, latestTime);
      if (open && (latestTime - lastPaint >= UPDATE_MS || latestTime < lastPaint)) paint();
    },
    draw(context, hands, activeHand, { missing = false } = {}) {
      if (!open || destroyed || !context) return;
      const visible = (hands || []).filter(hand => !(missing && hand === activeHand)
        && hand?.points?.length >= 21);
      if (!visible.length) return;
      context.save();
      context.lineWidth = 3; context.lineJoin = context.lineCap = 'round';
      for (const hand of visible) {
        const color = hand === activeHand ? '#ffb65b' : '#70edff';
        context.strokeStyle = color; context.fillStyle = color;
        const valid = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
        context.beginPath();
        for (const [from, to] of CONNECTIONS) {
          const start = hand.points[from], end = hand.points[to];
          if (valid(start) && valid(end)) { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); }
        }
        context.stroke();
        for (const point of hand.points.slice(0, 21)) {
          if (!valid(point)) continue;
          context.beginPath(); context.arc(point.x, point.y, 4, 0, Math.PI * 2); context.fill();
        }
      }
      context.font = 'bold 16px sans-serif'; context.textAlign = 'left'; context.textBaseline = 'top';
      context.fillStyle = 'rgba(8, 10, 20, .85)'; context.fillRect(12, 12, 220, 30);
      context.fillStyle = '#fff'; context.fillText('生の手認識（表示補正前）', 20, 19);
      context.restore();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; open = false;
      doc.removeEventListener('keydown', keydown); panel.remove();
    },
  };
}
