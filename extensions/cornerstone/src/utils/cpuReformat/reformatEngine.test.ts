import {
  extractPlane,
  planeCount,
  planeGeometry,
  rintHalfToEven,
  slabStep,
  volumeByteLength,
  type VolumeGeometry,
} from './reformatEngine';

/**
 * These planes go in front of a radiologist and get measured on. The failures
 * that matter here are the quiet ones: a transposed axis still looks like
 * anatomy, a wrong pixel spacing still renders, an upside-down coronal is only
 * obvious if you already know which end is the head. So the geometry is pinned
 * voxel by voxel against a volume whose every value encodes its own coordinates.
 */

/** 3x4x5 volume (cols x rows x slices) where each voxel is z*100 + y*10 + x. */
function codedVolume() {
  const geometry: VolumeGeometry = {
    columns: 3,
    rows: 4,
    slices: 5,
    colSpacing: 0.5,
    rowSpacing: 0.5,
    sliceSpacing: 2,
  };
  const voxels = new Uint16Array(geometry.columns * geometry.rows * geometry.slices);

  for (let z = 0; z < geometry.slices; z++) {
    for (let y = 0; y < geometry.rows; y++) {
      for (let x = 0; x < geometry.columns; x++) {
        voxels[z * geometry.rows * geometry.columns + y * geometry.columns + x] =
          z * 100 + y * 10 + x;
      }
    }
  }

  return { geometry, voxels };
}

describe('slabStep', () => {
  it('collapses as many source planes as fit the requested thickness', () => {
    expect(slabStep(3, 1)).toBe(3);
    expect(slabStep(3, 0.5)).toBe(6);
  });

  it('never drops below one plane', () => {
    // A thickness finer than the acquisition cannot invent resolution, and a
    // step of 0 would yield no planes at all.
    expect(slabStep(1, 3)).toBe(1);
    expect(slabStep(0, 1)).toBe(1);
  });

  it('survives missing or nonsensical spacing', () => {
    expect(slabStep(3, 0)).toBe(1);
    expect(slabStep(3, Number.NaN)).toBe(1);
    expect(slabStep(Number.NaN, 1)).toBe(1);
  });
});

describe('rintHalfToEven', () => {
  it('matches numpy rint, which the server reformatter uses', () => {
    // Math.round would give 1, 3, -1, -3 here. The two implementations must
    // agree or the same slab stores a different value depending on where it
    // was computed.
    expect(rintHalfToEven(0.5)).toBe(0);
    expect(rintHalfToEven(1.5)).toBe(2);
    expect(rintHalfToEven(2.5)).toBe(2);
    expect(rintHalfToEven(3.5)).toBe(4);
    // numpy returns -0.0 here. Compared with toEqual rather than toBe because
    // Object.is separates -0 from 0, a distinction that disappears the moment
    // the value is stored in an integer array - which is the only thing that
    // ever happens to it.
    expect(rintHalfToEven(-0.5)).toEqual(0);
    expect(rintHalfToEven(-1.5)).toBe(-2);
    expect(rintHalfToEven(-2.5)).toBe(-2);
  });

  it('rounds normally away from the midpoint', () => {
    expect(rintHalfToEven(1.4)).toBe(1);
    expect(rintHalfToEven(1.6)).toBe(2);
    expect(rintHalfToEven(-1.4)).toBe(-1);
    expect(rintHalfToEven(-1.6)).toBe(-2);
  });
});

describe('planeGeometry', () => {
  const { geometry } = codedVolume();

  it('sizes a coronal plane as columns wide by slices tall', () => {
    const plane = planeGeometry(geometry, 'coronal', 0);
    expect(plane.width).toBe(geometry.columns);
    expect(plane.height).toBe(geometry.slices);
  });

  it('sizes a sagittal plane as rows wide by slices tall', () => {
    const plane = planeGeometry(geometry, 'sagittal', 0);
    expect(plane.width).toBe(geometry.rows);
    expect(plane.height).toBe(geometry.slices);
  });

  it('stacks both planes along the slice axis, so vertical spacing is slice spacing', () => {
    // Get this wrong and nothing looks broken - every distance measured on the
    // reformat is simply wrong.
    expect(planeGeometry(geometry, 'coronal', 0).rowSpacing).toBe(geometry.sliceSpacing);
    expect(planeGeometry(geometry, 'sagittal', 0).rowSpacing).toBe(geometry.sliceSpacing);
  });

  it('takes horizontal spacing from whichever source axis it runs along', () => {
    expect(planeGeometry(geometry, 'coronal', 0).columnSpacing).toBe(geometry.colSpacing);
    expect(planeGeometry(geometry, 'sagittal', 0).columnSpacing).toBe(geometry.rowSpacing);
  });

  it('reports the real thickness, which is a whole number of source planes', () => {
    // 3mm requested against 0.5mm rows collapses 6 rows = 3mm exactly.
    expect(planeGeometry(geometry, 'coronal', 3).thickness).toBe(3);
    // 5mm against 0.5mm rounds to 10 rows = 5mm.
    expect(planeGeometry(geometry, 'coronal', 5).thickness).toBe(5);
  });
});

