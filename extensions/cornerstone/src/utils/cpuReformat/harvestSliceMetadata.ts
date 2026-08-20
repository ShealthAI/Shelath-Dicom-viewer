import type { SlicePlane } from './deriveVolumeGeometry';
import { NotReformattable } from './deriveVolumeGeometry';

/**
 * Collect, from Cornerstone's metadata providers, everything a reformat needs
 * to be both geometrically and photometrically correct.
 *
 * Geometry is only half of it. A plane can be perfectly positioned and still be
 * diagnostically wrong if the value mapping is lost: rescale slope and
 * intercept are what turn stored integers into Hounsfield units, and dropping
 * them turns air (-1000 HU) into something that reads as soft tissue. That
 * failure renders perfectly and looks like a normal image, so it is carried
 * through explicitly here rather than left to a default.
 *
 * Kept apart from the loading so the extraction and its fallbacks can be tested
 * without a PACS.
 */

/** Value mapping and storage format, shared by every slice in the series. */
export interface PixelDescriptor {
  bitsAllocated: number;
  /** 0 = unsigned, 1 = signed (two's complement). */
  pixelRepresentation: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  windowCenter?: number;
  windowWidth?: number;
  /** MONOCHROME1 displays inverted. */
  invert: boolean;
  modality?: string;
}

export interface HarvestedSeries {
  planes: SlicePlane[];
  pixel: PixelDescriptor;
}

/** The provider surface this needs — narrowed so tests can supply a stub. */
export interface MetaDataProvider {
  get(type: string, imageId: string): Record<string, unknown> | undefined;
}

function firstNumber(value: unknown): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = typeof candidate === 'string' ? Number.parseFloat(candidate) : candidate;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map(v => (typeof v === 'string' ? Number.parseFloat(v) : Number(v)));
  return out.every(Number.isFinite) ? out : undefined;
}

/**
 * Read one slice's plane geometry.
 *
 * Missing fields are left undefined rather than defaulted: deriveVolumeGeometry
 * refuses a series that lacks them, and a plausible default here would convert
 * a clean refusal into a wrong image.
 */
export function harvestPlane(
  metaData: MetaDataProvider,
  imageId: string
): SlicePlane | undefined {
  const plane = metaData.get('imagePlaneModule', imageId);
  if (!plane) {
    return undefined;
  }

  const rows = firstNumber(plane.rows);
  const columns = firstNumber(plane.columns);
  if (!rows || !columns) {
    return undefined;
  }

  return {
    rows,
    columns,
    // Cornerstone exposes both the explicit pixel spacings and the raw
    // PixelSpacing pair; prefer the explicit ones and fall back, because which
    // is populated depends on the data source.
    rowPixelSpacing:
      firstNumber(plane.rowPixelSpacing) ?? numberArray(plane.pixelSpacing)?.[0],
    columnPixelSpacing:
      firstNumber(plane.columnPixelSpacing) ?? numberArray(plane.pixelSpacing)?.[1],
    imagePositionPatient: numberArray(plane.imagePositionPatient),
    imageOrientationPatient: numberArray(plane.imageOrientationPatient),
  };
}

/**
 * Read the series' value mapping from a representative slice.
 *
 * Slope and intercept default to the DICOM identity (1, 0) when absent, which
 * is what absence means - not a guess. Everything else that is genuinely
 * unknown stays undefined so the viewer applies its own default rather than one
 * invented here.
 */
export function harvestPixelDescriptor(
  metaData: MetaDataProvider,
  imageId: string
): PixelDescriptor {
  const pixelModule = metaData.get('imagePixelModule', imageId) ?? {};
  const modalityLut = metaData.get('modalityLutModule', imageId) ?? {};
  const voiLut = metaData.get('voiLutModule', imageId) ?? {};
  const general = metaData.get('generalSeriesModule', imageId) ?? {};

  const photometric = String(
    pixelModule.photometricInterpretation ?? ''
  ).toUpperCase();

  return {
    bitsAllocated: firstNumber(pixelModule.bitsAllocated) ?? 16,
    pixelRepresentation: firstNumber(pixelModule.pixelRepresentation) ?? 0,
    // Identity is the DICOM meaning of an absent rescale, so this is the
    // specified behaviour rather than a fallback.
    rescaleSlope: firstNumber(modalityLut.rescaleSlope) ?? 1,
    rescaleIntercept: firstNumber(modalityLut.rescaleIntercept) ?? 0,
    windowCenter: firstNumber(voiLut.windowCenter),
    windowWidth: firstNumber(voiLut.windowWidth),
    invert: photometric === 'MONOCHROME1',
    modality: typeof general.modality === 'string' ? general.modality : undefined,
  };
}

/**
 * Harvest a whole series.
 *
 * Refuses as soon as any slice is unreadable. A reformat built from the subset
 * that happened to have metadata would be missing levels of the patient with
 * nothing on screen to say so.
 */
export function harvestSeries(
  metaData: MetaDataProvider,
  imageIds: string[]
): HarvestedSeries {
  if (!imageIds?.length) {
    throw new NotReformattable('no images');
  }

  const planes: SlicePlane[] = [];
  for (const imageId of imageIds) {
    const plane = harvestPlane(metaData, imageId);
    if (!plane) {
      throw new NotReformattable(`slice metadata unavailable for ${imageId}`);
    }
    planes.push(plane);
  }

  return { planes, pixel: harvestPixelDescriptor(metaData, imageIds[0]) };
}

/** Bytes one stored sample occupies, for sizing the volume before allocating. */
export function bytesPerVoxel(pixel: PixelDescriptor): number {
  return pixel.bitsAllocated > 8 ? 2 : 1;
}

/** The typed array a series of this format decodes into. */
export function voxelArrayFor(
  pixel: PixelDescriptor,
  length: number
): Int8Array | Uint8Array | Int16Array | Uint16Array {
  if (pixel.bitsAllocated > 8) {
    return pixel.pixelRepresentation === 1 ? new Int16Array(length) : new Uint16Array(length);
  }
  return pixel.pixelRepresentation === 1 ? new Int8Array(length) : new Uint8Array(length);
}
