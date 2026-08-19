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
  /**
   * Whether volume (MPR / 3D) viewports are offered by default. On the weakest
   * machines MPR is still available, but the user is warned before we build a
   * volume that may not fit.
   */
  warnBeforeVolume: boolean;
}

const PROFILES: Record<GpuTier, RenderingProfile> = {
  // Intel HD/UHD-class integrated, 4 GB RAM, dual core. The machines in the
  // crash reports. Everything here is chosen to keep the volume resident.
  low: {
    webGLContextCount: 1,
    preferSizeOverAccuracy: true,
    volumeBudgetBytes: 256 * 1024 * 1024,
    maxWebWorkers: 2,
    // Small pools: these hosts are usually also on the slow clinic links, and a
    // flood of parallel frames starves the frame the radiologist is looking at.
    maxNumRequests: { interaction: 6, thumbnail: 3, prefetch: 4, compute: 4 },
    warnBeforeVolume: true,
  },

  // Iris Xe / Vega-class integrated, 8-16 GB. Survives a volume, but not with a
  // full context pool at full precision.
  mid: {
    webGLContextCount: 3,
    preferSizeOverAccuracy: true,
    volumeBudgetBytes: 768 * 1024 * 1024,
    maxWebWorkers: 4,
    maxNumRequests: { interaction: 12, thumbnail: 5, prefetch: 12, compute: 8 },
    warnBeforeVolume: false,
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
    warnBeforeVolume: false,
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
  bytesPerVoxel: number,
  preferSizeOverAccuracy: boolean
): number {
  const [x, y, z] = dimensions;
  const effective = preferSizeOverAccuracy ? Math.max(2, bytesPerVoxel / 2) : bytesPerVoxel;
  return x * y * z * effective;
}

/**
 * Stride needed on the SLICE axis to fit `estimated` bytes into `budget`.
 *
 * Scaling is LINEAR, not cubic: we drop whole slices and keep every slice's
 * in-plane resolution untouched (so in-plane measurements stay exact), which
 * means taking every Nth slice divides the volume by exactly N.
 *
 * Getting this wrong is not cosmetic — a cube-root factor would under-correct a
 * 10x-oversized volume to 3x, leave it three times too big for the GPU, and the
 * context would still be lost. The crash we are preventing would simply return.
 *
 * Capped at 8: beyond that so little of the series survives that the honest
 * answer is "read this on a workstation", which the caller enforces via its
 * minimum-slice check.
 */
export function requiredSliceStride(estimatedBytes: number, budgetBytes: number): number {
  if (estimatedBytes <= budgetBytes || budgetBytes <= 0) {
    return 1;
  }
  return Math.min(8, Math.max(1, Math.ceil(estimatedBytes / budgetBytes)));
}
