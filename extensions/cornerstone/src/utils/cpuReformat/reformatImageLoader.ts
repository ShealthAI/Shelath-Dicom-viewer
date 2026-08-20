import { Enums, imageLoader, metaData, utilities as csUtils } from '@cornerstonejs/core';

import type { PixelDescriptor } from './harvestSliceMetadata';
import type { Plane, PlaneGeometry } from './reformatEngine';
import type { ReformatSession } from './reformatSession';

/**
 * Makes CPU-reformatted planes look like ordinary images to the rest of the
 * viewer.
 *
 * Everything downstream - the stack viewport, the measurement tools, the
 * overlays, window/level - already knows how to handle an image and a metadata
 * provider. Rather than teach any of it about reformats, a plane is published
 * under its own imageId scheme and served through the same two extension points
 * DICOM images come through. Nothing downstream needs to know the pixels were
 * computed in this tab thirty milliseconds ago.
 *
 * THE PART THAT IS EASY TO GET SILENTLY WRONG
 * Registering the loader alone is enough to make planes RENDER. It is not
 * enough to make them CORRECT. Without the metadata provider there is no
 * imagePlaneModule for these imageIds, so the tools have no pixel spacing and
 * every length and area a radiologist measures on a reformat comes out wrong -
 * with the image looking perfectly normal. Both halves are required.
 */

const SCHEME = 'shealthmpr';

interface RegisteredSession {
  session: ReformatSession;
  /** Frame of reference of the source series, so reformats stay registered to it. */
  frameOfReferenceUID?: string;
  studyInstanceUID?: string;
  seriesInstanceUIDs: Record<Plane, string>;
}

const sessions = new Map<string, RegisteredSession>();

let installed = false;

export interface ReformatImageIdParts {
  sessionId: string;
  plane: Plane;
  index: number;
}

/** `shealthmpr:<sessionId>/<plane>/<index>` */
export function makeReformatImageId(sessionId: string, plane: Plane, index: number): string {
  return `${SCHEME}:${sessionId}/${plane}/${index}`;
}

export function parseReformatImageId(imageId: string): ReformatImageIdParts | undefined {
  if (!imageId?.startsWith(`${SCHEME}:`)) {
    return undefined;
  }
  const [sessionId, plane, rawIndex] = imageId.slice(SCHEME.length + 1).split('/');
  const index = Number.parseInt(rawIndex, 10);

  if (!sessionId || (plane !== 'coronal' && plane !== 'sagittal') || !Number.isInteger(index)) {
    return undefined;
  }
  return { sessionId, plane, index };
}

/** Every imageId for one plane of a session, in display order. */
export function reformatImageIds(sessionId: string, plane: Plane): string[] {
  const registered = sessions.get(sessionId);
  if (!registered) {
    return [];
  }
  return Array.from({ length: registered.session.planeCount(plane) }, (_, index) =>
    makeReformatImageId(sessionId, plane, index)
  );
}

function typedArrayName(pixel: PixelDescriptor): string {
  if (pixel.bitsAllocated > 8) {
    return pixel.pixelRepresentation === 1 ? 'Int16Array' : 'Uint16Array';
  }
  return pixel.pixelRepresentation === 1 ? 'Int8Array' : 'Uint8Array';
}

function minMax(pixels: ArrayLike<number>): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i];
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  // An all-zero plane (outside the patient) is legitimate; infinities are not.
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/**
 * The imagePlaneModule for a reformatted plane.
 *
 * Spacing comes from planeGeometry, which derives it from the SOURCE volume:
 * both reformats stack along the acquisition normal, so their row spacing is
 * the slice spacing, not the source's row spacing. This is the value the
 * measurement tools use.
 */
function planeModule(registered: RegisteredSession, plane: Plane) {
  const geometry: PlaneGeometry = registered.session.planeGeometry(plane);

  return {
    frameOfReferenceUID: registered.frameOfReferenceUID,
    rows: geometry.height,
    columns: geometry.width,
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    rowPixelSpacing: geometry.rowSpacing,
    columnPixelSpacing: geometry.columnSpacing,
    pixelSpacing: [geometry.rowSpacing, geometry.columnSpacing],
    sliceThickness: geometry.thickness,
  };
}

/**
 * Metadata provider for reformat imageIds.
 *
 * Returns undefined for anything else so it can sit in the provider chain
 * without shadowing DICOM metadata.
 */
