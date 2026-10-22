/**
 * One Euro filter (Casiez et al.), adapted for normalised screen coordinates.
 * Low speeds are filtered heavily (steady cursor), high speeds barely at all
 * (no lag when you move).
 */
export class OneEuroFilter {
  constructor({ minCutoff = 2.5, beta = 1.2, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  configure({ minCutoff, beta, dCutoff } = {}) {
    if (typeof minCutoff === 'number') this.minCutoff = minCutoff;
    if (typeof beta === 'number') this.beta = beta;
    if (typeof dCutoff === 'number') this.dCutoff = dCutoff;
  }

  reset() {
    this.t = null;
    this.x = null;
    this.dx = 0;
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, timestampMs) {
    if (!Number.isFinite(value)) return this.x ?? 0;
    if (this.t === null || this.x === null) {
      this.t = timestampMs;
      this.x = value;
      this.dx = 0;
      return value;
    }

    const dt = Math.max((timestampMs - this.t) / 1000, 1e-3);
    const rawSpeed = (value - this.x) / dt;
    this.dx += this._alpha(this.dCutoff, dt) * (rawSpeed - this.dx);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this._alpha(cutoff, dt) * (value - this.x);

    this.t = timestampMs;
    return this.x;
  }
}
