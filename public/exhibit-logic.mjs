import { clamp, distance } from './interaction.mjs';

// Zones are in mirrored screen coordinates; a single face is never its own receiver.
export function resolveRoles(faces, { width = 1280, swapped = false, solo = false } = {}) {
  if (solo) return { caster: [...faces].sort((a, b) => a.x - b.x)[0] || null, receiver: null };
  const left = faces.filter(f => f.x < width * .45).sort((a, b) => a.x - b.x)[0] || null;
  const right = faces.filter(f => f.x > width * .55).sort((a, b) => b.x - a.x)[0] || null;
  return swapped ? { caster: right, receiver: left } : { caster: left, receiver: right };
}

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const MAX_SAMPLE_GAP = 650;
const RELEASE_GRACE = 320;
const otherHandSnapshots = new WeakMap();

function rememberControlHand(hand, hands) {
  if (hand) otherHandSnapshots.set(hand, hands.filter(other => other !== hand)
    .map(other => ({ wrist: { ...other.wrist }, label: other.label })));
  return hand;
}

export function handGrip(points, previous = false, gesture = null) {
  if (points?.length !== 21 || !points.every(finitePoint)) return false;
  const palm = distance(points[5], points[17]);
  if (palm < .01) return false;
  const pinchRatio = distance(points[4], points[8]) / palm;
  // A deliberate pinch remains available even when the other three fingers
  // resemble an open palm. Confident classifications handle tilted fists and
  // open hands better than distances projected onto the camera image alone.
  if (pinchRatio < .46) return true;
  if (Number.isFinite(gesture?.score) && gesture.score >= .7 && gesture.score <= 1) {
    if (gesture.categoryName === 'Closed_Fist') return true;
    if (gesture.categoryName === 'Open_Palm') return false;
  }
  const pinched = pinchRatio < (previous ? .7 : .46);
  const folded = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) =>
    distance(points[tip], points[0]) < distance(points[pip], points[0]) * (previous ? 1.2 : 1.08)).length;
  return pinched || folded >= (previous ? 2 : 3);
}

export function chooseControlHand(hands, previous, { width = 1280, swapped = false, solo = false, elapsed = 80, anchor = null } = {}) {
  const valid = hands.filter(hand => finitePoint(hand.palm) && finitePoint(hand.wrist));
  if (previous) {
    if (!finitePoint(previous.wrist) || !Number.isFinite(elapsed) || elapsed > MAX_SAMPLE_GAP) return null;
    // A fast swing covers more pixels between sparse recognition results.
    // Keep the expansion bounded so a distant receiver's hand is not adopted.
    const reach = clamp(Math.max(0, elapsed) * 1.3, 190, 360);
    const others = otherHandSnapshots.get(previous) || [];
    const selected = valid.filter(hand => {
      const moved = distance(hand.wrist, previous.wrist);
      if ((hand.label && previous.label && hand.label !== previous.label) || moved >= reach) return false;
      // Left/Right labels identify hands, not people. Do not adopt a hand
      // that is clearly closer to another hand already seen in the last frame.
      return !others.some(other => (!hand.label || !other.label || hand.label === other.label)
        && distance(hand.wrist, other.wrist) + 35 < moved);
    }).sort((a, b) => distance(a.wrist, previous.wrist) - distance(b.wrist, previous.wrist))[0] || null;
    return rememberControlHand(selected, valid);
  }
  const selected = valid.filter(h => solo || (swapped ? h.palm.x > width * .52 : h.palm.x < width * .48))
    .sort((a, b) => (finitePoint(anchor) ? distance(a.palm, anchor) - distance(b.palm, anchor) : 0)
      || (swapped ? b.palm.x - a.palm.x : a.palm.x - b.palm.x))[0] || null;
  return rememberControlHand(selected, valid);
}

