/**
 * Per-GPU-tier rendering + loading profile.
 *
 * One place that answers: "given this machine, how much GPU memory, how many
 * WebGL contexts, how many decode workers, and how aggressively do we fetch?"
 *
 * The defaults exist to solve two field problems at once:
 *
 *   1. MPR crashing weak Intel iGPUs (see getGpuTier.ts). Cornerstone's context
 *      pool defaults to several WebGL contexts; each one costs GPU memory on top
 *      of the volume texture itself. Cutting contexts and halving texture
 *      precision is what makes a CT volume fit on those machines.
 *
 *   2. Image loading that *looks* serial. It is already concurrent — the request
 *      pool runs many fetches at once and MPR already uses an interleaved
 *      ("nth") load order. What was wrong is that the concurrency was a single
 *      fixed number tuned for the slowest link, which starves a hospital LAN.
 *      Here it scales with the machine, and init.tsx re-tunes it at runtime from
 *      observed throughput.
 *
 * Any explicit value in app-config still wins — these are floors/defaults for a
 * device class, not a policy that overrides the operator.
 */

import type { GpuTier } from './getGpuTier';

export interface RenderingProfile {
  /**
   * WebGL contexts Cornerstone's rendering engine pool may hold. Fewer contexts
   * = less GPU memory reserved before a single voxel is uploaded. This is the
   * single biggest lever against CONTEXT_LOST on integrated GPUs.
   */
  webGLContextCount: number;
  /**
   * Store volume textures at half precision. Roughly halves volume GPU memory
   * and is safe on Intel integrated parts — unlike norm16, which is the faster
   * memory win but is the exact configuration known to hard-crash those drivers.
   */
  preferSizeOverAccuracy: boolean;
  /**
   * Approximate GPU memory we are willing to spend on one volume, in bytes.
   * Used to decide whether an MPR volume must be down-sampled on this machine.
   */
  volumeBudgetBytes: number;
  /** Decode web workers. Leaves cores for the UI thread on small machines. */
  maxWebWorkers: number;
  /** Concurrent image requests per pool type. */
  maxNumRequests: {
    interaction: number;
    thumbnail: number;
    prefetch: number;
    compute: number;
  };
}

/**
 * Concurrent NETWORK requests, per request type.
 *
 * DELIBERATELY NOT PER GPU TIER. Every other value in this file describes the
 * graphics hardware; this one describes the link, and the two are unrelated. A
 * workstation on a 5 Mbps clinic line and a laptop on gigabit currently get
 * concurrency assigned by their GPU, which is the wrong axis entirely.
 *
 * WHY IT MATTERS MORE THAN THE DECODE POOL
 * Cornerstone runs two decoupled pools. `imageRetrievalPoolManager` issues HTTP
 * requests and frees its slot the moment bytes arrive; `imageLoadPoolManager`
 * decodes. Only the first governs link saturation - and it was never configured
 * here, so it sat at Cornerstone's default of 5 prefetch requests on every
 * machine, while the decode pool was carefully tuned per tier.
 *
 * At 100 ms RTT with 5 requests in flight, a 505-slice series spends tens of
 * seconds idle between batches, waiting on handshakes rather than bytes. Raising
 * this costs nothing in bandwidth - the same total is transferred - it just
 * stops the link going quiet between round trips.
 *
 * 20 is a starting point, not a derived optimum. `?netConcurrency=N` overrides
 * it at runtime precisely so the right number can be measured on a real link
 * rather than argued about.
 */
export const RETRIEVAL_CONCURRENCY = {
  interaction: 20,
  thumbnail: 12,
  prefetch: 20,
  compute: 20,
};

/** Bounds for the `?netConcurrency=` override. */
export const MIN_NET_CONCURRENCY = 1;
export const MAX_NET_CONCURRENCY = 64;

/**
 * Network concurrency to use, honouring a `?netConcurrency=N` URL override.
 *
 * Same escape hatch as `?gpuTier=`: support can reproduce a site's behaviour,
 * and a single value can be A/B-ed on a real study without a rebuild.
 */
export function resolveRetrievalConcurrency(search?: string): typeof RETRIEVAL_CONCURRENCY {
  try {
    const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
    const raw = new URLSearchParams(query).get('netConcurrency');
    if (raw === null) {
      return RETRIEVAL_CONCURRENCY;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
      return RETRIEVAL_CONCURRENCY;
    }
    const clamped = Math.min(MAX_NET_CONCURRENCY, Math.max(MIN_NET_CONCURRENCY, value));
    // Every type moves together: the point of the override is to answer "does
    // more concurrency help this link", and varying one type would not.
    return {
      interaction: clamped,
      thumbnail: Math.max(MIN_NET_CONCURRENCY, Math.round(clamped * 0.6)),
      prefetch: clamped,
      compute: clamped,
    };
  } catch {
    return RETRIEVAL_CONCURRENCY;
  }
}

