/**
 * Coronal and sagittal reformatting, on the CPU.
 *
 * WHY THIS EXISTS
 * MPR in the browser normally uploads the whole series to the GPU as one 3D
 * texture. A 761-slice CT is ~400 MB of texture, and a 2913-slice one exceeds
 * MAX_3D_TEXTURE_SIZE outright, so on the integrated GPUs our radiologists read
 * on it either dies or was never possible. But an orthogonal reformat does not
 * need a volume on the GPU at all: a coronal plane is one row of pixels taken
 * from each axial slice. Computed in RAM, one output plane is under a megabyte.
 *
 * PARITY WITH THE SERVER
 * The backend builds the same planes at ingest (services/mpr_reformat.py). This
 * is deliberately a port of that code, not a second opinion: same slab
 * averaging, same superior-first flip, same round-half-to-even, same pixel
 * spacing. A radiologist must not be able to tell which one produced the image
 * in front of them, and a measurement must not change depending on where the
 * reformat happened to be computed.
 *
 * WHY AVERAGE RATHER THAN SAMPLE
 * Collapsing a slab by its mean means every source voxel contributes to the
 * output. Taking every Nth plane instead would be cheaper and would look almost
 * identical, but a finding smaller than the step could fall entirely between
 * sampled planes and never be shown. A mean cannot hide anything, because
 * nothing is excluded.
 */

export type Plane = 'coronal' | 'sagittal';

/** Any integer typed array a DICOM stack can decode into. */
export type VoxelArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export interface VolumeGeometry {
  /** Samples across one row (x). */
  columns: number;
  /** Rows in one slice (y). */
  rows: number;
  /** Number of axial slices (z). */
  slices: number;
  /** Millimetres between columns. */
  colSpacing: number;
  /** Millimetres between rows. */
  rowSpacing: number;
  /** Millimetres between slice centres. */
  sliceSpacing: number;
}

export interface PlaneGeometry {
  width: number;
  height: number;
  /** Millimetres between output rows - DICOM PixelSpacing[0]. */
  rowSpacing: number;
  /** Millimetres between output columns - DICOM PixelSpacing[1]. */
  columnSpacing: number;
  /** Millimetres of tissue each output plane represents. */
  thickness: number;
}

/**
 * Source planes collapsed into one output plane.
 *
 * At least 1: a requested thickness finer than the acquisition cannot invent
 * resolution, and a step of 0 would produce no planes at all.
 */
export function slabStep(thicknessMm: number, spacingMm: number): number {
  if (!Number.isFinite(thicknessMm) || !Number.isFinite(spacingMm) || spacingMm <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(thicknessMm / spacingMm));
}

/** The axis a plane traverses: rows for coronal, columns for sagittal. */
function traversedExtent(geometry: VolumeGeometry, plane: Plane): number {
  return plane === 'coronal' ? geometry.rows : geometry.columns;
}

function traversedSpacing(geometry: VolumeGeometry, plane: Plane): number {
  return plane === 'coronal' ? geometry.rowSpacing : geometry.colSpacing;
}

/** How many planes this volume yields at the given slab thickness. */
export function planeCount(
  geometry: VolumeGeometry,
  plane: Plane,
  thicknessMm: number
): number {
  const extent = traversedExtent(geometry, plane);
  if (extent <= 0) {
    return 0;
  }
  return Math.ceil(extent / slabStep(thicknessMm, traversedSpacing(geometry, plane)));
}

/**
 * Size and spacing of one output plane.
 *
 * Both planes stack along the acquisition normal, so their VERTICAL spacing is
 * always the slice spacing. Getting this wrong does not look wrong - it
 * silently corrupts every distance a radiologist measures on the reformat.
 */
export function planeGeometry(
  geometry: VolumeGeometry,
  plane: Plane,
  thicknessMm: number
): PlaneGeometry {
  const step = slabStep(thicknessMm, traversedSpacing(geometry, plane));

  return {
    width: plane === 'coronal' ? geometry.columns : geometry.rows,
    height: geometry.slices,
    rowSpacing: geometry.sliceSpacing,
    columnSpacing: plane === 'coronal' ? geometry.colSpacing : geometry.rowSpacing,
    thickness: step * traversedSpacing(geometry, plane),
  };
}

/**
 * Round half to even.
 *
 * Matches numpy's `rint`, which the server reformatter uses. Math.round rounds
 * half away from zero, so the two would disagree on exact .5 values and the
 * same slab would produce a different stored value depending on where it was
 * computed. One count of difference is clinically irrelevant and diagnostically
 * indefensible - the images are meant to be the same image.
 */
export function rintHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;

  if (diff > 0.5) {
    return floor + 1;
  }
  if (diff < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Extract one reformatted plane.
 *
 * `voxels` is the whole volume, slice-major: index = z*rows*columns +
 * y*columns + x. `out` may be supplied to reuse a buffer across planes; it
 * must be the right length and the same array type as the source, since the
 * output carries the source's stored values unchanged.
 *
 * The slice axis is written in reverse so the first output row is the most
 * superior voxel, which is how a radiologist expects a coronal or sagittal to
 * be oriented - and, more to the point, how the server writes it.
 */
export function extractPlane(
  voxels: VoxelArray,
  geometry: VolumeGeometry,
  plane: Plane,
  index: number,
  thicknessMm: number,
  out?: VoxelArray
): VoxelArray {
  const { columns, rows, slices } = geometry;
  const { width, height } = planeGeometry(geometry, plane, thicknessMm);
  const extent = traversedExtent(geometry, plane);
  const step = slabStep(thicknessMm, traversedSpacing(geometry, plane));

  const start = index * step;
  if (index < 0 || start >= extent) {
    throw new RangeError(`reformat plane ${index} is outside the ${plane} range`);
  }
  // The final slab is short whenever the extent is not a whole multiple of the
  // step. Averaging over the requested step regardless would divide real voxels
  // by phantom ones and darken the last plane.
  const end = Math.min(start + step, extent);
  const slabSize = end - start;

  const target = (out ?? new (voxels.constructor as new (n: number) => VoxelArray)(
    width * height
  )) as VoxelArray;

  if (target.length !== width * height) {
    throw new RangeError(
      `reformat output buffer is ${target.length}, expected ${width * height}`
    );
  }

  const sliceStride = rows * columns;

  for (let z = 0; z < slices; z++) {
    // Superior-first: the last acquired slice becomes the top output row.
    const outRow = slices - 1 - z;
    const outBase = outRow * width;
    const sliceBase = z * sliceStride;

    for (let i = 0; i < width; i++) {
      let sum = 0;

      if (plane === 'coronal') {
        // Fixed row band, running across columns. `i` is the column.
        for (let y = start; y < end; y++) {
          sum += voxels[sliceBase + y * columns + i];
        }
      } else {
        // Fixed column band, running down rows. `i` is the row.
        for (let x = start; x < end; x++) {
          sum += voxels[sliceBase + i * columns + x];
        }
      }

      target[outBase + i] = rintHalfToEven(sum / slabSize);
    }
  }

  return target;
}

/**
 * Bytes a volume of this shape occupies in RAM.
 *
 * Used to refuse a study before allocating, rather than discovering the limit
 * as a tab crash with a report half-written.
 */
export function volumeByteLength(geometry: VolumeGeometry, bytesPerVoxel: number): number {
  return geometry.columns * geometry.rows * geometry.slices * bytesPerVoxel;
}
