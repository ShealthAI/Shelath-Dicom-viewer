import type { VolumeGeometry } from './reformatEngine';

/**
 * Turn a series' per-slice metadata into the volume geometry the reformatter
 * needs, or refuse it.
 *
 * Kept pure and separate from the loading so the part that can silently corrupt
 * anatomy is testable without a PACS. The two failures this exists to catch:
 *
 *   * WRONG SLICE ORDER. InstanceNumber is not reliable - it is missing on some
 *     scanners and reverses between them. Ordering by it produces a reformat
 *     that is subtly interleaved or simply upside down, and an upside-down
 *     coronal still looks like a coronal. Position along the acquisition normal
 *     is the only ordering that comes from the geometry itself.
 *
 *   * NON-UNIFORM SPACING. Reformatting assumes every slice is the same
 *     distance from the last. Feed it a series with a gap, a duplicate, or two
 *     stitched acquisitions and it will happily produce an image with the
 *     patient compressed in places - undetectable by eye, and wrong to measure.
 *
 * Mirrors services/mpr_reformat.py:load_source_volume so client and server
 * agree on what is reformattable.
 */

/** The subset of imagePlaneModule this needs. */
export interface SlicePlane {
  rows: number;
  columns: number;
  rowPixelSpacing?: number;
  columnPixelSpacing?: number;
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
}

export class NotReformattable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NotReformattable';
  }
}

/** Spacing variation tolerated before a series is called non-uniform. */
export const SPACING_TOLERANCE_MM = 0.05;

/** Orientation cosines must match this closely across the series. */
const ORIENTATION_TOLERANCE = 1e-4;

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Where a slice sits along the stacking direction, in millimetres.
 *
 * Projecting the position onto the normal rather than reading a coordinate
 * means this works for oblique acquisitions too, where no single axis is "the"
 * slice axis.
 */
export function slicePosition(plane: SlicePlane, normal: number[]): number {
  const ipp = plane.imagePositionPatient;
  if (!ipp || ipp.length < 3) {
    throw new NotReformattable('slice is missing ImagePositionPatient');
  }
  return dot(ipp, normal);
}

export interface DerivedVolume {
  geometry: VolumeGeometry;
  /** Indices into the input, ordered along the normal. */
  order: number[];
  orientation: number[];
  /** ImagePositionPatient of the first slice in that order. */
  origin: number[];
}

export function deriveVolumeGeometry(planes: SlicePlane[]): DerivedVolume {
  if (!planes?.length) {
    throw new NotReformattable('no slices');
  }
  if (planes.length < 2) {
    // One slice has no spacing and no third dimension to reformat along.
    throw new NotReformattable('a single slice cannot be reformatted');
  }

  const first = planes[0];
  const orientation = first.imageOrientationPatient;
  if (!orientation || orientation.length < 6) {
    throw new NotReformattable('series is missing ImageOrientationPatient');
  }
  if (!first.rows || !first.columns) {
    throw new NotReformattable('series is missing pixel dimensions');
  }

  const rowDir = orientation.slice(0, 3);
  const colDir = orientation.slice(3, 6);
  const normal = cross(rowDir, colDir);

  for (const plane of planes) {
    if (plane.rows !== first.rows || plane.columns !== first.columns) {
      // A series whose slices differ in size is not one volume, whatever the
      // series header says.
      throw new NotReformattable('slices differ in size within the series');
    }
    const planeOrientation = plane.imageOrientationPatient;
    if (!planeOrientation || planeOrientation.length < 6) {
      throw new NotReformattable('slice is missing ImageOrientationPatient');
    }
    for (let i = 0; i < 6; i++) {
      if (Math.abs(planeOrientation[i] - orientation[i]) > ORIENTATION_TOLERANCE) {
        // Usually a study whose series were merged, or a scout swept into the
        // set. Reformatting across it would blend unrelated geometries.
        throw new NotReformattable('mixed ImageOrientationPatient within the series');
      }
    }
  }

  const positions = planes.map(plane => slicePosition(plane, normal));
  const order = planes
    .map((_, index) => index)
    .sort((a, b) => positions[a] - positions[b]);

  const gaps: number[] = [];
  for (let i = 1; i < order.length; i++) {
    gaps.push(positions[order[i]] - positions[order[i - 1]]);
  }

  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);

  if (minGap <= 0) {
    // Two slices at the same position: a duplicate push, or the same instance
    // stored twice. Averaging over it would double-weight that level.
    throw new NotReformattable('series contains slices at duplicate positions');
  }
  if (maxGap - minGap > SPACING_TOLERANCE_MM) {
    throw new NotReformattable(
      `slice spacing varies between ${minGap.toFixed(3)} and ${maxGap.toFixed(3)} mm`
    );
  }

  const rowSpacing = first.rowPixelSpacing;
  const colSpacing = first.columnPixelSpacing;
  if (!rowSpacing || !colSpacing) {
    // Without spacing the reformat renders but every measurement on it is
    // meaningless, which is worse than not offering it.
    throw new NotReformattable('series is missing PixelSpacing');
  }

  return {
    geometry: {
      columns: first.columns,
      rows: first.rows,
      slices: planes.length,
      colSpacing,
      rowSpacing,
      sliceSpacing: (minGap + maxGap) / 2,
    },
    order,
    orientation,
    origin: planes[order[0]].imagePositionPatient as number[],
  };
}
