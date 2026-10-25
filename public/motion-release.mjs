const MIN_WINDOW_MS = 25;
const MAX_GAP_MS = 650;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);

// Receives only real observations of the selected hand. Rendered positions,
// missing-hand results and face frames must never advance this counter.
export class MotionRelease {
  constructor(options = {}) {
    this.requiredFrames = 3;
    this.minSpeed = 160;
    this.reset();
    this.configure(options);
  }

  configure(options = {}) {
    const requiredFrames = Number.isFinite(options?.motionFrames)
      ? Math.round(Math.min(8, Math.max(2, options.motionFrames))) : this.requiredFrames;
    const minSpeed = Number.isFinite(options?.minSpeed)
      ? Math.min(600, Math.max(80, options.minSpeed)) : this.minSpeed;
    if (requiredFrames !== this.requiredFrames || minSpeed !== this.minSpeed) {
      this.requiredFrames = requiredFrames;
      this.minSpeed = minSpeed;
      this.reset();
    }
    return this;
  }

  reset() {
    this.lastTime = null;
    this.clearEvidence();
  }

  clearEvidence() {
    this.frames = 0;
    this.anchor = null;
    this.direction = 0;
  }

  get progress() { return this.frames / this.requiredFrames; }

  observe({ point, time, target, valid = true } = {}, now) {
    if (!Number.isFinite(time) || !Number.isFinite(now) || time > now || now - time > MAX_GAP_MS
      || this.lastTime !== null && time <= this.lastTime) {
      // Keep the chronological watermark even when discarding bad evidence.
      // A replay cannot become a new movement sequence after this rejection.
      this.clearEvidence();
      return false;
    }
    const previousTime = this.lastTime;
    this.lastTime = time;
    if (!valid || !finitePoint(point) || !finitePoint(target)) {
      this.clearEvidence();
      return false;
    }
    const direction = Math.sign(target.x - point.x);
    if (!direction) {
      this.clearEvidence();
      return false;
    }
    if (!this.anchor || direction !== this.direction || previousTime !== null && time - previousTime > MAX_GAP_MS) {
      this.clearEvidence();
      this.anchor = { x: point.x, y: point.y, time };
      this.direction = direction;
      return false;
    }
    const duration = time - this.anchor.time;
    // Tiny high-FPS steps form one independent observation window. These
    // windows never overlap, so one large jump cannot supply several counts.
    if (duration < MIN_WINDOW_MS) return false;
    const travel = (point.x - this.anchor.x) * direction;
    const vertical = Math.abs(point.y - this.anchor.y);
    this.anchor = { x: point.x, y: point.y, time };
    const moving = travel >= 2 && travel >= vertical && travel / (duration / 1000) >= this.minSpeed;
    this.frames = moving ? Math.min(this.requiredFrames, this.frames + 1) : 0;
    return moving && this.frames === this.requiredFrames;
  }
}
