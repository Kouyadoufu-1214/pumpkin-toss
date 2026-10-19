import { FreehandStroke, outlineInfo, smoothPath } from './carving-path.mjs';

export class PumpkinArt {
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = 512;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.history = []; this.future = []; this.draft = new FreehandStroke(); this.base = null;
    this.options = { mode: 'scrape', smoothing: 2, size: 28 };
    this.changed = true; this.template(); this.history = [];
  }
  save() { this.future = []; this.history.push(this.ctx.getImageData(0, 0, 512, 512)); if (this.history.length > 20) this.history.shift(); }
  cancel() {
    if (this.base) { this.ctx.putImageData(this.base, 0, 0); this.changed = true; }
    this.base = null; this.draft.reset();
  }
  configure(options) { this.cancel(); this.options = { ...this.options, ...options }; }
  paint(points, { closed = false, size = 3, mode = 'line' } = {}) {
    if (!points.length) return;
    const c = this.ctx;
    c.save(); c.globalAlpha = mode === 'scrape' ? .3 : 1;
    c.globalCompositeOperation = mode === 'restore' ? 'destination-out' : 'source-over';
    c.fillStyle = c.strokeStyle = '#fff'; c.lineWidth = size; c.lineCap = c.lineJoin = 'round';
    c.beginPath(); c.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach(point => c.lineTo(point.x, point.y));
    if (points.length === 1) { c.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2); c.fill(); }
    else if (closed) { c.closePath(); c.fill(); } else c.stroke();
    c.restore();
  }
  end() {
    if (!this.base) { this.draft.reset(); return null; }
    const result = this.draft.finish(this.options), base = this.base;
    this.ctx.putImageData(base, 0, 0);
    if (result.kind === 'cut') {
      this.history.push(base); if (this.history.length > 20) this.history.shift();
      this.future = [];
      this.paint(result.points, { closed: result.closed, size: this.options.size, mode: this.options.mode });
    }
    this.base = null; this.draft.reset(); this.changed = true;
    return result;
  }
  stroke(point) {
    if (!this.draft.add(point)) {
      if (this.base) { this.ctx.putImageData(this.base, 0, 0); this.changed = true; }
      return false;
    }
    this.base ||= this.ctx.getImageData(0, 0, 512, 512);
    this.ctx.putImageData(this.base, 0, 0);
    const live = ['scrape', 'restore'].includes(this.options.mode);
    this.paint(smoothPath(this.draft.points, this.options.smoothing), { size: live ? this.options.size : 3, mode: live ? this.options.mode : 'line' });
    if (this.options.mode === 'cutout') {
      const first = this.draft.points[0], ready = outlineInfo(this.draft.points).closed;
      this.ctx.beginPath(); this.ctx.arc(first.x, first.y, ready ? 9 : 6, 0, Math.PI * 2); this.ctx.stroke();
    }
    this.changed = true; return true;
  }
  undo() { if (this.base) { this.cancel(); return; } const image = this.history.pop(); if (image) { this.future.push(this.ctx.getImageData(0, 0, 512, 512)); this.ctx.putImageData(image, 0, 0); } this.changed = true; }
  redo() { this.cancel(); const image = this.future.pop(); if (image) { this.history.push(this.ctx.getImageData(0, 0, 512, 512)); this.ctx.putImageData(image, 0, 0); } this.changed = true; }
  clear() { this.cancel(); this.save(); this.ctx.clearRect(0, 0, 512, 512); this.changed = true; }
  template() {
    this.clear(); const c = this.ctx; c.fillStyle = '#fff';
    const polygon = points => { c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.fill(); };
    polygon([[135, 240], [196, 188], [215, 254]]); polygon([[297, 254], [316, 188], [377, 240]]);
    polygon([[256, 264], [233, 300], [279, 300]]);
    polygon([[137, 320], [183, 340], [199, 320], [227, 345], [255, 329], [285, 345], [311, 320], [329, 340], [375, 320], [352, 376], [315, 398], [200, 398], [161, 376]]);
  }
}