export class TossGesture {
  constructor() { this.cancel(); }
  cancel() { this.active = false; this.history = []; this.start = null; }
  begin(point, time) {
    this.cancel();
    if (!finitePoint(point) || !Number.isFinite(time)) return;
    this.active = true; this.start = { ...point, time }; this.history = [{ ...point, time }];
  }
  move(point, time) {
    if (!this.active) return false;
    const previous = this.history.at(-1);
    if (!finitePoint(point) || !Number.isFinite(time) || time < previous.time || time - previous.time > MAX_SAMPLE_GAP) {
      this.cancel(); return false;
    }
    if (time === previous.time) this.history[this.history.length - 1] = { ...point, time };
    else this.history.push({ ...point, time });
    this.history = this.history.filter(p => time - p.time <= MAX_SAMPLE_GAP + RELEASE_GRACE);
    return true;
  }
  release(point, time, target) {
    if (!this.active) return { ok: false, reason: 'cancelled' };
    if (!target || !Number.isFinite(target.x)) { this.cancel(); return { ok: false, reason: 'no-receiver' }; }
    if (time - this.history.at(-1).time > MAX_SAMPLE_GAP) { this.cancel(); return { ok: false, reason: 'slow' }; }
    if (!this.move(point, time)) return { ok: false, reason: 'cancelled' };
    const history = this.history, start = this.start;
    const direction = Math.sign(target.x - start.x) || 1;
    const toward = (point.x - start.x) * direction;
    this.cancel();
    if (toward < 24) return { ok: false, reason: 'direction' };
    const recent = history.filter(p => time - p.time <= RELEASE_GRACE);
    if (recent.some(p => (p.x - point.x) * direction > 32)) return { ok: false, reason: 'direction' };
    // Opening the hand can be recognized one frame after the swing stops.
    // Look for recent forward motion, without counting a stationary release
    // as movement or averaging a fast flick away with the preceding hold.
    let speed = 0;
    for (let j = 1; j < history.length; j++) {
      const last = history[j];
      if (time - last.time > RELEASE_GRACE || (last.x - history[j - 1].x) * direction < 2) continue;
      for (let i = j - 1; i >= 0; i--) {
        const first = history[i], duration = last.time - first.time;
        // Sparse consecutive observations are useful up to the tracking gap
        // limit; several observations only describe a flick over a short span.
        if (duration < 25 || (j - i > 1 && duration > 240)) continue;
        const travel = (last.x - first.x) * direction;
        if (travel >= 24) speed = Math.max(speed, travel / (duration / 1000));
      }
    }
    if (speed < 200 || time - start.time < 90 || distance(start, point) < 40) return { ok: false, reason: 'slow' };
    return { ok: true };
  }
}

export class DwellAction {
  constructor(duration = 1150) { this.duration = duration; this.reset(); }
  reset() { this.since = null; this.fired = false; }
  update(inside, time) {
    if (!inside) { this.reset(); return false; }
    if (this.since === null) this.since = time;
    if (!this.fired && time - this.since >= this.duration) { this.fired = true; return true; }
    return false;
  }
  progress(time) { return this.since === null ? 0 : clamp((time - this.since) / this.duration, 0, 1); }
}

export function flightPose(start, target, progress) {
  const t = clamp(progress, 0, 1), fly = clamp(t / .8, 0, 1), ease = 1 - (1 - fly) ** 2, drop = clamp((t - .8) / .2, 0, 1);
  return { x: start.x + (target.x - start.x) * ease,
    y: start.y + (target.y - 70 - start.y) * ease - Math.sin(fly * Math.PI) * 170 + 70 * drop ** 2,
    w: start.w + (target.w - start.w) * ease, h: start.h + (target.h - start.h) * ease,
    yaw: Math.sin(fly * Math.PI) * 2.4, pitch: -Math.sin(fly * Math.PI) * .5,
    roll: Math.sin(fly * Math.PI) * .4, depth: 1 + Math.sin(fly * Math.PI) * .25 };
}
