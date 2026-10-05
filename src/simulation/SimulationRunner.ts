export interface RunnerOptions {
  fixedDt?: number;
  /** Upper bound on catch-up steps per rendered frame, so slow frames degrade into slow motion instead of a spiral. */
  maxStepsPerFrame?: number;
  maxFrameTime?: number;
}

export class SimulationRunner {
  readonly fixedDt: number;
  readonly maxStepsPerFrame: number;
  readonly maxFrameTime: number;
  private accumulator = 0;

  constructor(options: RunnerOptions = {}) {
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 3;
    this.maxFrameTime = options.maxFrameTime ?? 0.1;
  }

  /** Advances by `elapsed` seconds of wall time and returns the interpolation factor for rendering. */
  advance(elapsed: number, step: (dt: number) => void): number {
    this.accumulator += Math.min(Math.max(elapsed, 0), this.maxFrameTime);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame) {
      step(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === this.maxStepsPerFrame && this.accumulator >= this.fixedDt) {
      this.accumulator = 0;
    }
    return this.accumulator / this.fixedDt;
  }
}
