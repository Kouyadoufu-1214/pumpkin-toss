import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrackingTuning, setupTrackingDebug } from '../public/tracking-debug.mjs';
import { DEFAULT_TRACKING_TUNING } from '../public/tracking-tuning.mjs';

function harness(saved = null, { fullscreenContainer = false } = {}) {
  let writes = 0;
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
      this.attributes = new Map(); this.hidden = false; this.value = ''; this.className = ''; this._text = '';
    }
    set textContent(text) { this._text = text; writes++; }
    get textContent() { return this._text; }
    append(...nodes) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); writes++; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
    emit(type, event = {}) { this.listeners.get(type)?.({ target: this, ...event }); }
    closest() { return null; }
    remove() { this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  }
  const document = new Element('document'); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  if (fullscreenContainer) {
    const exhibit = new Element('main'); exhibit.id = 'exhibit'; document.body.append(exhibit);
  }
  const all = () => {
    const result = [];
    const walk = node => { result.push(node); node.children.forEach(walk); };
    walk(document.body); return result;
  };
  document.getElementById = id => all().find(node => node.id === id) || null;
  const storage = { value: saved, saves: 0,
    getItem(key) { assert.equal(key, 'pumpkin-tracking-tuning-v1'); return this.value; },
    setItem(key, value) { assert.equal(key, 'pumpkin-tracking-tuning-v1'); this.value = value; this.saves++; },
  };
  const changes = [];
  const api = setupTrackingDebug({ document, storage, onChange: value => changes.push(value) });
  return { api, document, storage, changes, writes: () => writes,
    find: predicate => all().find(predicate),
    key(key, options = {}) {
      let prevented = false;
      document.emit('keydown', { key, repeat: false, target: document.body, preventDefault() { prevented = true; }, ...options });
      return prevented;
    },
  };
}

test('F2 enables raw diagnostics, ignores repeats and text editing, and close/destroy remove UI safely', () => {
  const h = harness(), panel = h.find(node => node.id === 'tracking-debug');
  assert.equal(h.api.isOpen(), false); assert.equal(panel.hidden, true);
  assert.equal(h.key('F2', { repeat: true }), false); assert.equal(h.api.isOpen(), false);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    assert.equal(h.key('F2', { target }), false); assert.equal(h.api.isOpen(), false);
  }
  assert.equal(h.key('F1'), false); assert.equal(h.key('F2'), true);
  assert.equal(h.api.isOpen(), true); assert.equal(panel.hidden, false);
  h.find(node => node.attributes.get('aria-label') === '開発者モードを閉じる').emit('click');
  assert.equal(h.api.isOpen(), false); assert.equal(panel.hidden, true);
  h.api.toggle(true); h.api.destroy(); h.api.destroy();
  assert.equal(h.api.isOpen(), false); assert.equal(h.api.toggle(), false);
  assert.equal(h.document.body.children.length, 0); assert.equal(h.document.listeners.has('keydown'), false);
});

test('diagnostics mount within the app fullscreen root, with a body fallback for standalone pages', () => {
  const app = harness(null, { fullscreenContainer: true });
  const panel = app.find(node => node.id === 'tracking-debug');
  assert.equal(panel.parentElement.id, 'exhibit', 'fullscreen must include both diagnostics and game');
  app.key('F2'); assert.equal(panel.hidden, false);
  app.api.destroy(); assert.equal(app.document.getElementById('exhibit').children.length, 0);
  const standalone = harness();
  assert.equal(standalone.find(node => node.id === 'tracking-debug').parentElement, standalone.document.body);
});

test('release recovery remains explained after landing and distinguishes observation from inference', () => {
  const h = harness(); h.api.toggle(true);
  const note = h.find(node => node.className === 'tracking-debug__recovery');
  h.api.update({ phase: 'flying', reason: 'release-recovered-open', lastThrowRecovery: 'observed-open' }, 1000);
  assert.equal(note.hidden, false); assert.match(note.textContent, /パー確認後/);
  h.api.update({ phase: 'worn', reason: 'landed', lastThrowRecovery: 'opening-swing' }, 1300);
  assert.equal(note.hidden, false); assert.match(note.textContent, /推定.*未確認/);
  h.api.update({ phase: 'ready', lastThrowRecovery: '' }, 1600);
  assert.equal(note.hidden, true); assert.equal(note.textContent, '');
});

