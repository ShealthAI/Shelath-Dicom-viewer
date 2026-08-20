import {
  ASSUMED_DEVICE_MEMORY_GB,
  MAX_VOLUME_BYTES,
  MEMORY_FRACTION,
  assessCpuReformat,
} from './assessCpuReformat';
import type { VolumeGeometry } from './reformatEngine';

/**
 * The cost of getting this wrong is not a slow viewer - it is a killed tab
 * with a half-written report in it. So every case here checks that the guard
 * errs downward.
 */

function ct(slices: number): VolumeGeometry {
  return {
    columns: 512,
    rows: 512,
    slices,
    colSpacing: 0.7,
    rowSpacing: 0.7,
    sliceSpacing: 1,
  };
}

describe('assessCpuReformat', () => {
  it('allows the 761-slice study that kills the GPU path', () => {
    // ~381 MB. This is the whole point of CPU reformatting: a machine that
    // cannot render the volume can still hold it.
    const result = assessCpuReformat(ct(761), 2, 8);

    expect(result.feasible).toBe(true);
    expect(result.verdict).toBe('ok');
    expect(Math.round(result.estimatedBytes / 1048576)).toBe(381);
  });

  it('refuses the 2913-slice study, which fails on memory as well as GPU', () => {
    // ~1.5 GB. Past what a browser tab should attempt on any machine here.
    const result = assessCpuReformat(ct(2913), 2, 8);

    expect(result.feasible).toBe(false);
    expect(result.verdict).toBe('exceeds-memory');
    expect(result.reason).toMatch(/needs ~1457 MB/);
  });

  it('scales the budget with reported memory', () => {
    const small = assessCpuReformat(ct(761), 2, 2);
    const large = assessCpuReformat(ct(761), 2, 8);

    expect(small.budgetBytes).toBeLessThan(large.budgetBytes);
    // 33% of 2 GB is ~675 MB, so 381 MB still fits - a 2 GB machine is not
    // excluded from reformatting a normal CT.
    expect(small.feasible).toBe(true);
  });

  it('refuses a study a small machine genuinely cannot hold', () => {
    // 1 GB device: budget ~338 MB, so the 381 MB study is out. Correct - that
    // machine has Chrome and the platform in the same process.
    expect(assessCpuReformat(ct(761), 2, 1).feasible).toBe(false);
  });

  it('assumes a small machine when the browser will not say', () => {
    // deviceMemory is Chromium-only. Guessing high is what crashes the tab, so
    // absence is treated as the low end of modern rather than as unlimited.
    const result = assessCpuReformat(ct(761), 2, undefined);

    expect(result.verdict).toBe('unknown-memory');
    expect(result.budgetBytes).toBe(
      Math.floor(ASSUMED_DEVICE_MEMORY_GB * 1024 * 1024 * 1024 * MEMORY_FRACTION)
    );
    expect(result.reason).toMatch(/device memory unreported/);
  });

  it('still reports unknown-memory as feasible when it fits', () => {
    // Unknown is a caveat on the estimate, not a refusal - refusing every
    // non-Chromium browser outright would be worse than a conservative budget.
    expect(assessCpuReformat(ct(200), 2, undefined).feasible).toBe(true);
  });

  it('caps the budget however much RAM is reported', () => {
    // A 64 GB workstation still does not get to allocate 20 GB in one
    // ArrayBuffer; allocation fails long before that.
    const result = assessCpuReformat(ct(761), 2, 64);

    expect(result.budgetBytes).toBe(MAX_VOLUME_BYTES);
  });

  it('treats nonsense memory readings as unknown', () => {
    expect(assessCpuReformat(ct(761), 2, 0).verdict).toBe('unknown-memory');
    expect(assessCpuReformat(ct(761), 2, Number.NaN).verdict).toBe('unknown-memory');
    expect(assessCpuReformat(ct(761), 2, -8).verdict).toBe('unknown-memory');
  });

  it('accounts for bit depth', () => {
    // An 8-bit series is half the volume of a 16-bit one of the same shape.
    const eight = assessCpuReformat(ct(761), 1, 8);
    const sixteen = assessCpuReformat(ct(761), 2, 8);

    expect(eight.estimatedBytes * 2).toBe(sixteen.estimatedBytes);
  });

  it('states both numbers when it refuses, so the message can be specific', () => {
    // "Not enough memory" is not actionable. "Needs 1459 MB, budget is 1144 MB"
    // tells a radiologist it is the study, not their machine misbehaving.
    const result = assessCpuReformat(ct(2913), 2, 8);

    expect(result.reason).toMatch(/needs ~\d+ MB/);
    expect(result.reason).toMatch(/budget on this machine is \d+ MB/);
  });
});
