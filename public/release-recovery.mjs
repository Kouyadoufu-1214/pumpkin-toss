const EVIDENCE_MS = 220;
const MISSING_MS = 180;
const FRESH_MS = 200;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const fresh = (time, now) => Number.isFinite(time) && Number.isFinite(now)
  && now >= time && now - time <= FRESH_MS;
const copyPose = pose => pose && typeof pose === 'object' ? { ...pose } : null;

// This buffer receives only real observations of the hand already holding the
// pumpkin. It never extrapolates a position or releases from a render timer.
export class ReleaseRecovery {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.candidate = null;
    this.lastTime = null;
    this.anchor = null;
    this.direction = 0;
  }

  acceptTime(time, now) {
    if (!fresh(time, now) || (this.lastTime !== null && time <= this.lastTime)) {
      this.reset();
      return false;
    }
    this.lastTime = time;
    return true;
  }

  clearEvidence() {
    this.samples = [];
    this.candidate = null;
    this.anchor = null;
    this.direction = 0;
  }

  observe({ point, time, shape, cropped, metrics, target, from } = {}, now) {
    if (!this.acceptTime(time, now)) return;
    if (!finitePoint(point) || !finitePoint(target) || cropped
      || !Number.isFinite(shape?.openness) || shape.openness < 0 || shape.openness > 1) {
      this.clearEvidence();
      return;
    }

    const previous = this.samples.at(-1);
    if (previous && time - previous.time > MISSING_MS) this.clearEvidence();
    if (this.anchor !== null && Math.sign(target.x - this.anchor) !== this.direction) {
      this.clearEvidence();
      return;
    }
    if (this.anchor === null) {
      this.anchor = point.x;
      this.direction = Math.sign(target.x - point.x);
    }
    if (!this.direction) { this.clearEvidence(); return; }

    // Small landmark jitter must not erase a real swing. Compare with the
    // recent furthest position, so a gradual backswing still clears evidence.
    const reversed = this.samples.some(item => time - item.time <= EVIDENCE_MS
      && (item.point.x - point.x) * this.direction > 32);
    if (reversed) {
      // A new backswing cannot borrow the earlier swing's opening evidence.
      this.clearEvidence();
      this.anchor = point.x;
      this.direction = Math.sign(target.x - point.x);
    }
    const sample = { point: { ...point }, time, shape: { ...shape } };
    this.samples = this.samples.filter(item => time - item.time <= EVIDENCE_MS);
    this.samples.push(sample);

    // Visible contradictions replace eligibility immediately. A candidate is
    // never a delayed command that survives a newly closed or stationary hand.
    const previousCandidate = this.candidate;
    this.candidate = null;
    if (reversed || !metrics?.ok || shape.grip) return;

    if (shape.open) {
      this.candidate = previousCandidate?.kind === 'observed-open'
        && fresh(previousCandidate.time, now)
        ? previousCandidate
        : { point: { ...point }, time, from: copyPose(from), kind: 'observed-open' };
      return;
    }

    if (!(shape.extendedFingers >= 3 && shape.openness >= .85)) return;
    const curled = this.samples.some(item => item.time < time && item.shape.grip
      && shape.openness - item.shape.openness >= .1 - 1e-12);
    if (!curled) return;

    // Two real forward windows are needed, including the newest window.
    // Aggregate high-rate samples over at least 25ms instead of rejecting
    // individual frames shorter than 15ms. Windows do not overlap, so a single
    // landmark jump cannot provide both pieces of swing evidence.
    let segments = 0, travel = 0, vertical = 0, elapsed = 0;
    for (let index = this.samples.length - 1; index > 0;) {
      const last = this.samples[index];
      let firstIndex = index - 1;
      while (firstIndex >= 0 && last.time - this.samples[firstIndex].time < 25) firstIndex--;
      if (firstIndex < 0) break;
      const first = this.samples[firstIndex];
      const gap = last.time - first.time;
      const dx = (last.point.x - first.point.x) * this.direction;
      let dy = 0;
      for (let step = firstIndex + 1; step <= index; step++) {
        dy += Math.abs(this.samples[step].point.y - this.samples[step - 1].point.y);
      }
      if (gap > 160 || dx < 8 || dx < dy) break;
      segments++;
      travel += dx;
      vertical += dy;
      elapsed += gap;
      index = firstIndex;
    }
    if (segments < 2 || travel < 100 || travel < vertical || travel / elapsed * 1000 < 700) return;
    this.candidate = { point: { ...point }, time, from: copyPose(from), kind: 'opening-swing' };
  }

  // Call only for an actual missing-hand inference result, not a face-only
  // result, skipped inference, worker stall or lost animation frame. A short
  // absence can complete observed release evidence; absence alone cannot.
  recover(time, now, target, confirmMs = 40) {
    if (!this.acceptTime(time, now)) return null;
    const last = this.samples.at(-1), candidate = this.candidate;
    if (!finitePoint(target) || (this.anchor !== null
      && Math.sign(target.x - this.anchor) !== this.direction)) {
      this.clearEvidence();
      return null;
    }
    if (!last || !candidate) return null;
    const gap = time - last.time;
    if (gap > MISSING_MS || !fresh(last.time, now) || !fresh(candidate.time, now)) {
      this.clearEvidence();
      return null;
    }
    const confirmation = Math.max(40, Number.isFinite(confirmMs) ? confirmMs : 40);
    if (gap < confirmation) return null;
    const recovered = { ...candidate, point: { ...candidate.point }, from: copyPose(candidate.from) };
    this.clearEvidence();
    return recovered;
  }
}
