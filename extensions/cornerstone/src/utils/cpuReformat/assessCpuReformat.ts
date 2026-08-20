import type { VolumeGeometry } from './reformatEngine';
import { volumeByteLength } from './reformatEngine';

/**
 * Whether this machine can hold this volume in RAM.
 *
 * Separate from the GPU check in assessVolumeFeasibility, and asking a
 * different question. That one asks whether the graphics hardware can render a
 * volume; this asks whether the browser can hold one. A machine can easily fail
 * the first and pass the second - which is the whole reason CPU reformatting is
 * worth doing - but a 2913-slice study fails both.
 *
 * The cost of getting this wrong is not a slow viewer, it is a killed tab with
 * a half-written report in it. So the budget is deliberately pessimistic.
 */

export type CpuReformatVerdict = 'ok' | 'exceeds-memory' | 'unknown-memory';

export interface CpuReformatAssessment {
  verdict: CpuReformatVerdict;
  feasible: boolean;
  estimatedBytes: number;
  budgetBytes: number;
  reason: string;
}

/**
 * Hard ceiling regardless of how much RAM is reported.
 *
 * A single ArrayBuffer this large is where allocation starts failing in
 * practice on 32-bit-ish heap limits, and a study needing more than this is
 * past what a browser should be attempting anyway.
 */
export const MAX_VOLUME_BYTES = 1_200_000_000;

/**
 * Share of system RAM we are willing to claim.
 *
 * Low because we are not the only tenant: Chrome itself, the rest of the
 * platform in the same renderer process, the report editor, and Cornerstone's
 * own image cache all want memory at the same moment. Claiming a third of an
 * 8 GB machine is already assertive.
 */
export const MEMORY_FRACTION = 0.33;

/**
 * Assumed when the browser will not say.
 *
 * 2, not 4. At 4 GB the resulting budget is 1.4 GB, which the hard cap clips to
 * 1.2 GB - meaning a machine that reports nothing would be trusted with as much
 * as a 64 GB workstation, which is the opposite of conservative. 2 GB gives a
 * ~675 MB budget: still ample for a normal 761-slice CT at 381 MB, and it
 * refuses anything genuinely large on a machine we know nothing about.
 */
export const ASSUMED_DEVICE_MEMORY_GB = 2;

export function assessCpuReformat(
  geometry: VolumeGeometry,
  bytesPerVoxel: number,
  deviceMemoryGb?: number
): CpuReformatAssessment {
  const estimatedBytes = volumeByteLength(geometry, bytesPerVoxel);

  // navigator.deviceMemory is coarse (a power of two, capped at 8) and absent
  // outside Chromium. Absent is treated as a small machine rather than an
  // unlimited one: guessing high here is what crashes the tab.
  const known = Number.isFinite(deviceMemoryGb) && (deviceMemoryGb as number) > 0;
  const memoryGb = known ? (deviceMemoryGb as number) : ASSUMED_DEVICE_MEMORY_GB;
  const budgetBytes = Math.min(
    MAX_VOLUME_BYTES,
    Math.floor(memoryGb * 1024 * 1024 * 1024 * MEMORY_FRACTION)
  );

  const mb = (bytes: number) => Math.round(bytes / 1048576);

  if (estimatedBytes > budgetBytes) {
    return {
      verdict: 'exceeds-memory',
      feasible: false,
      estimatedBytes,
      budgetBytes,
      reason:
        `reformat needs ~${mb(estimatedBytes)} MB of memory; the budget on this ` +
        `machine is ${mb(budgetBytes)} MB`,
    };
  }

  return {
    verdict: known ? 'ok' : 'unknown-memory',
    feasible: true,
    estimatedBytes,
    budgetBytes,
    reason: known
      ? `reformat ~${mb(estimatedBytes)} MB fits the ${mb(budgetBytes)} MB budget`
      : `reformat ~${mb(estimatedBytes)} MB fits a conservative ` +
        `${mb(budgetBytes)} MB budget (device memory unreported)`,
  };
}

/** navigator.deviceMemory, when the browser publishes it. */
export function readDeviceMemoryGb(): number | undefined {
  const value = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return typeof value === 'number' && value > 0 ? value : undefined;
}
