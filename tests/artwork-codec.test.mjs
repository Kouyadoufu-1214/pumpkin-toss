import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { encodeMask, decodeMask, validateArtwork, MAX_MASK_LENGTH, MAX_GALLERY_MASK_LENGTH } from '../public/artwork-codec.mjs';
import { FreehandStroke } from '../public/carving-path.mjs';

test('blank, holes and partially scraped skin survive a gallery round trip exactly', () => {
  const source = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 100; y < 300; y++) for (let x = 80; x < 280; x++) source[(y * 512 + x) * 4 + 3] = [0, 76, 130, 255][x % 4];
  const restored = decodeMask(encodeMask(source));
  for (let i = 3; i < source.length; i += 4) assert.equal(restored[i], source[i]);
  assert.equal(decodeMask(encodeMask(new Uint8ClampedArray(512 * 512 * 4))).length, source.length);
});
test('oversized, truncated and invalid runs cannot allocate arbitrary surfaces', () => {
  for (const invalid of ['', '!!!!', 'AAAA', 'AAH/', 'A'.repeat(MAX_MASK_LENGTH + 4), 'AP//']) assert.throws(() => decodeMask(invalid));
  assert.throws(() => validateArtwork({ version: 1, shape: '<script>', mask: 'AAAA' }));
  assert.throws(() => validateArtwork({ version: 2, shape: 'round', mask: 'AAAA' }));
});

function detailedSurface() {
  const data = new Uint8ClampedArray(512 * 512 * 4);
  for (let pixel = 0; pixel < 512 * 512; pixel++) data[pixel * 4 + 3] = pixel % 2 ? 255 : 76;
  return data;
}

test('a maximum-detail surface can be saved locally and restored without losing any alpha values', () => {
  const source = detailedSurface(), mask = encodeMask(source);
  assert.equal(mask.length, MAX_MASK_LENGTH);
  assert.ok(mask.length > MAX_GALLERY_MASK_LENGTH);
  const restored = decodeMask(validateArtwork(JSON.parse(JSON.stringify({ version: 1, shape: 'tall', mask }))).mask);
  for (let i = 3; i < source.length; i += 4) assert.equal(restored[i], source[i]);
});

// Run the real save and handoff functions with browser boundaries replaced by
// in-memory storage/downloads. No renderer or camera is needed for these paths.
const experience = readFileSync(new URL('../public/experience.mjs', import.meta.url), 'utf8');
function saveHarness(initial = new Uint8ClampedArray(512 * 512 * 4)) {
  let visible = { data: initial };
  const saved = new Map(), timers = new Map(), elements = new Map(), downloads = [], opened = [], messages = [], blobs = [];
  const art = {
    base: null,
    ctx: { getImageData: () => visible },
    cancel() { if (this.base) visible = this.base; this.base = null; },
  };
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  let nextTimer = 0;
  const context = vm.createContext({
    art, shape: 'round', encodeMask, decodeMask, validateArtwork, MAX_GALLERY_MASK_LENGTH,
    GALLERY_URL: 'https://gallery.example/', $: element, Blob,
    localStorage: { setItem: (key, value) => saved.set(key, value), getItem: key => saved.get(key) },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    URL: { createObjectURL: blob => { blobs.push(blob); return `blob:test-${blobs.length}`; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); } }) },
    window: { open: (...args) => opened.push(args) }, notice: message => messages.push(message),
  });
  vm.runInContext(experience.slice(experience.indexOf('const DRAFT_KEY ='), experience.indexOf('function restoreDraft()')), context);
  vm.runInContext(experience.slice(experience.indexOf("$('exhibit-artwork').onclick ="), experience.indexOf("document.querySelectorAll('[data-carve-mode]').forEach(button => button.onclick")), context);
  return {
    art, saved, downloads, opened, messages, blobs,
    run: code => vm.runInContext(code, context),
    beginStroke(data) { art.base = visible; visible = { data }; },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    exhibit: () => element('exhibit-artwork').onclick(),
  };
}

test('a queued save excludes a newer uncommitted stroke and its preview markers', () => {
  const committed = new Uint8ClampedArray(512 * 512 * 4);
  committed[3] = 76;
  const harness = saveHarness(committed);
  harness.run('queueDraft()');
  harness.beginStroke(detailedSurface());
  harness.flushTimers();
  const saved = JSON.parse(harness.saved.get('pumpkin-toss-artwork-v1'));
  assert.equal(saved.mask, encodeMask(committed));
  assert.ok(harness.art.base, 'saving must not cancel a gesture still being drawn');
});

test('a surface too detailed for the gallery is retained locally and can still be downloaded', async () => {
  const harness = saveHarness(detailedSurface());
  harness.exhibit();
  assert.equal(harness.opened.length, 0, 'unsupported artwork must not be sent to the gallery');
  assert.match(harness.messages.at(-1), /作品ファイルを保存/);
  const saved = JSON.parse(harness.saved.get('pumpkin-toss-artwork-v1'));
  assert.equal(saved.mask.length, MAX_MASK_LENGTH);
  harness.run('downloadArtwork()');
  assert.equal(harness.downloads.length, 1);
  assert.deepEqual(JSON.parse(await harness.blobs[0].text()), saved);
});

test('normal gallery handoffs retain direct links and the supported file fallback', async () => {
  const small = saveHarness(); small.exhibit();
  assert.match(small.opened[0][0], /\?submit=1#draft=/);
  assert.equal(small.downloads.length, 0);

  const mediumSurface = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 100; y < 220; y++) for (let x = 100; x < 220; x++) mediumSurface[(y * 512 + x) * 4 + 3] = x % 2 ? 255 : 76;
  const medium = saveHarness(mediumSurface); medium.exhibit();
  assert.equal(medium.opened[0][0], 'https://gallery.example/?submit=1');
  assert.equal(medium.downloads.length, 1);
  const draft = JSON.parse(await medium.blobs[0].text());
  assert.ok(draft.mask.length <= MAX_GALLERY_MASK_LENGTH);
  assert.equal(draft.mask, encodeMask(mediumSurface));
});
test('scraping and filling accept a tap, but a tracking gap never carves', () => {
  for (const mode of ['scrape', 'restore']) {
    const stroke = new FreehandStroke(); stroke.add({ x: 256, y: 256 });
    assert.equal(stroke.finish({ mode }).kind, 'cut');
    stroke.add(null); assert.equal(stroke.finish({ mode }).kind, 'interrupted');
  }
});
