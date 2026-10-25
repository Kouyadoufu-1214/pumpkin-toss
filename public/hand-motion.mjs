// Visual compensation only. Throw recognition must keep using the raw camera
// observations, never these extrapolated screen coordinates.
const PREDICTION_MS = 90;
const MAX_DISTANCE = 160;
const STALE_MS = 500;
const MAX_GAP_MS = 650;

export class HandMotion {
  constructor() { this.reset(); }

  reset() { this.previous = this.current = null; }

  observe(point, captureTime) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
      || !Number.isFinite(captureTime) || captureTime < 0
      || (this.current && captureTime <= this.current.time)) {
      this.reset(); return false;
    }
    const previous = this.current;
    this.previous = previous && captureTime - previous.time <= MAX_GAP_MS ? previous : null;
    this.current = { x: point.x, y: point.y, time: captureTime };
    return true;
  }

  position(renderTime) {
    const point = this.current;
    if (!point || !Number.isFinite(renderTime) || renderTime < 0 || renderTime - point.time > STALE_MS) return null;
    const result = { x: point.x, y: point.y }, previous = this.previous;
    if (!previous) return result;
    const dx = point.x - previous.x, dy = point.y - previous.y, distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance === 0) return result;
    // A tiny timestamp interval must not turn subpixel noise into a large jump.
    const duration = Math.max(16, point.time - previous.time);
    const ahead = Math.max(0, Math.min(PREDICTION_MS, renderTime - point.time));
    const reach = Math.min(MAX_DISTANCE, distance / duration * ahead);
    result.x += dx / distance * reach;
    result.y += dy / distance * reach;
    return result;
  }
}

// A small, time-based visual lag hides uneven inference intervals. This never
// feeds back into gesture recognition or the recorded camera coordinates.
export class SoftFollow {
  constructor(smoothingMs = 65) { this.configure(smoothingMs); this.reset(); }
  configure(value) { this.smoothingMs = Number.isFinite(value) ? Math.max(0, Math.min(160, value)) : 65; }
  reset() { this.point = null; this.time = null; }
  follow(target, time) {
    if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y) || !Number.isFinite(time)) return null;
    if (!this.point || !this.smoothingMs || time < this.time || time - this.time > 250) {
      this.point = { x: target.x, y: target.y }; this.time = time; return { ...this.point };
    }
    const blend = 1 - Math.exp(-(time - this.time) / this.smoothingMs);
    this.point.x += (target.x - this.point.x) * blend;
    this.point.y += (target.y - this.point.y) * blend;
    // Softness must not let a fast-moving pumpkin trail the hand indefinitely.
    const dx = target.x - this.point.x, dy = target.y - this.point.y, lag = Math.hypot(dx, dy);
    if (lag > 90) { this.point.x = target.x - dx / lag * 90; this.point.y = target.y - dy / lag * 90; }
    this.time = time;
    return { ...this.point };
  }
}