describe('planeCount', () => {
  const { geometry } = codedVolume();

  it('yields one plane per source row or column when not slabbing', () => {
    expect(planeCount(geometry, 'coronal', 0)).toBe(geometry.rows);
    expect(planeCount(geometry, 'sagittal', 0)).toBe(geometry.columns);
  });

  it('includes the short final slab rather than dropping it', () => {
    // 4 rows at a step of 3 is one full slab plus a remainder of one. Flooring
    // would silently discard the last row of the patient.
    expect(planeCount(geometry, 'coronal', 1.5)).toBe(2);
  });

  it('returns nothing for an empty volume', () => {
    expect(planeCount({ ...geometry, rows: 0 }, 'coronal', 0)).toBe(0);
  });
});

describe('extractPlane', () => {
  const { geometry, voxels } = codedVolume();

  it('reads a coronal plane from the fixed row across every slice', () => {
    // Row y=2, no slabbing. Output is columns wide, slices tall, and the slice
    // axis is reversed so the LAST acquired slice is the first output row.
    const plane = extractPlane(voxels, geometry, 'coronal', 2, 0);

    expect(Array.from(plane)).toEqual([
      420, 421, 422, // z=4
      320, 321, 322, // z=3
      220, 221, 222, // z=2
      120, 121, 122, // z=1
      20, 21, 22, // z=0
    ]);
  });

  it('reads a sagittal plane from the fixed column across every slice', () => {
    // Column x=1. Output is rows wide, slices tall, same superior-first flip.
    const plane = extractPlane(voxels, geometry, 'sagittal', 1, 0);

    expect(Array.from(plane)).toEqual([
      401, 411, 421, 431, // z=4
      301, 311, 321, 331, // z=3
      201, 211, 221, 231, // z=2
      101, 111, 121, 131, // z=1
      1, 11, 21, 31, // z=0
    ]);
  });

  it('puts the most superior slice at the top', () => {
    // The single check that catches an upside-down reformat, which otherwise
    // looks like perfectly normal anatomy.
    const plane = extractPlane(voxels, geometry, 'coronal', 0, 0);
    const topRow = Array.from(plane.slice(0, geometry.columns));
    const bottomRow = Array.from(plane.slice(-geometry.columns));

    expect(topRow.every(v => Math.floor(v / 100) === geometry.slices - 1)).toBe(true);
    expect(bottomRow.every(v => Math.floor(v / 100) === 0)).toBe(true);
  });

  it('averages every voxel in a slab rather than sampling one', () => {
    // Rows 0 and 1 at z=0 are 0,1,2 and 10,11,12 -> means 5,6,7. A sampling
    // implementation would return one of the two rows unchanged, and could
    // hide a finding lying in the other.
    const plane = extractPlane(voxels, geometry, 'coronal', 0, 1);
    const bottomRow = Array.from(plane.slice(-geometry.columns));

    expect(bottomRow).toEqual([5, 6, 7]);
  });

  it('divides the short final slab by its real size, not the requested step', () => {
    // 4 rows, step 3: the last slab holds only row 3. Dividing by 3 would
    // darken the final plane to a third of its true value.
    const plane = extractPlane(voxels, geometry, 'coronal', 1, 1.5);
    const bottomRow = Array.from(plane.slice(-geometry.columns));

    expect(bottomRow).toEqual([30, 31, 32]);
  });

  it('reuses a caller-supplied buffer', () => {
    // Reformatting a whole series allocates one plane at a time; reusing the
    // buffer keeps a 700-plane run from thrashing the collector.
    const reused = new Uint16Array(geometry.columns * geometry.slices);
    const result = extractPlane(voxels, geometry, 'coronal', 2, 0, reused);

    expect(result).toBe(reused);
    expect(reused[0]).toBe(420);
  });

  it('refuses a buffer of the wrong size instead of writing past it', () => {
    expect(() => extractPlane(voxels, geometry, 'coronal', 0, 0, new Uint16Array(4))).toThrow(
      RangeError
    );
  });

  it('refuses a plane index outside the volume', () => {
    expect(() => extractPlane(voxels, geometry, 'coronal', geometry.rows, 0)).toThrow(RangeError);
    expect(() => extractPlane(voxels, geometry, 'coronal', -1, 0)).toThrow(RangeError);
  });

  it('preserves signed values', () => {
    // CT stores HU as signed 16-bit. Losing the sign turns air into bone.
    const signed = new Int16Array([-1000, -500, 0, 500]);
    const plane = extractPlane(
      signed,
      { columns: 2, rows: 2, slices: 1, colSpacing: 1, rowSpacing: 1, sliceSpacing: 1 },
      'coronal',
      0,
      0
    );

    expect(plane).toBeInstanceOf(Int16Array);
    expect(Array.from(plane)).toEqual([-1000, -500]);
  });

  it('covers every source voxel across the full set of planes', () => {
    // The property that makes this safe to report from: nothing is skipped.
    const seen = new Set<number>();
    for (let i = 0; i < planeCount(geometry, 'coronal', 0); i++) {
      extractPlane(voxels, geometry, 'coronal', i, 0).forEach(v => seen.add(v));
    }

    expect(seen.size).toBe(voxels.length);
  });
});

describe('volumeByteLength', () => {
  it('sizes a real CT so the study can be refused before allocating', () => {
    const bytes = volumeByteLength(
      { columns: 512, rows: 512, slices: 761, colSpacing: 1, rowSpacing: 1, sliceSpacing: 1 },
      2
    );

    // ~400 MB - the study from the field report that killed the GPU path.
    expect(Math.round(bytes / 1048576)).toBe(381);
  });
});
