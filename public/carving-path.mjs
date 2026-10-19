const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const copy = p => ({ x: p.x, y: p.y });

// Equal spatial spacing keeps smoothing independent of camera frame rate and
// how long someone pauses at a corner. Never connect across tracking gaps.
export function resamplePath(points, spacing = 3, closed = false) {
  if (points.length < 2) return points.map(copy);
  const source = closed ? [...points, points[0]] : points;
  const result = [copy(source[0])];
  let remaining = spacing;
  for (let i = 1; i < source.length; i++) {
    let from = source[i - 1], length = distance(from, source[i]);
    while (length >= remaining) {
      const t = remaining / length;
      from = { x: from.x + (source[i].x - from.x) * t, y: from.y + (source[i].y - from.y) * t };
      result.push(from); length -= remaining; remaining = spacing;
    }
    remaining -= length;
  }
  if (!closed && distance(result.at(-1), source.at(-1)) > .01) result.push(copy(source.at(-1)));
  if (closed && result.length > 1 && distance(result.at(-1), result[0]) < spacing / 2) result.pop();
  return result;
}

export function smoothPath(points, strength = 2, closed = false) {
  const samples = resamplePath(points, 3, closed);
  const radius = Math.min(samples.length - 1, 6, Math.max(0, Math.round(strength * 2)));
  if (!radius || samples.length < 3) return samples;
  return samples.map((point, i) => {
    if (!closed && (i === 0 || i === samples.length - 1)) return copy(point);
    // Taper at open ends so a line never curls back toward its first point.
    const reach = closed ? radius : Math.min(radius, i, samples.length - i - 1);
    let x = 0, y = 0, total = 0;
    for (let offset = -reach; offset <= reach; offset++) {
      const sample = samples[(i + offset + samples.length) % samples.length];
      const weight = reach + 1 - Math.abs(offset);
      x += sample.x * weight; y += sample.y * weight; total += weight;
    }
    return { x: x / total, y: y / total };
  });
}

export function outlineInfo(points) {
  if (points.length < 3) return { closed: false, area: 0 };
  let length = 0, twiceArea = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach((p, i) => {
    const next = points[(i + 1) % points.length];
    if (i < points.length - 1) length += distance(p, next);
    twiceArea += p.x * next.y - next.x * p.y;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const area = Math.abs(twiceArea) / 2;
  const tolerance = Math.min(36, Math.max(12, Math.hypot(maxX - minX, maxY - minY) * .3));
  return { closed: length >= 35 && area >= 90 && distance(points[0], points.at(-1)) <= tolerance, area };
}

export class FreehandStroke {
  constructor() { this.reset(); }
  reset() { this.points = []; this.interrupted = false; }
  add(point) {
    if (this.interrupted) return false;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 512 || point.y < 0 || point.y > 512) {
      this.interrupted = true; return false;
    }
    const previous = this.points.at(-1);
    if (previous && distance(previous, point) > 100 || this.points.length >= 2400) {
      this.interrupted = true; return false;
    }
    if (!previous || distance(previous, point) >= 1.5) this.points.push(copy(point));
    return true;
  }
  finish({ mode = 'cutout', smoothing = 2 } = {}) {
    if (this.interrupted) return { kind: 'interrupted', points: [] };
    if ((mode === 'scrape' || mode === 'restore') && this.points.length) return { kind: 'cut', closed: false, points: smoothPath(this.points, smoothing) };
    if (this.points.length < 3 || this.points.reduce((sum, p, i) => sum + (i ? distance(p, this.points[i - 1]) : 0), 0) < 12) return { kind: 'small', points: [] };
    const closed = mode === 'cutout' && outlineInfo(this.points).closed;
    if (mode === 'cutout' && !closed) return { kind: 'open', points: [] };
    return { kind: 'cut', closed, points: smoothPath(this.points, smoothing, closed) };
  }
}
