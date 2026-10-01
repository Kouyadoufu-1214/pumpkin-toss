export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, low, high) => Math.max(low, Math.min(high, v));

// Use palm width as the reference so the pinch threshold scales with distance.
export function isPinched(landmarks, previous = false) {
  const palm = distance(landmarks[5], landmarks[17]);
  if (palm < 0.01) return false;
  const ratio = distance(landmarks[4], landmarks[8]) / palm;
  return ratio < (previous ? 0.7 : 0.46);
}

export class GrabGesture {
  constructor() { this.reset(); }
  reset() { this.active = false; this.history = []; this.start = null; }
  begin(point, time) {
    this.active = true; this.start = { ...point, time };
    this.history = [{ ...point, time }];
  }
  move(point, time) {
    if (!this.active) return;
    this.history.push({ ...point, time });
    this.history = this.history.filter(p => time - p.time < 180);
  }
  release(point, time) {
    if (!this.active) return false;
    this.move(point, time);
    const first = this.history[0];
    const last = this.history.at(-1);
    const speed = distance(first, last) / Math.max(0.025, (last.time - first.time) / 1000);
    const moved = distance(this.start, point);
    const duration = time - this.start.time;
    this.reset();
    return duration >= 90 && moved > 35 && speed > 230;
  }
}

export function chooseFace(faces, side) {
  if (!faces.length) return null;
  return faces.reduce((selected, f) => side === 'left' ? (f.x < selected.x ? f : selected) : (f.x > selected.x ? f : selected));
}
