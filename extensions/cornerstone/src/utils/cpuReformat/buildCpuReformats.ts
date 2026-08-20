import { NotReformattable } from './deriveVolumeGeometry';
import {
  makeReformatImageId,
  reformatImageIds,
  registerReformatSession,
  releaseReformatSession,
} from './reformatImageLoader';
import { createReformatSession, type ReformatProgress } from './reformatSession';
import type { Plane } from './reformatEngine';

/**
 * Build coronal and sagittal views for a series, in this browser.
 *
 * WHERE THIS SITS
 * Third of three, and deliberately last:
 *
 *   1. GPU volume MPR - interactive, oblique, live slab thickness. Best, when
 *      the hardware can hold the volume.
 *   2. Server-built COR/SAG series - computed once at ingest for everyone,
 *      arrives as ordinary DICOM, costs the radiologist nothing.
 *   3. This.
 *
 * It is last because it charges every radiologist, every session, for work the
 * server can do once. It exists because it is the only one of the three that
 * needs nothing deployed and no particular hardware: it works on any study, on
 * any machine, today. That makes it the floor under the other two rather than a
 * replacement for either.
 */

export interface CpuReformatResult {
  sessionId: string;
  /** imageIds per plane, in display order, ready to hand to a viewport. */
  imageIds: Record<Plane, string[]>;
  /** Release the volume. Must be called when the study is closed. */
  dispose(): Promise<void>;
}

export interface BuildCpuReformatsOptions {
  /** Axial series to reslice. */
  imageIds: string[];
  /** Identifies the session; the source display set UID is a natural choice. */
  sessionId: string;
  studyInstanceUID?: string;
  frameOfReferenceUID?: string;
  thicknessMm?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReformatProgress) => void;
}

/**
 * Reformat series UIDs.
 *
 * Reuses the reserved numbers the server reformatter writes (9001/9002) so a
 * study cannot end up with client-built and server-built reformats that look
 * like different things to the radiologist. Suffixed with the session so they
 * stay unique within the study.
 */
function seriesUids(sessionId: string): Record<Plane, string> {
  return {
    coronal: `${sessionId}.9001`,
    sagittal: `${sessionId}.9002`,
  };
}

export async function buildCpuReformats(
  options: BuildCpuReformatsOptions
): Promise<CpuReformatResult> {
  const {
    imageIds,
    sessionId,
    studyInstanceUID,
    frameOfReferenceUID,
    thicknessMm = 3,
    signal,
    onProgress,
  } = options;

  const session = await createReformatSession({
    imageIds,
    thicknessMm,
    signal,
    onProgress,
  });

  try {
    registerReformatSession({
      sessionId,
      session,
      studyInstanceUID,
      frameOfReferenceUID,
      seriesInstanceUIDs: seriesUids(sessionId),
    });

    const built: Record<Plane, string[]> = {
      coronal: reformatImageIds(sessionId, 'coronal'),
      sagittal: reformatImageIds(sessionId, 'sagittal'),
    };

    if (!built.coronal.length && !built.sagittal.length) {
      // A volume that yields no planes in either direction is not a volume.
      // Better to say so than to hand back an empty series.
      throw new NotReformattable('series produced no reformatted planes');
    }

    return {
      sessionId,
      imageIds: built,
      dispose: () => releaseReformatSession(sessionId),
    };
  } catch (error) {
    // Registration failed, so nothing will ever call dispose. Release here or
    // the volume stays resident for a study nobody is looking at.
    await releaseReformatSession(sessionId).catch(() => undefined);
    await session.dispose().catch(() => undefined);
    throw error;
  }
}

export { makeReformatImageId, NotReformattable };
export type { ReformatProgress };
