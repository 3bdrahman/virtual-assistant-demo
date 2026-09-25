// Exact integration of a critically damped spring. This stays stable when
// animation frames are late, unlike an Euler step with a very small tau.
export class SpringDamper {
  constructor(initialPosition = 0, tau = 0.05) {
    this.position = initialPosition;
    this.velocity = 0;
    this.updateParameters(tau);
  }

  update(target, dt) {
    if (!Number.isFinite(target) || !Number.isFinite(dt) || dt <= 0) return this.position;
    const before = this.position;
    const tau = target < before ? this.releaseTau : this.tau;
    const omega = 2 / tau;
    const offset = before - target;
    const step = Math.min(dt, 0.1);
    const decay = Math.exp(-omega * step);
    const change = (this.velocity + omega * offset) * step;

    this.position = target + (offset + change) * decay;
    this.velocity = (this.velocity - omega * change) * decay;

    // A moving target can carry velocity across it. Morph values and head
    // tracking should settle at the target rather than visibly oscillate.
    if ((target - before) * (target - this.position) < 0) {
      this.position = target;
      this.velocity = 0;
    }
    return this.position;
  }

  updateParameters(tau) {
    this.tau = Number.isFinite(tau) ? Math.max(tau, 0.001) : 0.05;
    this.releaseTau = Math.max(this.tau, 0.045);
  }

  reset(position = 0, velocity = 0) {
    this.position = position;
    this.velocity = velocity;
  }

  getState() {
    return { position: this.position, velocity: this.velocity };
  }
}