test('saved settings are normalized, malformed or inaccessible storage falls back, and controls persist only tuning', () => {
  assert.deepEqual(loadTrackingTuning({ getItem: () => '{broken' }), DEFAULT_TRACKING_TUNING);
  assert.deepEqual(loadTrackingTuning({ getItem() { throw Error('blocked'); } }), DEFAULT_TRACKING_TUNING);
  assert.deepEqual(loadTrackingTuning({ getItem: () => 'null' }), DEFAULT_TRACKING_TUNING);
  const h = harness(JSON.stringify({ minSpeed: -12, minDistance: 999, quality: 'evil', secret: 'ignore' }));
  const speed = h.find(node => node.id === 'tracking-debug-minSpeed');
  assert.equal(speed.value, '80');
  speed.value = '999'; speed.emit('input');
  assert.equal(h.changes.at(-1).minSpeed, 600);
  assert.deepEqual(Object.keys(JSON.parse(h.storage.value)).sort(), Object.keys(DEFAULT_TRACKING_TUNING).sort());
  const quality = h.find(node => node.id === 'tracking-debug-quality'); quality.value = 'light'; quality.emit('change');
  assert.equal(h.changes.at(-1).quality, 'light');
  h.find(node => node.className === 'tracking-debug__reset').emit('click');
  assert.deepEqual(h.changes.at(-1), DEFAULT_TRACKING_TUNING);
  assert.equal(h.find(node => node.attributes.get('role') === 'status').textContent, '調整値を標準に戻しました。');
  h.storage.setItem = () => { throw Error('quota'); };
  speed.value = '120'; assert.doesNotThrow(() => speed.emit('input'));
  assert.equal(h.changes.at(-1).minSpeed, 120);
});

test('diagnostics do no DOM work while closed and update at most five times a second while preserving recent transitions', () => {
  const h = harness(), before = h.writes();
  h.api.update({ phase: 'ready', reason: 'waiting-hand' }, 0);
  h.api.update({ phase: 'held', reason: 'gripping', gesture: 'Closed_Fist' }, 10);
  assert.equal(h.writes(), before, 'closed diagnostics cannot add frame-by-frame DOM cost');
  h.api.toggle(true); const opened = h.writes();
  h.api.update({ phase: 'held', reason: 'swing', handFps: 18 }, 50);
  h.api.update({ phase: 'held', reason: 'swing', handFps: 21 }, 209);
  assert.equal(h.writes(), opened);
  h.api.update({ phase: 'held', reason: 'open-confirm', gesture: 'Open_Palm', releaseProgress: .5, confidence: .86,
    renderFps: 60, handFps: 24, speed: 300, travel: 80, lastThrowReason: 'slow' }, 210);
  assert.ok(h.writes() > opened);
  const history = h.find(node => node.className === 'tracking-debug__events');
  assert.equal(history.children.length, 4, 'repeated swing snapshots are a single event');
  assert.ok(history.children[0].textContent.includes('パーを確認中'));
  assert.equal(h.find(node => node.id === 'tracking-debug-release').value, .5);
  assert.ok(h.find(node => node.className === 'tracking-debug__failure').textContent.includes('直近の失敗：速度・距離・観測時間が条件未達'));
  const current = h.find(node => node.attributes.get('aria-current') === 'step');
  assert.equal(current.textContent, 'しっかり開く');
  for (let i = 0; i < 20; i++) h.api.update({ phase: 'held', reason: `reason ${i}` }, 410 + i * 200);
  assert.equal(history.children.length, 6);
  h.api.toggle(false); const closed = h.writes();
  h.api.update({ phase: 'flying', reason: 'launched' }, 6000); assert.equal(h.writes(), closed);
});

