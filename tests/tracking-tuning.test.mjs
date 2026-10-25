import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRACKING_TUNING, normalizeTrackingTuning } from '../public/tracking-tuning.mjs';

test('calibration defaults are immutable and normalization returns an independent complete value', () => {
  const expected = { minSpeed: 160, minDistance: 32, openConfirmMs: 40, gestureConfidence: .7, smoothingMs: 65, quality: 'auto' };
  assert.deepEqual(DEFAULT_TRACKING_TUNING, expected);
  assert.equal(Object.isFrozen(DEFAULT_TRACKING_TUNING), true);
  const normalized = normalizeTrackingTuning();
  assert.deepEqual(normalized, expected);
  assert.notEqual(normalized, DEFAULT_TRACKING_TUNING);
  normalized.minSpeed = 600;
  assert.deepEqual(normalizeTrackingTuning(), expected);
});

test('calibration bounds preserve zero confirmation and smoothing without allowing disabled motion thresholds', () => {
  const low = { minSpeed: 0, minDistance: -10, openConfirmMs: -1, gestureConfidence: 0, smoothingMs: -10, quality: 'light' };
  assert.deepEqual(normalizeTrackingTuning(low),
    { minSpeed: 80, minDistance: 20, openConfirmMs: 0, gestureConfidence: .5, smoothingMs: 0, quality: 'light' });
  const high = { minSpeed: 1000, minDistance: 500, openConfirmMs: 500, gestureConfidence: 1, smoothingMs: 500, quality: 'high' };
  assert.deepEqual(normalizeTrackingTuning(high),
    { minSpeed: 600, minDistance: 160, openConfirmMs: 180, gestureConfidence: .95, smoothingMs: 160, quality: 'high' });
  for (const normalized of [normalizeTrackingTuning(low), normalizeTrackingTuning(high)]) {
    assert.deepEqual(normalizeTrackingTuning(normalized), normalized, 'exact bounds survive a settings reload');
  }
});

test('invalid saved calibration falls back safely without coercing strings, nulls or unknown quality modes', () => {
  for (const invalid of [null, undefined, true, '160', [], 0]) {
    assert.deepEqual(normalizeTrackingTuning(invalid), DEFAULT_TRACKING_TUNING);
  }
  for (const invalid of [NaN, Infinity, -Infinity, null, '0', false, {}, []]) {
    assert.deepEqual(normalizeTrackingTuning({ minSpeed: invalid, minDistance: invalid, openConfirmMs: invalid,
      gestureConfidence: invalid, smoothingMs: invalid, quality: invalid }), DEFAULT_TRACKING_TUNING);
  }
  assert.equal(normalizeTrackingTuning({ quality: 'ultra' }).quality, 'auto');
});

test('partial calibration keeps valid values, drops unknown keys and never mutates its input', () => {
  const input = Object.freeze({ gestureConfidence: .625, quality: 'light', unknown: 'ignored' });
  assert.deepEqual(normalizeTrackingTuning(input), { ...DEFAULT_TRACKING_TUNING, gestureConfidence: .625, quality: 'light' });
});
