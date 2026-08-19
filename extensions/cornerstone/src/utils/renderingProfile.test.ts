import {
  getRenderingProfile,
  resolveWebWorkerCount,
  estimateVolumeBytes,
  requiredSliceStride,
} from './renderingProfile';

describe('renderingProfile', () => {
  describe('GPU budget shrinks as the tier drops', () => {
    it('gives weak GPUs a single WebGL context', () => {
      // The crash we are defending against: 7 contexts + a CT volume exceeds an
      // Intel iGPU's memory, the browser drops the context, MPR goes black.
      expect(getRenderingProfile('low').webGLContextCount).toBe(1);
      expect(getRenderingProfile('high').webGLContextCount).toBeGreaterThan(1);
    });

    it('uses half-precision textures on low and mid, full on high', () => {
      expect(getRenderingProfile('low').preferSizeOverAccuracy).toBe(true);
      expect(getRenderingProfile('mid').preferSizeOverAccuracy).toBe(true);
      expect(getRenderingProfile('high').preferSizeOverAccuracy).toBe(false);
    });

    it('orders volume budgets low < mid < high', () => {
      const low = getRenderingProfile('low').volumeBudgetBytes;
      const mid = getRenderingProfile('mid').volumeBudgetBytes;
      const high = getRenderingProfile('high').volumeBudgetBytes;
      expect(low).toBeLessThan(mid);
      expect(mid).toBeLessThan(high);
    });

    it('falls back to mid for an unknown tier rather than the riskiest profile', () => {
      // @ts-expect-error deliberately passing an invalid tier
      expect(getRenderingProfile('something-else')).toEqual(getRenderingProfile('mid'));
    });
  });

  describe('fetch concurrency scales with the device', () => {
    it('opens more parallel requests on stronger machines', () => {
      const low = getRenderingProfile('low').maxNumRequests;
      const high = getRenderingProfile('high').maxNumRequests;
      expect(high.interaction).toBeGreaterThan(low.interaction);
      expect(high.prefetch).toBeGreaterThan(low.prefetch);
    });

    it('always favours the frame the user is looking at over background prefetch', () => {
      (['low', 'mid', 'high'] as const).forEach(tier => {
        const p = getRenderingProfile(tier).maxNumRequests;
        expect(p.interaction).toBeGreaterThanOrEqual(p.prefetch);
      });
    });
  });

  describe('resolveWebWorkerCount', () => {
    it('leaves a core free for the UI thread', () => {
      // A frozen UI thread freezes the whole iframe — and the report editor
      // hosting it — so this is not merely a performance nicety.
      expect(resolveWebWorkerCount(6, 4)).toBe(3);
    });

    it('never drops below 2 workers even on a single-core host', () => {
      expect(resolveWebWorkerCount(6, 1)).toBe(2);
    });

    it('never exceeds the profile ceiling on a many-core host', () => {
      expect(resolveWebWorkerCount(2, 32)).toBe(2);
    });
  });

  describe('estimateVolumeBytes', () => {
    it('counts one byte-per-voxel-per-dimension at full precision', () => {
      expect(estimateVolumeBytes([512, 512, 100], 2, false)).toBe(512 * 512 * 100 * 2);
    });

    it('halves the estimate when half-float storage is on', () => {
      const full = estimateVolumeBytes([512, 512, 100], 4, false);
      const half = estimateVolumeBytes([512, 512, 100], 4, true);
      expect(half).toBe(full / 2);
    });

    it('never assumes below 2 bytes per voxel', () => {
      // Half of an 8-bit source would be 0.5 bytes, which is not a real texture
      // format — clamping keeps the estimate an honest lower bound.
      expect(estimateVolumeBytes([10, 10, 10], 1, true)).toBe(10 * 10 * 10 * 2);
    });
  });

  describe('requiredSliceStride', () => {
    it('returns 1 when the volume already fits', () => {
      expect(requiredSliceStride(100, 200)).toBe(1);
    });

    it('scales LINEARLY — dropping slices divides bytes by exactly the stride', () => {
      // The bug this guards: a cube-root factor would return 2 here, leave the
      // volume 4x too big for the GPU, and the context loss would return.
      expect(requiredSliceStride(800, 100)).toBe(8);
      expect(requiredSliceStride(300, 100)).toBe(3);
    });

    it('caps at 8 — past that the caller should refuse rather than pretend', () => {
      expect(requiredSliceStride(1e12, 1)).toBe(8);
    });

    it('treats a non-positive budget as "no information"', () => {
      expect(requiredSliceStride(1000, 0)).toBe(1);
    });
  });
});
