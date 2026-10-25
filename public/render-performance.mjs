// Main-thread draw cost is distinct from worker inference time. The FPS counts
// completed screen renders; hidden-tab gaps do not count as poor performance.
export class RenderPerformance {
  constructor() {
    this.mode = 'auto'; this.quality = 'light'; this.fps = 0; this.renderMs = 0;
    this.start = this.last = null; this.frames = this.cost = 0; this.goodSince = null;
  }
  setMode(mode) {
    this.mode = ['auto', 'light', 'high'].includes(mode) ? mode : 'auto';
    this.quality = this.mode === 'auto' ? 'light' : this.mode;
    this.goodSince = null;
  }
  record(time, cost) {
    if (!Number.isFinite(time) || !Number.isFinite(cost) || cost < 0) return;
    if (this.last === null || time <= this.last || time - this.last > 1000) {
      this.start = this.last = time; this.frames = this.cost = 0; this.goodSince = null; return;
    }
    this.last = time; this.frames++; this.cost += cost;
    const span = time - this.start;
    if (span < 500) return;
    this.fps = Math.round(this.frames * 1000 / span);
    this.renderMs = this.cost / this.frames;
    this.start = time; this.frames = this.cost = 0;
    if (this.mode !== 'auto') return;
    if (this.renderMs > 12 || this.fps < 42) { this.quality = 'light'; this.goodSince = null; }
    else if (this.renderMs < 5 && this.fps >= 55) {
      this.goodSince ??= time;
      if (time - this.goodSince >= 8000) this.quality = 'high';
    } else this.goodSince = null;
  }
}
