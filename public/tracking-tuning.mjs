export const DEFAULT_TRACKING_TUNING = Object.freeze({
  minSpeed: 160,
  minDistance: 32,
  openConfirmMs: 40,
  gestureConfidence: .70,
  smoothingMs: 65,
  quality: 'auto',
});

// Values may come from a saved calibration. Reject non-numeric values rather
// than letting strings, null or infinities silently turn off a motion gate.
export function normalizeTrackingTuning(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const number = (key, min, max) => Number.isFinite(source[key])
    ? Math.min(max, Math.max(min, source[key])) : DEFAULT_TRACKING_TUNING[key];
  return {
    minSpeed: number('minSpeed', 80, 600),
    minDistance: number('minDistance', 20, 160),
    openConfirmMs: number('openConfirmMs', 0, 180),
    gestureConfidence: number('gestureConfidence', .50, .95),
    smoothingMs: number('smoothingMs', 0, 160),
    quality: ['auto', 'light', 'high'].includes(source.quality) ? source.quality : DEFAULT_TRACKING_TUNING.quality,
  };
}
