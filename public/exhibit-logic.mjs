import { clamp, distance } from './interaction.mjs';

// Zones are in mirrored screen coordinates; a single face is never its own receiver.
export function resolveRoles(faces, { width = 1280, swapped = false, solo = false } = {}) {
  if (solo) return { caster: [...faces].sort((a, b) => a.x - b.x)[0] || null, receiver: null };
  const left = faces.filter(f => f.x < width * .45).sort((a, b) => a.x - b.x)[0] || null;
  const right = faces.filter(f => f.x > width * .55).sort((a, b) => b.x - a.x)[0] || null;
  return swapped ? { caster: right, receiver: left } : { caster: left, receiver: right };
}

export function handGrip(points, previous = false) {
  if (points?.length !== 21) return false;
  const palm = distance(points[5], points[17]);
  if (palm < .01) return false;
  const pinched = distance(points[4], points[8]) / palm < (previous ? .7 : .46);
  const folded = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) =>
    distance(points[tip], points[0]) < distance(points[pip], points[0]) * (previous ? 1.2 : 1.08)).length;
  return pinched || folded >= (previous ? 2 : 3);
}

export function chooseControlHand(hands, previous, { width = 1280, swapped = false, solo = false } = {}) {
  if (previous) return hands.filter(h => (!h.label || !previous.label || h.label === previous.label) && distance(h.wrist, previous.wrist) < 190)
    .sort((a, b) => distance(a.wrist, previous.wrist) - distance(b.wrist, previous.wrist))[0] || null;
  return hands.filter(h => solo || (swapped ? h.palm.x > width * .52 : h.palm.x < width * .48))
    .sort((a, b) => swapped ? b.palm.x - a.palm.x : a.palm.x - b.palm.x)[0] || null;
}

export class TossGesture {
  constructor() { this.cancel(); }
  cancel() { this.active = false; this.history = []; this.start = null; }
  begin(point, time) { this.active = true; this.start = { ...point, time }; this.history = [{ ...point, time }]; }
  move(point, time) {
    if (!this.active) return;
    this.history.push({ ...point, time });
    this.history = this.history.filter(p => time - p.time <= 240);
  }
  release(point, time, target) {
    if (!this.active) return { ok: false, reason: 'cancelled' };
    this.move(point, time);
    const first = this.history[0], last = this.history.at(-1), start = this.start;
    const speed = distance(first, last) / Math.max(.025, (last.time - first.time) / 1000);
    const direction = target ? Math.sign(target.x - start.x) || 1 : 1;
    const toward = (point.x - start.x) * direction;
    this.cancel();
    if (!target) return { ok: false, reason: 'no-receiver' };
    if (toward < 24) return { ok: false, reason: 'direction' };
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
