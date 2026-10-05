import { describe, expect, it } from 'vitest';
import { SimulationRunner } from './SimulationRunner';

describe('SimulationRunner', () => {
  it('takes fixed steps and reports the leftover fraction for interpolation', () => {
    const runner = new SimulationRunner({ fixedDt: 0.01 });
    const steps: number[] = [];
    const alpha = runner.advance(0.025, (dt) => steps.push(dt));
    expect(steps).toEqual([0.01, 0.01]);
    expect(alpha).toBeCloseTo(0.5, 6);
  });

  it('caps catch-up work after a long stall instead of spiralling', () => {
    const runner = new SimulationRunner({ fixedDt: 0.01, maxStepsPerFrame: 3, maxFrameTime: 1 });
    let count = 0;
    const alpha = runner.advance(0.5, () => count++);
    expect(count).toBe(3);
    expect(alpha).toBe(0);
    runner.advance(0.005, () => count++);
    expect(count).toBe(3);
  });
});
