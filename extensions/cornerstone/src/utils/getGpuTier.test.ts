import { getGpuInfo, getGpuTier, forceGpuTier, _resetGpuTierCache } from './getGpuTier';

/**
 * These tests encode the safety property that matters clinically: we would
 * rather run a strong machine in a slightly cheaper mode than run a weak machine
 * in a mode that loses the WebGL context mid-report. So every ambiguous case
 * must resolve DOWNWARD, never to 'high'.
 */

function mockWebGL(rendererString: string | null) {
  const loseContext = { loseContext: jest.fn() };
  const gl = {
    getExtension: (name: string) => {
      if (name === 'WEBGL_debug_renderer_info') {
        return rendererString === null ? null : { UNMASKED_RENDERER_WEBGL: 37446 };
      }
      if (name === 'WEBGL_lose_context') {
        return loseContext;
      }
      return null;
    },
    getParameter: () => rendererString ?? '',
    RENDERER: 7937,
    MAX_3D_TEXTURE_SIZE: 32883,
  };

  jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      return { getContext: () => gl } as unknown as HTMLElement;
    }
    return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
  });

  return loseContext;
}

function setHost({ memory, cores }: { memory?: number; cores?: number }) {
  Object.defineProperty(navigator, 'deviceMemory', { value: memory, configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    value: cores ?? 8,
    configurable: true,
  });
}

describe('getGpuTier', () => {
  beforeEach(() => {
    _resetGpuTierCache();
    sessionStorage.clear();
    setHost({ memory: 16, cores: 8 });
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('classification', () => {
    it('marks Intel UHD integrated as low — the GPU in our crash reports', () => {
      mockWebGL('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)');
      expect(getGpuTier()).toBe('low');
    });

    it('marks software rasterisers as low', () => {
      mockWebGL('Google SwiftShader');
      expect(getGpuTier()).toBe('low');
    });

    it('marks discrete NVIDIA as high', () => {
      mockWebGL('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)');
      expect(getGpuTier()).toBe('high');
    });

    it('marks Iris Xe as mid — survives a volume, but not a full context pool', () => {
      mockWebGL('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)');
      expect(getGpuTier()).toBe('mid');
    });

    it('demotes an unrecognised Intel part to low rather than guessing', () => {
      mockWebGL('Intel(R) Something Unreleased Graphics');
      expect(getGpuTier()).toBe('low');
    });

    it('defaults an entirely unknown GPU to mid, never high', () => {
      mockWebGL('Some Vendor Model X');
      expect(getGpuTier()).toBe('mid');
    });

    it('treats a withheld renderer string as low', () => {
      mockWebGL(null);
      expect(getGpuTier()).toBe('low');
    });
  });

  describe('host constraints override the GPU', () => {
    it('demotes to low on a 4 GB machine even with a good GPU', () => {
      mockWebGL('NVIDIA GeForce GTX 1650');
      setHost({ memory: 4, cores: 8 });
      expect(getGpuTier()).toBe('low');
    });

    it('demotes to low on a dual-core machine', () => {
      mockWebGL('NVIDIA GeForce RTX 4070');
      setHost({ memory: 32, cores: 2 });
      expect(getGpuTier()).toBe('low');
    });

    it('caps a strong GPU on an 8 GB host at mid', () => {
      mockWebGL('NVIDIA GeForce RTX 4070');
      setHost({ memory: 8, cores: 8 });
      expect(getGpuTier()).toBe('mid');
    });
  });

  describe('overrides', () => {
    it('honours ?gpuTier= for support reproduction', () => {
      mockWebGL('NVIDIA GeForce RTX 4090');
      window.history.replaceState({}, '', '/?gpuTier=low');
      expect(getGpuTier()).toBe('low');
    });

    it('ignores a nonsense ?gpuTier= value', () => {
      mockWebGL('NVIDIA GeForce RTX 4090');
      window.history.replaceState({}, '', '/?gpuTier=ultra');
      expect(getGpuTier()).toBe('high');
    });

    it('applies a tier forced by the crash-loop breaker', () => {
      mockWebGL('NVIDIA GeForce RTX 4090');
      sessionStorage.setItem('shealth.gpuTier.forced', 'low');
      expect(getGpuTier()).toBe('low');
    });

    it('lets an explicit URL override beat the forced tier', () => {
      mockWebGL('Intel(R) UHD Graphics 620');
      sessionStorage.setItem('shealth.gpuTier.forced', 'low');
      window.history.replaceState({}, '', '/?gpuTier=high');
      expect(getGpuTier()).toBe('high');
    });
  });

  describe('probe hygiene', () => {
    it('releases the probe context — contexts are the resource we are conserving', () => {
      const loseContext = mockWebGL('NVIDIA GeForce RTX 3060');
      getGpuTier();
      expect(loseContext.loseContext).toHaveBeenCalled();
    });

    it('detects once and caches', () => {
      mockWebGL('NVIDIA GeForce RTX 3060');
      const first = getGpuInfo();
      expect(getGpuInfo()).toBe(first);
    });

    it('records why a tier was chosen, for support tickets', () => {
      mockWebGL('Intel(R) UHD Graphics 630');
      expect(getGpuInfo().reason).toMatch(/known-weak GPU/);
    });
  });

  describe('forceGpuTier', () => {
    it('persists the downgrade for the session', () => {
      mockWebGL('NVIDIA GeForce RTX 3060');
      getGpuTier();
      forceGpuTier('low');
      expect(sessionStorage.getItem('shealth.gpuTier.forced')).toBe('low');
      expect(getGpuTier()).toBe('low');
    });
  });
});
