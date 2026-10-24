import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const startup = readFileSync(new URL('../public/startup.js', import.meta.url), 'utf8');
const importCall = "import('./experience.mjs?v=20261025-share')";
assert.equal(startup.split(importCall).length, 2, 'replace only the real module import boundary');
const executable = startup.replace(importCall, "importExperience('./experience.mjs?v=20261025-share')");

function startupHarness(protocol = 'https:') {
  const elements = new Map(), listeners = new Map(), timers = new Map(), imports = [];
  let timerId = 0, reloads = 0, resolveImport, rejectImport;
  const importing = new Promise((resolve, reject) => { resolveImport = resolve; rejectImport = reject; });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, open: false, textContent: '', listeners: new Map(),
      addEventListener(type, callback) { this.listeners.set(type, callback); },
    });
    return elements.get(id);
  };
  const window = {
    location: { protocol, reload() { reloads++; } },
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(executable, {
    window, document: { getElementById: element },
    importExperience(specifier) { imports.push(specifier); return importing; },
  });
  return {
    element, timers, imports, resolveImport, rejectImport,
    emit(type, detail) { listeners.get(type)?.({ detail }); },
    expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback()); },
    reload() { element('startup-reload').listeners.get('click')(); },
    get reloads() { return reloads; },
  };
}

test('opening a saved HTML file gives a public URL instruction without importing the app', () => {
  const h = startupHarness('file:');
  assert.equal(h.imports.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.element('startup-status').hidden, false);
  assert.match(h.element('startup-title').textContent, /公開URL/);
  assert.match(h.element('startup-detail').textContent, /保存したHTML/);
  assert.equal(h.element('startup-reload').hidden, true);
  assert.equal(h.element('startup-diagnostics').hidden, true);
  h.emit('pumpkin-ready');
  assert.equal(h.element('startup-status').hidden, false, 'an unrelated event cannot dismiss the file-opening instruction');
});

test('HTTP and HTTPS import rejection shows a readable error and clears the wait timer', async () => {
  for (const protocol of ['http:', 'https:']) {
    const h = startupHarness(protocol);
    assert.deepEqual(h.imports, ['./experience.mjs?v=20261025-share']);
    h.rejectImport(new TypeError('Failed to fetch dynamically imported module'));
    await Promise.resolve();
    assert.equal(h.element('startup-status').hidden, false);
    assert.match(h.element('startup-title').textContent, /読み込めません/);
    assert.equal(h.element('startup-diagnostics').hidden, false);
    assert.equal(h.element('startup-error').textContent, 'TypeError: Failed to fetch dynamically imported module');
    assert.equal(h.timers.size, 0);
    h.reload();
    assert.equal(h.reloads, 1);
  }
});

test('the 15-second hint does not cancel loading and only a first rendered frame dismisses it', async () => {
  const h = startupHarness();
  assert.equal([...h.timers.values()][0].delay, 15000);
  h.expire();
  assert.match(h.element('startup-title').textContent, /時間がかかっています/);
  assert.equal(h.element('startup-diagnostics').hidden, true);
  assert.equal(h.imports.length, 1, 'a slow connection must not start duplicate app instances');
  h.resolveImport();
  await Promise.resolve();
  assert.equal(h.element('startup-status').hidden, false, 'module evaluation is not proof of a rendered frame');
  h.emit('pumpkin-ready');
  assert.equal(h.element('startup-status').hidden, true);
  assert.equal(h.timers.size, 0);
});

test('a first-frame failure displays its diagnostic as text and cannot be overwritten by the wait hint', () => {
  const h = startupHarness();
  h.emit('pumpkin-startup-error', { error: new Error('<canvas failed>') });
  assert.equal(h.element('startup-status').hidden, false);
  assert.match(h.element('startup-title').textContent, /画面を表示できません/);
  assert.equal(h.element('startup-error').textContent, 'Error: <canvas failed>');
  assert.equal(h.element('startup-diagnostics').hidden, false);
  assert.equal(h.timers.size, 0);
  h.expire();
  assert.match(h.element('startup-title').textContent, /画面を表示できません/);
});

test('successful first-frame notification clears the timer and later startup errors do not cover the app', async () => {
  const h = startupHarness();
  h.emit('pumpkin-ready');
  assert.equal(h.timers.size, 0);
  assert.equal(h.element('startup-status').hidden, true);
  h.emit('pumpkin-startup-error', { error: new Error('late error') });
  h.rejectImport(new Error('late import error'));
  await Promise.resolve();
  assert.equal(h.element('startup-status').hidden, true);
  assert.equal(h.element('startup-error').textContent, '');
});
