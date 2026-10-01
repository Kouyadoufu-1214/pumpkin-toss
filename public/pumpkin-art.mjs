export class PumpkinArt {
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = 512;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.history = []; this.previous = null; this.changed = true; this.template(); this.history = [];
  }
  save() { this.history.push(this.ctx.getImageData(0, 0, 512, 512)); if (this.history.length > 20) this.history.shift(); }
  end() { this.previous = null; }
  stroke(point, size) {
    if (!point || point.x < 0 || point.x > 512 || point.y < 0 || point.y > 512) { this.end(); return false; }
    if (!this.previous) this.save();
    const c = this.ctx; c.fillStyle = c.strokeStyle = '#fff'; c.lineWidth = size; c.lineCap = c.lineJoin = 'round';
    c.beginPath(); c.moveTo((this.previous || point).x, (this.previous || point).y); c.lineTo(point.x, point.y); c.stroke();
    c.beginPath(); c.arc(point.x, point.y, size / 2, 0, Math.PI * 2); c.fill();
    this.previous = point; this.changed = true; return true;
  }
  undo() { this.end(); const image = this.history.pop(); if (image) this.ctx.putImageData(image, 0, 0); this.changed = true; }
  clear() { this.end(); this.save(); this.ctx.clearRect(0, 0, 512, 512); this.changed = true; }
  template() {
    this.clear(); const c = this.ctx; c.fillStyle = '#fff';
    const polygon = points => { c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.fill(); };
    polygon([[135, 240], [196, 188], [215, 254]]); polygon([[297, 254], [316, 188], [377, 240]]);
    polygon([[256, 264], [233, 300], [279, 300]]);
    polygon([[137, 320], [183, 340], [199, 320], [227, 345], [255, 329], [285, 345], [311, 320], [329, 340], [375, 320], [352, 376], [315, 398], [200, 398], [161, 376]]);
  }
}
