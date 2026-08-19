/**
 * Can this device build an MPR volume for this series — WITHOUT losing a slice?
 *
 * WHY THIS REPLACED THE EARLIER "just use every Nth slice" APPROACH
 * It cannot be used. Dropping slices is not a performance trade, it is a
 * diagnostic one: a lesion smaller than the new spacing can sit entirely in a
 * skipped slice and never appear in the reconstruction. A viewer that silently
 * shows a radiologist less than the scanner acquired is not acceptable at any
 * speed. So: every slice, or no volume. Never a quiet subset.
 *
 * WHAT ACTUALLY LIMITS US — two different ceilings, often confused
 *
 *   1. GPU MEMORY (soft). The volume is one 3D texture. At half-float — the
 *      lowest precision that still preserves CT Hounsfield values — a 512x512
 *      series costs ~0.5 MB per slice. 1000 slices ~= 500 MB. An integrated GPU
 *      has a few hundred MB, so past a certain depth it will not fit.
 *
 *   2. MAX_3D_TEXTURE_SIZE (HARD). WebGL2 caps each texture dimension, commonly
 *      at 2048. A 2518-slice series therefore cannot be uploaded as a single 3D
 *      texture on such a device NO MATTER HOW MUCH MEMORY IT HAS. This is a
 *      capability wall, not a budget, and no client-side setting moves it.
 *
 * Because of (2), "make it fit on the client" is not always a solvable problem.
 * When it is not, the honest answers are: read in 2D at full resolution (nothing
 * is lost — every slice is still there, just not reformatted), or reconstruct
 * server-side and deliver the coronal/sagittal planes as ordinary lossless DICOM
 * series that any device can display. Both preserve the data completely.
 */

import { getGpuInfo } from './getGpuTier';
import { estimateVolumeBytes, getRenderingProfile } from './renderingProfile';

export type VolumeVerdict = 'ok' | 'exceeds-memory' | 'exceeds-texture-limit' | 'unknown';

export interface VolumeAssessment {
  verdict: VolumeVerdict;
  /** True when a full-fidelity volume can be built on this device. */
  feasible: boolean;
  slices: number;
  estimatedBytes: number;
  budgetBytes: number;
  maxTextureSize: number | null;
  /** Engineering detail for logs. */
  reason: string;
  /** What to tell the radiologist — plain language, actionable, no jargon. */
  userMessage: string | null;
}

/** Conservative fallback when the driver does not report the limit. */
const ASSUMED_MAX_3D_TEXTURE = 2048;

function readDims(displaySet, slices: number) {
  const instance = displaySet?.instances?.[0];
  if (!instance) {
    return null;
  }
  const rows = Number(instance.Rows);
  const columns = Number(instance.Columns);
  if (!Number.isFinite(rows) || !Number.isFinite(columns) || rows <= 0 || columns <= 0) {
    return null;
  }
  const bitsAllocated = Number(instance.BitsAllocated) || 16;
  // Cornerstone uploads a 16-bit source as float32 unless half-float is on.
  const bytesPerVoxel = Math.max(1, Math.ceil(bitsAllocated / 8)) * 2;
  return { rows, columns, slices, bytesPerVoxel };
}

export function assessVolumeFeasibility(displaySet, imageIds: string[]): VolumeAssessment {
  const slices = imageIds.length;
  const { tier, max3DTextureSize } = getGpuInfo();
  const profile = getRenderingProfile(tier);
  const budgetBytes = profile.volumeBudgetBytes;
  const maxTexture = max3DTextureSize ?? ASSUMED_MAX_3D_TEXTURE;

  const dims = readDims(displaySet, slices);
  if (!dims) {
    // No metadata to judge with. Do not block the radiologist on a guess —
    // let it proceed; the context-loss handler is the safety net.
    return {
      verdict: 'unknown',
      feasible: true,
      slices,
      estimatedBytes: 0,
      budgetBytes,
      maxTextureSize: maxTexture,
      reason: 'series dimensions unavailable — proceeding without a pre-check',
      userMessage: null,
    };
  }

  // (2) Hard capability wall first — memory is irrelevant if the texture cannot
  // be addressed at all. Every axis counts, though depth is what usually fails.
  const largestAxis = Math.max(dims.columns, dims.rows, dims.slices);
  if (largestAxis > maxTexture) {
    return {
      verdict: 'exceeds-texture-limit',
      feasible: false,
      slices,
      estimatedBytes: estimateVolumeBytes(
        [dims.columns, dims.rows, dims.slices],
        dims.bytesPerVoxel,
        profile.preferSizeOverAccuracy
      ),
      budgetBytes,
      maxTextureSize: maxTexture,
      reason:
        `series is ${dims.columns}x${dims.rows}x${dims.slices}; this GPU caps a 3D texture ` +
        `axis at ${maxTexture}, so a full-fidelity volume cannot be created on this device`,
      userMessage:
        `3D reconstruction is not available for this series on this computer — it has ` +
        `${slices} images, more than this graphics hardware can reconstruct. Open the ` +
        `"COR MPR" or "SAG MPR" series in the study list for the coronal and sagittal ` +
        `views, or use the standard view for all ${slices} images at full resolution.`,
    };
  }

  // (1) Soft memory budget.
  const estimatedBytes = estimateVolumeBytes(
    [dims.columns, dims.rows, dims.slices],
    dims.bytesPerVoxel,
    profile.preferSizeOverAccuracy
  );

  if (estimatedBytes > budgetBytes) {
    return {
      verdict: 'exceeds-memory',
      feasible: false,
      slices,
      estimatedBytes,
      budgetBytes,
      maxTextureSize: maxTexture,
      reason:
        `volume needs ~${Math.round(estimatedBytes / 1048576)} MB of graphics memory; ` +
        `this ${tier}-tier device budget is ${Math.round(budgetBytes / 1048576)} MB`,
      userMessage:
        `3D reconstruction needs about ${Math.round(estimatedBytes / 1048576)} MB of graphics ` +
        `memory, more than this computer has available. Open the "COR MPR" or "SAG MPR" ` +
        `series in the study list for the coronal and sagittal views — all ${slices} images ` +
        `also remain available at full resolution in the standard view.`,
    };
  }

  return {
    verdict: 'ok',
    feasible: true,
    slices,
    estimatedBytes,
    budgetBytes,
    maxTextureSize: maxTexture,
    reason: `volume ~${Math.round(estimatedBytes / 1048576)} MB fits the ${tier}-tier budget`,
    userMessage: null,
  };
}
