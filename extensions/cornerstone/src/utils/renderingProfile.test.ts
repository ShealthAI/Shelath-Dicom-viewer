import {
  MAX_NET_CONCURRENCY,
  MIN_NET_CONCURRENCY,
  RETRIEVAL_CONCURRENCY,
  resolveRetrievalConcurrency,
  getRenderingProfile,
  resolveWebWorkerCount,
  estimateVolumeBytes,
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
    // These model the TEXTURE, not the source file. Cornerstone uploads volumes
    // as float32, or half-float when preferSizeOverAccuracy is set. A 16-bit
    // source does not produce a 16-bit texture, and assuming it did is what made
    // the full-precision estimate half of the truth.

    it('counts float32 at full precision', () => {
      expect(estimateVolumeBytes([512, 512, 100], 2, false)).toBe(512 * 512 * 100 * 4);
    });

    it('counts half-float when preferSizeOverAccuracy is on', () => {
      expect(estimateVolumeBytes([512, 512, 100], 2, true)).toBe(512 * 512 * 100 * 2);
    });

    it('halves the estimate when half-float storage is on', () => {
      const full = estimateVolumeBytes([512, 512, 100], 2, false);
      const half = estimateVolumeBytes([512, 512, 100], 2, true);
      expect(half).toBe(full / 2);
    });

    it('does not vary with the source bit depth', () => {
      // The texture format is fixed by the renderer. An 8-bit and a 16-bit
      // source of the same dimensions occupy the same volume texture, so a
      // budget check must not treat them differently.
      const eight = estimateVolumeBytes([64, 64, 64], 1, false);
      const sixteen = estimateVolumeBytes([64, 64, 64], 2, false);
      expect(eight).toBe(sixteen);
    });

    it('is a lower bound — drivers pad and align', () => {
      // Documented expectation rather than a guard: callers must keep headroom
      // rather than treating this as exact.
      expect(estimateVolumeBytes([10, 10, 10], 2, true)).toBe(10 * 10 * 10 * 2);
    });
  });

  describe('resolveRetrievalConcurrency', () => {
    // This governs the NETWORK pool, which until now was never configured and
    // sat at Cornerstone's default of 5 prefetch requests on every machine —
    // while the decode pool was carefully tuned per GPU tier. The tuning that
    // existed could not affect link saturation even in principle.

    it('defaults to the shared value, not a per-tier one', () => {
      // GPU class says nothing about the link. A workstation on a 5 Mbps clinic
      // line and a laptop on gigabit must not be assigned network concurrency by
      // their graphics card.
      expect(resolveRetrievalConcurrency('')).toEqual(RETRIEVAL_CONCURRENCY);
    });

    it('is well above the decode pool — retrieval slots free on bytes, not on decode', () => {
      expect(RETRIEVAL_CONCURRENCY.prefetch).toBeGreaterThan(
        getRenderingProfile('low').maxNumRequests.prefetch
      );
    });

    it('honours ?netConcurrency= so a link can be measured without a rebuild', () => {
      const result = resolveRetrievalConcurrency('?netConcurrency=32');
      expect(result.prefetch).toBe(32);
      expect(result.interaction).toBe(32);
    });

    it('clamps an absurd override rather than trusting it', () => {
      expect(resolveRetrievalConcurrency('?netConcurrency=9999').prefetch).toBe(
        MAX_NET_CONCURRENCY
      );
      expect(resolveRetrievalConcurrency('?netConcurrency=0').prefetch).toBe(
        MIN_NET_CONCURRENCY
      );
      expect(resolveRetrievalConcurrency('?netConcurrency=-5').prefetch).toBe(
        MIN_NET_CONCURRENCY
      );
    });

    it('ignores a non-numeric override', () => {
      expect(resolveRetrievalConcurrency('?netConcurrency=lots')).toEqual(RETRIEVAL_CONCURRENCY);
    });

    it('keeps thumbnails below the main pool', () => {
      // Thumbnails are the least urgent traffic; letting them match prefetch
      // would have a panel of previews competing with the frame being read.
      const result = resolveRetrievalConcurrency('?netConcurrency=20');
      expect(result.thumbnail).toBeLessThan(result.prefetch);
      expect(result.thumbnail).toBeGreaterThanOrEqual(MIN_NET_CONCURRENCY);
    });
  });
});