function reformatMetadataProvider(type: string, imageId: string): unknown {
  const parts = parseReformatImageId(imageId);
  if (!parts) {
    return undefined;
  }
  const registered = sessions.get(parts.sessionId);
  if (!registered) {
    return undefined;
  }

  const { pixel } = registered.session;

  switch (type) {
    case 'imagePlaneModule':
      return planeModule(registered, parts.plane);

    case 'imagePixelModule':
      return {
        bitsAllocated: pixel.bitsAllocated,
        bitsStored: pixel.bitsAllocated,
        highBit: pixel.bitsAllocated - 1,
        pixelRepresentation: pixel.pixelRepresentation,
        photometricInterpretation: pixel.invert ? 'MONOCHROME1' : 'MONOCHROME2',
        samplesPerPixel: 1,
      };

    case 'modalityLutModule':
      // Carried through unchanged. Slab averaging is linear, so the mapping
      // from stored value to Hounsfield units is identical to the source's -
      // dropping it here would turn air into soft tissue.
      return {
        rescaleSlope: pixel.rescaleSlope,
        rescaleIntercept: pixel.rescaleIntercept,
      };

    case 'voiLutModule':
      return pixel.windowCenter !== undefined && pixel.windowWidth !== undefined
        ? { windowCenter: [pixel.windowCenter], windowWidth: [pixel.windowWidth] }
        : undefined;

    case 'generalSeriesModule':
      return {
        modality: pixel.modality,
        seriesInstanceUID: registered.seriesInstanceUIDs[parts.plane],
        seriesNumber: parts.plane === 'coronal' ? 9001 : 9002,
      };

    case 'generalImageModule':
      return {
        instanceNumber: parts.index + 1,
        // Flags these as machine-generated rather than acquired, the same way
        // the server reformatter does.
        imageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'],
      };

    case 'sopCommonModule':
      return { sopInstanceUID: imageId };

    default:
      return undefined;
  }
}

/**
 * Build the image object the renderer expects from a reslice result.
 *
 * `voxelManager` and `dataType` are required by Cornerstone 3D 5.x; an image
 * without them loads and then fails at render time with an error that points
 * nowhere near here.
 */
function toCornerstoneImage(
  imageId: string,
  pixels: ArrayBufferView & ArrayLike<number>,
  width: number,
  height: number,
  pixel: PixelDescriptor,
  geometry: PlaneGeometry
) {
  const { min, max } = minMax(pixels);

  const voxelManager = csUtils.VoxelManager.createImageVoxelManager({
    width,
    height,
    scalarData: pixels as never,
    numberOfComponents: 1,
  });

  return {
    imageId,
    dataType: typedArrayName(pixel) as never,
    minPixelValue: min,
    maxPixelValue: max,
    slope: pixel.rescaleSlope,
    intercept: pixel.rescaleIntercept,
    windowCenter: pixel.windowCenter ?? (max + min) / 2,
    windowWidth: pixel.windowWidth ?? Math.max(1, max - min),
    voiLUTFunction: Enums.VOILUTFunctionType.LINEAR,
    getPixelData: () => pixels as never,
    getCanvas: undefined as never,
    rows: height,
    columns: width,
    height,
    width,
    color: false,
    rgba: false,
    numberOfComponents: 1,
    columnPixelSpacing: geometry.columnSpacing,
    rowPixelSpacing: geometry.rowSpacing,
    sliceThickness: geometry.thickness,
    invert: pixel.invert,
    photometricInterpretation: pixel.invert ? 'MONOCHROME1' : 'MONOCHROME2',
    sizeInBytes: pixels.byteLength,
    voxelManager,
  };
}

/**
 * Loader for reformat imageIds.
 *
 * Cornerstone's loader contract is `{ promise, cancelFn }`. The reslice runs in
 * a worker and is a few milliseconds, so there is nothing worth cancelling -
 * but the field is part of the contract and callers may read it.
 */
function loadReformatImage(imageId: string) {
  const parts = parseReformatImageId(imageId);

  const promise = (async () => {
    if (!parts) {
      throw new Error(`not a reformat imageId: ${imageId}`);
    }
    const registered = sessions.get(parts.sessionId);
    if (!registered) {
      // The study was closed and the volume released while a request was in
      // flight. A clear error beats a blank viewport.
      throw new Error(`reformat session ${parts.sessionId} is no longer available`);
    }

    const { pixels, width, height } = await registered.session.extract(parts.plane, parts.index);

    return toCornerstoneImage(
      imageId,
      pixels as ArrayBufferView & ArrayLike<number>,
      width,
      height,
      registered.session.pixel,
      registered.session.planeGeometry(parts.plane)
    );
  })();

  return { promise, cancelFn: undefined };
}

/**
 * Install the loader and provider. Idempotent - safe to call per session.
 *
 * The provider is added at low priority so it is consulted only after the
 * DICOM providers have declined, keeping it incapable of shadowing real
 * study metadata.
 */
export function installReformatImageLoader(): void {
  if (installed) {
    return;
  }
  imageLoader.registerImageLoader(SCHEME, loadReformatImage as never);
  metaData.addProvider(reformatMetadataProvider as never, 1);
  installed = true;
}

export interface RegisterSessionOptions {
  sessionId: string;
  session: ReformatSession;
  frameOfReferenceUID?: string;
  studyInstanceUID?: string;
  seriesInstanceUIDs: Record<Plane, string>;
}

export function registerReformatSession(options: RegisterSessionOptions): void {
  installReformatImageLoader();
  sessions.set(options.sessionId, {
    session: options.session,
    frameOfReferenceUID: options.frameOfReferenceUID,
    studyInstanceUID: options.studyInstanceUID,
    seriesInstanceUIDs: options.seriesInstanceUIDs,
  });
}

/** Forget a session and release its volume. */
export async function releaseReformatSession(sessionId: string): Promise<void> {
  const registered = sessions.get(sessionId);
  if (!registered) {
    return;
  }
  sessions.delete(sessionId);
  await registered.session.dispose();
}

/** Test seam. */
export function _clearReformatSessions(): void {
  sessions.clear();
}