const PROFILES: Record<GpuTier, RenderingProfile> = {
  // Intel HD/UHD-class integrated, 4 GB RAM, dual core. The machines in the
  // crash reports. Everything here is chosen to keep the volume resident.
  low: {
    webGLContextCount: 1,
    preferSizeOverAccuracy: true,
    // 768 MB, not 256 MB.
    //
    // At 256 MB this tier could not reconstruct ANY real CT - a 500-slice 512²
    // volume is 262 MB at half-float, so every clinical series was refused and
    // the tier effectively had MPR disabled rather than degraded. Radiologists
    // saw "3D reconstruction needs about N MB" on essentially every case.
    //
    // The crash this budget was guarding against happened with SEVEN WebGL
    // contexts at full precision. This profile already cuts that to one context
    // and half-float, which is where the headroom came from. The number is
    // empirical and revisable - if context loss returns on the weakest hardware,
    // this is the first value to lower.
    volumeBudgetBytes: 768 * 1024 * 1024,
    maxWebWorkers: 2,
    // Small pools: these hosts are usually also on the slow clinic links, and a
    // flood of parallel frames starves the frame the radiologist is looking at.
    maxNumRequests: { interaction: 6, thumbnail: 3, prefetch: 4, compute: 4 },
  },

  // Iris Xe / Vega-class integrated, 8-16 GB. Survives a volume, but not with a
  // full context pool at full precision.
  mid: {
    webGLContextCount: 3,
    preferSizeOverAccuracy: true,
    volumeBudgetBytes: 1536 * 1024 * 1024,
    maxWebWorkers: 4,
    maxNumRequests: { interaction: 12, thumbnail: 5, prefetch: 12, compute: 8 },
  },

  // Discrete GPU / Apple silicon / Arc. Full quality, full parallelism — this is
  // roughly stock OHIF behaviour, which is correct for this hardware.
  high: {
    webGLContextCount: 7,
    preferSizeOverAccuracy: false,
    // 4 GB: a discrete GPU holds a 2500-slice CT comfortably, and a workstation
    // must never be handed a degraded reconstruction to save memory it has.
    volumeBudgetBytes: 4 * 1024 * 1024 * 1024,
    maxWebWorkers: 6,
    maxNumRequests: { interaction: 40, thumbnail: 8, prefetch: 25, compute: 12 },
  },
};

export function getRenderingProfile(tier: GpuTier): RenderingProfile {
  return PROFILES[tier] ?? PROFILES.mid;
}

/**
 * Clamp worker count to what the host can actually spare: never more than
 * cores - 1 (leave one for the UI thread, or a volume build freezes the tab —
 * and the tab is inside our clinical workspace), never fewer than 2.
 */
export function resolveWebWorkerCount(profileMax: number, logicalCores: number): number {
  return Math.max(2, Math.min(profileMax, Math.max(1, logicalCores - 1)));
}

/**
 * Estimate the GPU memory a volume needs.
 *
 * `bytesPerVoxel` is the SOURCE precision; half-float storage halves it. This is
 * an approximation — drivers pad and align — so callers should treat it as a
 * lower bound and keep headroom in the budget.
 */
export function estimateVolumeBytes(
  dimensions: [number, number, number],
  // Retained for call-site clarity and future use (e.g. deciding whether
  // half-float can hold this source without loss). The texture size does not
  // depend on it - see below.
  _bytesPerVoxel: number,
  preferSizeOverAccuracy: boolean
): number {
  const [x, y, z] = dimensions;

  // Model the TEXTURE format, not the source format.
  //
  // This used to be `preferSizeOverAccuracy ? Math.max(2, bytesPerVoxel / 2)
  // : bytesPerVoxel`, which for the usual 16-bit source computed max(2, 1) = 2
  // in the first branch and 2 in the second - identical. The floor cancelled the
  // halving, so the flag appeared to do nothing and, worse, the full-precision
  // branch under-reported by half.
  //
  // Cornerstone uploads volume textures as float32 (4 bytes/voxel). With
  // preferSizeOverAccuracy it uses half-float (2 bytes). The source's own bit
  // depth does not decide the texture size - it only decides whether half-float
  // can represent it without loss, which is the caller's concern, not this
  // function's.
  const HALF_FLOAT_BYTES = 2;
  const FLOAT32_BYTES = 4;
  const effective = preferSizeOverAccuracy ? HALF_FLOAT_BYTES : FLOAT32_BYTES;

  // Drivers pad and align, so this is a lower bound. Callers keep headroom.
  return x * y * z * effective;
}
