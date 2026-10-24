import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_APP_URL, setupShareControls } from '../public/share-link.mjs';

function fixture(navigator = {}) {
  const elements = {};
  for (const id of ['share-button', 'share-dialog', 'close-share', 'share-url', 'copy-share', 'share-status', 'share-open']) {
    const listeners = new Map();
    elements[id] = {
      value: '', textContent: '', href: '', disabled: false, open: false,
      focused: false, selected: false,
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
      dispatch(type) { return listeners.get(type)?.(); },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch('close'); },
      focus() { this.focused = true; },
      select() { this.selected = true; },
    };
  }
  const document = {
    location: { href: 'file:///private/local/index.html#participant-draft' },
    getElementById: id => elements[id],
  };
  const dispose = setupShareControls({ document, navigator });
  return { elements, dispose, click: id => elements[id].dispatch('click') };
}

test('share controls always present and copy the public app URL', async () => {
  const writes = [];
  const { elements: e, click } = fixture({ clipboard: { writeText: async value => writes.push(value) } });
  assert.equal(PUBLIC_APP_URL, 'https://kouyadoufu-1214.github.io/pumpkin-toss/');
  click('share-button');
  assert.equal(e['share-dialog'].open, true);
  assert.equal(e['share-url'].value, PUBLIC_APP_URL);
  assert.equal(e['share-open'].href, PUBLIC_APP_URL);
  await click('copy-share');
  assert.deepEqual(writes, [PUBLIC_APP_URL]);
  assert.equal(e['share-status'].textContent, '共有URLをコピーしました。メッセージに貼り付けて送れます。');
  assert.equal(e['copy-share'].disabled, false);
  click('close-share');
  assert.equal(e['share-dialog'].open, false);
  click('share-button');
  assert.equal(e['share-status'].textContent, '');
});

for (const [description, navigator] of [
  ['clipboard access is rejected', { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } }],
  ['clipboard is unavailable', {}],
]) {
  test(`manual copying remains available when ${description}`, async () => {
    const { elements: e, click } = fixture(navigator);
    click('share-button');
    await click('copy-share');
    assert.equal(e['share-url'].value, PUBLIC_APP_URL);
    assert.equal(e['share-url'].focused, true);
    assert.equal(e['share-url'].selected, true);
    assert.equal(e['share-status'].textContent, 'URLを選択しました。Ctrl+Cでコピーしてください。');
    assert.equal(e['copy-share'].disabled, false);
  });
}

test('pending copies ignore duplicate clicks and cannot overwrite a reopened dialog', async () => {
  const writes = [];
  const { elements: e, click } = fixture({ clipboard: { writeText: () => new Promise(resolve => writes.push(resolve)) } });
  click('share-button');
  const firstCopy = click('copy-share');
  await click('copy-share');
  assert.equal(writes.length, 1);
  assert.equal(e['copy-share'].disabled, true);
  click('close-share');
  click('share-button');
  // Native dialogs may dispatch an old close event after being reopened.
  e['share-dialog'].dispatch('close');
  const secondCopy = click('copy-share');
  assert.equal(writes.length, 2);
  writes[0]();
  await firstCopy;
  assert.equal(e['share-status'].textContent, '');
  assert.equal(e['copy-share'].disabled, true);
  writes[1]();
  await secondCopy;
  assert.match(e['share-status'].textContent, /コピーしました/);
  assert.equal(e['copy-share'].disabled, false);
});

test('Escape invalidates a pending clipboard failure without stealing focus', async () => {
  let rejectCopy;
  const { elements: e, click } = fixture({ clipboard: { writeText: () => new Promise((resolve, reject) => { rejectCopy = reject; }) } });
  click('share-button');
  const pending = click('copy-share');
  e['share-dialog'].dispatch('cancel');
  e['share-dialog'].close();
  rejectCopy(new Error('denied'));
  await pending;
  assert.equal(e['share-status'].textContent, '');
  assert.equal(e['share-url'].focused, false);
  assert.equal(e['copy-share'].disabled, false);
});