test('record preserves fast inference transitions without DOM work and ignores events while closed', () => {
  const h = harness();
  h.api.record({ phase: 'ready', reason: 'waiting-hand' }, 0);
  h.api.toggle(true);
  const history = h.find(node => node.className === 'tracking-debug__events');
  assert.equal(history.children.length, 0);
  const writes = h.writes();
  h.api.record({ phase: 'held', reason: 'gripping' }, 10);
  h.api.record({ phase: 'held', reason: 'open-confirm' }, 40);
  h.api.record({ phase: 'flying', reason: 'launched' }, 80);
  assert.equal(h.writes(), writes, 'recording cannot paint between the throttled snapshots');
  h.api.update({ phase: 'flying', reason: 'launched', duration: 160, gap: 40 }, 220);
  assert.equal(history.children.length, 3);
  assert.ok(history.children[1].textContent.includes('パーを確認中'));
  assert.ok(h.find(node => node.textContent === '160 ms'));
  assert.ok(h.find(node => node.textContent === '40 ms'));
  h.api.toggle(false); h.api.record({ phase: 'worn', reason: 'landed' }, 260); h.api.toggle(true);
  assert.equal(history.children.length, 3);
});

test('an initially open palm waits for a light grip and only a held hand can display the opening step', () => {
  const h = harness();
  h.api.toggle(true);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, '軽く握る');
  assert.equal(h.find(node => node.className === 'tracking-debug__state').textContent, '軽く握るのを待っています');
  h.api.update({ phase: 'ready', reason: 'waiting-grip', gesture: 'Open_Palm', releaseProgress: 0 }, 200);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, '軽く握る');
  assert.equal(h.find(node => node.id === 'tracking-debug-release').value, 0);
  assert.ok(h.find(node => node.className === 'tracking-debug__reason').textContent.includes('手を少し丸めると'));
  h.api.update({ phase: 'held', reason: 'gripping', gesture: 'None', releaseProgress: 0 }, 400);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, '相手へ振る');
  assert.equal(h.find(node => node.id === 'tracking-debug-release').value, 0);
  assert.ok(h.find(node => node.className === 'tracking-debug__reason').textContent.includes('ゆるく握った手を認識'));
  h.api.update({ phase: 'held', reason: 'opening', gesture: 'Open_Palm', releaseProgress: 0 }, 600);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, 'しっかり開く');
  assert.equal(h.find(node => node.id === 'tracking-debug-release').value, 0, 'partly open fingers do not imply release confirmation');
  assert.ok(h.find(node => node.className === 'tracking-debug__reason').textContent.includes('開き切るまで'));
  h.api.update({ phase: 'held', reason: 'open-confirm', gesture: 'Open_Palm', releaseProgress: .5 }, 800);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, 'しっかり開く');
  assert.equal(h.find(node => node.id === 'tracking-debug-release').value, .5);
});

test('geometric finger openness is shown independently of the raw model classification and confidence', () => {
  const h = harness();
  h.api.toggle(true);
  const metric = label => h.find(node => node.tagName === 'DT' && node.textContent === label).parentElement.children[1];
  assert.equal(metric('指の開き具合').textContent, '—');
  h.api.update({ phase: 'held', reason: 'opening', gesture: 'Open_Palm', confidence: .98, openness: .72 }, 200);
  assert.equal(metric('モデルの手の形').textContent, 'パー');
  assert.equal(metric('形の信頼度').textContent, '98%');
  assert.equal(metric('指の開き具合').textContent, '72%');
  h.api.update({ phase: 'held', reason: 'open-confirm', gesture: 'Open_Palm', openness: 1 }, 400);
  assert.equal(metric('指の開き具合').textContent, '100%');
  h.api.update({ phase: 'ready', reason: 'waiting-hand', openness: NaN }, 600);
  assert.equal(metric('指の開き具合').textContent, '—', 'missing geometry cannot look like measured closed fingers');
});

