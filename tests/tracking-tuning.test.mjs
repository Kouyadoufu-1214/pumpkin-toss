import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRACKING_TUNING, normalizeTrackingTuning } from '../public/tracking-tuning.mjs';

test('calibration defaults are immutable and normalization returns an independent complete value', () => {
  const expected = { minSpeed: 160, minDistance: 32, motionFrames: 3, smoothingMs: 65, quality: 'auto' };
  assert.deepEqual(DEFAULT_TRACKING_TUNING, expected);
  assert.equal(Object.isFrozen(DEFAULT_TRACKING_TUNING), true);
  const normalized = normalizeTrackingTuning();
  assert.deepEqual(normalized, expected);
  assert.notEqual(normalized, DEFAULT_TRACKING_TUNING);
  normalized.minSpeed = 600;
  assert.deepEqual(normalizeTrackingTuning(), expected);
});

test('calibration bounds preserve zero smoothing without allowing disabled motion thresholds', () => {
  const low = { minSpeed: 0, minDistance: -10, motionFrames: -1, smoothingMs: -10, quality: 'light' };
  assert.deepEqual(normalizeTrackingTuning(low),
    { minSpeed: 80, minDistance: 20, motionFrames: 2, smoothingMs: 0, quality: 'light' });
  const high = { minSpeed: 1000, minDistance: 500, motionFrames: 500, smoothingMs: 500, quality: 'high' };
  assert.deepEqual(normalizeTrackingTuning(high),
    { minSpeed: 600, minDistance: 160, motionFrames: 8, smoothingMs: 160, quality: 'high' });
  for (const normalized of [normalizeTrackingTuning(low), normalizeTrackingTuning(high)]) {
    assert.deepEqual(normalizeTrackingTuning(normalized), normalized, 'exact bounds survive a settings reload');
  }
});

test('invalid saved calibration falls back safely without coercing strings, nulls or unknown quality modes', () => {
  for (const invalid of [null, undefined, true, '160', [], 0]) {
    assert.deepEqual(normalizeTrackingTuning(invalid), DEFAULT_TRACKING_TUNING);
  }
  for (const invalid of [NaN, Infinity, -Infinity, null, '0', false, {}, []]) {
    assert.deepEqual(normalizeTrackingTuning({ minSpeed: invalid, minDistance: invalid, motionFrames: invalid,
      smoothingMs: invalid, quality: invalid }), DEFAULT_TRACKING_TUNING);
  }
  assert.equal(normalizeTrackingTuning({ quality: 'ultra' }).quality, 'auto');
});

test('partial calibration keeps valid values, drops unknown keys and never mutates its input', () => {
  const input = Object.freeze({ motionFrames: 4.6, quality: 'light', unknown: 'ignored' });
  assert.deepEqual(normalizeTrackingTuning(input), { ...DEFAULT_TRACKING_TUNING, motionFrames: 5, quality: 'light' });
});

test('legacy palm settings cannot alter the new motion confirmation or survive a settings reload', () => {
  const legacy = Object.freeze({ openConfirmMs: 180, gestureConfidence: .95, minSpeed: 200, smoothingMs: 0 });
  const normalized = normalizeTrackingTuning(legacy);
  assert.deepEqual(normalized, { ...DEFAULT_TRACKING_TUNING, minSpeed: 200, smoothingMs: 0 });
  assert.equal('openConfirmMs' in normalized, false);
  assert.equal('gestureConfidence' in normalized, false);
  for (const value of [2.1, 3, 5.8, 7.9]) {
    const settings = normalizeTrackingTuning({ motionFrames: value });
    assert.equal(Number.isInteger(settings.motionFrames), true);
    assert.deepEqual(normalizeTrackingTuning(settings), settings);
  }
});
