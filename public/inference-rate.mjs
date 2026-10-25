// Count completed observations, not camera requests or renderer frames. Use a
// separate instance for each worker so face responses cannot inflate hand FPS.
export class InferenceRate {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this._fps = 0;
  }

  get fps() { return this._fps; }

  record(now) {
    if (!Number.isFinite(now)) return this._fps;
    const last = this.samples.at(-1);
    if (now === last) return this._fps;
    if (last !== undefined && (now < last || now - last > 1000)) this.reset();
    this.samples.push(now);
    // Retain the interval crossing the 500 ms boundary. Counting intervals
    // between observations avoids counting the first observation as a frame.
    const cutoff = now - 500;
    while (this.samples.length > 2 && this.samples[1] <= cutoff) this.samples.shift();
    const span = now - this.samples[0];
    this._fps = span >= 500 ? Math.round((this.samples.length - 1) * 1000 / span) : 0;
    return this._fps;
  }
}