test('camera, hand, face and rendered frame rates are shown separately with unavailable values left blank', () => {
  const h = harness(); h.api.toggle(true);
  const metric = label => h.find(node => node.tagName === 'DT' && node.textContent === label).parentElement.children[1];
  for (const label of ['画面の FPS', 'カメラ設定 FPS', '手の検出 / 秒', '顔の検出 / 秒']) {
    assert.equal(metric(label).textContent, '—');
  }
  h.api.update({ renderFps: 59.8, cameraFps: 30, handFps: 24, faceFps: 6 }, 200);
  assert.equal(metric('画面の FPS').textContent, '60');
  assert.equal(metric('カメラ設定 FPS').textContent, '30');
  assert.equal(metric('手の検出 / 秒').textContent, '24');
  assert.equal(metric('顔の検出 / 秒').textContent, '6');
  h.api.update({ cameraFps: Infinity, handFps: 0, faceFps: NaN }, 400);
  assert.equal(metric('カメラ設定 FPS').textContent, '—');
  assert.equal(metric('手の検出 / 秒').textContent, '0');
  assert.equal(metric('顔の検出 / 秒').textContent, '—');
});

test('full finger extension does not hide a thumb that has not opened', () => {
  const h = harness(); h.api.toggle(true);
  const metric = label => h.find(node => node.tagName === 'DT' && node.textContent === label).parentElement.children[1];
  h.api.update({ phase: 'held', reason: 'thumb-closed', openness: 1, extendedFingers: 4, thumbOpen: false }, 200);
  assert.equal(metric('指の開き具合').textContent, '100%');
  assert.equal(metric('伸びた指（親指以外）').textContent, '4 / 4 本');
  assert.equal(metric('親指の開き').textContent, 'まだ開いていない');
  assert.match(h.find(node => node.className === 'tracking-debug__reason').textContent, /親指も/);
  assert.equal(h.find(node => node.attributes.get('aria-current') === 'step').textContent, 'しっかり開く');
  h.api.update({ thumbOpen: true, extendedFingers: 4 }, 400);
  assert.equal(metric('親指の開き').textContent, '開いている');
  h.api.update({ missing: true }, 600);
  assert.equal(metric('親指の開き').textContent, '—');
  assert.equal(metric('伸びた指（親指以外）').textContent, '—');
});

test('bone overlay uses raw mapped points only while enabled, preserves the canvas, and never draws a cached missing hand', () => {
  const h = harness(), calls = [], context = {};
  for (const name of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'fillRect', 'fillText']) {
    context[name] = (...args) => calls.push([name, ...args, context.strokeStyle]);
  }
  const active = { points: Array.from({ length: 21 }, (_, i) => ({ x: 20 + i, y: 70 + i })) };
  const other = { points: Array.from({ length: 21 }, (_, i) => ({ x: 500 + i, y: 100 + i })) };
  const original = structuredClone(active);
  h.api.draw(context, [active], active); assert.equal(calls.length, 0);
  h.api.toggle(true); h.api.draw(context, [active, other], active);
  assert.equal(calls[0][0], 'save'); assert.equal(calls.at(-1)[0], 'restore');
  assert.deepEqual(calls.find(call => call[0] === 'moveTo'), ['moveTo', 20, 70, '#ffb65b']);
  assert.equal(calls.filter(call => call[0] === 'arc').length, 42);
  assert.ok(calls.some(call => call[0] === 'stroke' && call.at(-1) === '#70edff'));
  assert.deepEqual(active, original, 'debug drawing cannot smooth or mutate game input');
  calls.length = 0;
  h.api.draw(context, [other], active, { missing: true });
  assert.equal(calls.filter(call => call[0] === 'arc').length, 21);
  assert.ok(!calls.some(call => call.at(-1) === '#ffb65b'));
  calls.length = 0;
  h.api.draw(context, [active], active, { missing: true }); assert.equal(calls.length, 0);
  h.api.draw(context, [], active); assert.equal(calls.length, 0);
});
