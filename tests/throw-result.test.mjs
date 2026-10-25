import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const experience = readFileSync(new URL('../public/experience.mjs', import.meta.url), 'utf8');
const start = experience.indexOf('function hideThrowResult()');
const end = experience.indexOf('function cancelHold(', start);
assert.ok(start >= 0 && end > start, 'the real result and reset functions must be available');

// Execute the production transitions, replacing only the browser and gesture
// boundaries. A renderer, camera, and real clock are unnecessary for this flow.
function resultHarness(overrides = {}) {
  const elements = new Map(), focusCalls = [], scrollCalls = [], classes = new Set();
  const calls = { dwell: 0, toss: 0, art: 0 };
  const document = { activeElement: null };
  const insideResult = new Set(['throw-result', 'throw-result-title', 'exhibit-artwork', 'retry-throw', 'edit-result']);
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: false, open: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
      contains: node => id === 'throw-result' && insideResult.has(node?.id),
      focus(options) { document.activeElement = this; focusCalls.push({ id, preventScroll: options?.preventScroll }); },
      scrollIntoView(options) { scrollCalls.push({ id, block: options?.block }); },
    });
    return elements.get(id);
  };
  element('throw-result').hidden = true;
  element('settings').hidden = true;
  document.activeElement = element('outside');
  const context = vm.createContext({
    $: element, document,
    source: 'mouse', phase: 'worn', carving: false, loading: false,
    wornSince: 1000, receiver: { x: 900, y: 280 },
    heldPose: {}, flight: {}, smoothTarget: {}, mouseTrackedFace: {}, controlHand: {},
    gripped: true, pinched: true, pointer: 1,
    rememberedRoles: { caster: {}, receiver: {} }, pendingRelease: {},
    handMotion: { reset() {} },
    softFollow: { reset() {} },
    dwell: { reset() { calls.dwell++; } },
    toss: { cancel() { calls.toss++; } },
    art: { cancel() { calls.art++; } },
    ...overrides,
  });
  vm.runInContext(experience.slice(start, end), context);
  return {
    element, context, document, classes, calls, focusCalls, scrollCalls,
    run: code => vm.runInContext(code, context),
    update: time => context.updateThrowResult(time),
    reset: () => context.resetRound(),
  };
}

test('a successful worn pumpkin waits 1200 ms before offering exhibition in either playable mode', () => {
  for (const source of ['mouse', 'camera']) {
    const h = resultHarness({ source });
    h.update(1000); h.update(2199);
    assert.equal(h.element('throw-result').hidden, true);
    assert.equal(h.focusCalls.length, 0);
    h.update(2200);
    assert.equal(h.element('throw-result').hidden, false);
    assert.equal(h.classes.has('throw-complete'), true);
    assert.deepEqual(h.focusCalls, [{ id: 'throw-result-title', preventScroll: true }]);
    assert.deepEqual(h.scrollCalls, [{ id: 'throw-result', block: 'nearest' }]);
    assert.equal(h.calls.dwell, 1, 'a previous hand dwell cannot carry into the result panel');
  }
});

test('guide, carving, loading, unfinished throws, and a missing receiver never offer exhibition', () => {
  const blockedStates = [
    { source: 'guide' }, { carving: true }, { loading: true },
    ...['waiting', 'ready', 'held', 'flying'].map(phase => ({ phase })),
    { receiver: null },
  ];
  for (const state of blockedStates) {
    const h = resultHarness(state);
    h.update(10000);
    assert.equal(h.element('throw-result').hidden, true, JSON.stringify(state));
    assert.equal(h.classes.has('throw-complete'), false);
    assert.equal(h.focusCalls.length, 0);
    assert.equal(h.scrollCalls.length, 0);
    assert.equal(h.calls.dwell, 0);
  }
});

test('losing the receiver before the reveal defers it until the face returns', () => {
  const h = resultHarness({ source: 'camera' });
  h.update(2199);
  h.context.receiver = null;
  h.update(2200); h.update(5000);
  assert.equal(h.element('throw-result').hidden, true);
  h.context.receiver = { x: 900, y: 280 };
  h.update(5100);
  assert.equal(h.element('throw-result').hidden, false);
  assert.equal(h.focusCalls.length, 1);
});

test('settings, setup and sharing defer the reveal without losing it or stealing focus', () => {
  for (const dialog of ['settings', 'setup-dialog', 'share-dialog']) {
    const h = resultHarness();
    const panel = h.element(dialog);
    if (dialog === 'settings') panel.hidden = false;
    else panel.open = true;
    h.document.activeElement = panel;
    h.update(2200); h.update(6000);
    assert.equal(h.element('throw-result').hidden, true);
    assert.equal(h.document.activeElement, panel);
    assert.equal(h.focusCalls.length, 0);
    panel.hidden = true; panel.open = false;
    h.update(6016);
    assert.equal(h.element('throw-result').hidden, false);
    assert.equal(h.focusCalls.length, 1);
  }
});

test('later animation frames do not refocus or scroll an already visible result', () => {
  const h = resultHarness();
  h.update(2200);
  h.document.activeElement = h.element('exhibit-artwork');
  for (let time = 2216; time <= 4000; time += 16) h.update(time);
  assert.equal(h.document.activeElement, h.element('exhibit-artwork'));
  assert.equal(h.focusCalls.length, 1);
  assert.equal(h.scrollCalls.length, 1);
  assert.equal(h.calls.dwell, 1);
});

test('reset hides the result and clears the round, then a later completed throw can reveal it again', () => {
  for (const source of ['mouse', 'camera']) {
    const h = resultHarness({ source });
    h.update(2200);
    h.document.activeElement = h.element('retry-throw');
    h.reset();
    assert.equal(h.element('throw-result').hidden, true);
    assert.equal(h.classes.has('throw-complete'), false);
    assert.equal(h.element('restart').hidden, true);
    assert.equal(h.context.phase, 'ready');
    assert.equal(h.document.activeElement, h.element('cue-title'));
    for (const key of ['heldPose', 'flight', 'smoothTarget', 'mouseTrackedFace', 'controlHand', 'pointer']) assert.equal(h.context[key], null, key);
    assert.equal(h.context.gripped, false);
    assert.equal(h.context.pinched, false);
    assert.equal(h.context.rememberedRoles.caster, null);
    assert.equal(h.context.rememberedRoles.receiver, null);
    assert.equal(h.context.pendingRelease, null);
    assert.equal(h.calls.toss, 1);
    assert.equal(h.calls.art, 1);
    h.update(10000);
    assert.equal(h.element('throw-result').hidden, true, 'elapsed time alone cannot count as another throw');
    h.context.phase = 'flying';
    h.update(11000);
    assert.equal(h.element('throw-result').hidden, true);
    h.context.phase = 'worn'; h.context.wornSince = 12000;
    h.update(13199);
    assert.equal(h.element('throw-result').hidden, true);
    h.update(13200);
    assert.equal(h.element('throw-result').hidden, false);
    assert.equal(h.focusCalls.filter(call => call.id === 'throw-result-title').length, 2);
    assert.equal(h.scrollCalls.length, 2);
  }
});

test('hiding a result does not move focus when it is already outside the panel', () => {
  const h = resultHarness();
  h.update(2200);
  h.document.activeElement = h.element('outside');
  h.reset();
  assert.equal(h.document.activeElement, h.element('outside'));
  assert.equal(h.focusCalls.length, 1);
  h.reset();
  assert.equal(h.focusCalls.length, 1, 'resetting an already hidden panel must not steal focus');
});
