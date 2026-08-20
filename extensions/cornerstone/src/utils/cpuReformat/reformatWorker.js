import { expose } from 'comlink';

/**
 * Holds the volume and does the reslicing, off the UI thread.
 *
 * WHY THE VOLUME LIVES HERE AND NOT ON THE MAIN THREAD
 * A 761-slice CT is 381 MB. Keeping it in the worker means the main thread
 * never holds a second copy, and - more to the point - the per-plane loop runs
 * where it cannot stall a radiologist mid-sentence in the report editor. The
 * reslice itself is only a few milliseconds a plane, but assembling the volume
 * touches every one of 200 million voxels, and doing that on the UI thread
 * would freeze the page for as long as it takes.
 *
 * Slices arrive one at a time as they decode, rather than as one big transfer,
 * because they are COPIES of Cornerstone's cached pixel data. Transferring the
 * originals would detach them and empty the viewer's own image cache.
 *
 * This file is plain JS, not TS: it is compiled by the bundler's worker loader
 * from a `new URL(...)` reference, matching the existing histogram worker.
 */

/** The volume being assembled, or null between studies. */
let state = null;

function makeVoxelArray(bitsAllocated, pixelRepresentation, length) {
  if (bitsAllocated > 8) {
    return pixelRepresentation === 1 ? new Int16Array(length) : new Uint16Array(length);
  }
  return pixelRepresentation === 1 ? new Int8Array(length) : new Uint8Array(length);
}

/** Round half to even — numpy's rint, which the server reformatter uses. */
function rintHalfToEven(value) {
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

function slabStep(thicknessMm, spacingMm) {
  if (!Number.isFinite(thicknessMm) || !Number.isFinite(spacingMm) || spacingMm <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(thicknessMm / spacingMm));
}

const api = {
  /**
   * Allocate the volume.
   *
   * Allocation is separated from filling so an out-of-memory failure surfaces
   * here, before any slice has been fetched, rather than partway through a
   * long load with a report already open.
   */
  begin({ geometry, bitsAllocated, pixelRepresentation }) {
    const length = geometry.columns * geometry.rows * geometry.slices;
    state = {
      geometry,
      voxels: makeVoxelArray(bitsAllocated, pixelRepresentation, length),
      filled: new Uint8Array(geometry.slices),
    };
    return { bytes: state.voxels.byteLength };
  },

  /**
   * Write one decoded slice at its position in the stacking order.
   *
   * `index` is the ordered position, not the order it arrived in: slices are
   * fetched concurrently and complete out of order, and writing them by arrival
   * would interleave the patient.
   */
  addSlice({ index, pixels }) {
    if (!state) {
      throw new Error('reformat worker: addSlice before begin');
    }
    const { columns, rows } = state.geometry;
    const expected = columns * rows;
    if (pixels.length !== expected) {
      throw new Error(
        `reformat worker: slice ${index} has ${pixels.length} samples, expected ${expected}`
      );
    }
    state.voxels.set(pixels, index * expected);
    state.filled[index] = 1;
  },

  /** Slices still missing — a non-empty result means the volume has holes. */
  missingSlices() {
    if (!state) {
      return [];
    }
    const missing = [];
    state.filled.forEach((done, index) => {
      if (!done) {
        missing.push(index);
      }
    });
    return missing;
  },

  /**
   * Reslice one plane and hand back its pixels.
   *
   * The buffer is transferred rather than copied, so a plane costs one
   * allocation and no duplication on the way out.
   */
  extract({ plane, index, thicknessMm }) {
    if (!state) {
      throw new Error('reformat worker: extract before begin');
    }

    const { columns, rows, slices, rowSpacing, colSpacing } = state.geometry;
    const isCoronal = plane === 'coronal';
    const extent = isCoronal ? rows : columns;
    const step = slabStep(thicknessMm, isCoronal ? rowSpacing : colSpacing);
    const width = isCoronal ? columns : rows;

    const start = index * step;
    if (index < 0 || start >= extent) {
      throw new RangeError(`reformat plane ${index} is outside the ${plane} range`);
    }
    // The final slab is short when the extent is not a whole multiple of the
    // step; dividing by the requested step would darken that last plane.
    const end = Math.min(start + step, extent);
    const slab = end - start;

    const out = makeVoxelArray(
      state.voxels.BYTES_PER_ELEMENT > 1 ? 16 : 8,
      state.voxels instanceof Int16Array || state.voxels instanceof Int8Array ? 1 : 0,
      width * slices
    );

    const sliceStride = rows * columns;
    const voxels = state.voxels;

    for (let z = 0; z < slices; z++) {
      // Superior-first, matching the server reformatter.
      const outBase = (slices - 1 - z) * width;
      const sliceBase = z * sliceStride;

      for (let i = 0; i < width; i++) {
        let sum = 0;
        if (isCoronal) {
          for (let y = start; y < end; y++) {
            sum += voxels[sliceBase + y * columns + i];
          }
        } else {
          for (let x = start; x < end; x++) {
            sum += voxels[sliceBase + i * columns + x];
          }
        }
        out[outBase + i] = rintHalfToEven(sum / slab);
      }
    }

    return { pixels: out, width, height: slices };
  },

  /**
   * Drop the volume.
   *
   * Called when the radiologist leaves the study. Without it the worker keeps
   * 381 MB alive for a study nobody is looking at, and the next one allocates
   * on top of it.
   */
  end() {
    state = null;
  },
};

expose(api);
