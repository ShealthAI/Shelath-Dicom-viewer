import {
  NotReformattable,
  deriveVolumeGeometry,
  slicePosition,
  type SlicePlane,
} from './deriveVolumeGeometry';

/**
 * Everything here guards a failure that produces a plausible-looking image.
 * A reformat built from misordered slices is still recognisably anatomy; one
 * built across a spacing gap is still smooth. Neither announces itself, and
 * both get reported on. So the rule is: refuse loudly rather than render
 * something that cannot be trusted.
 */

const AXIAL = [1, 0, 0, 0, 1, 0]; // rows run L->R, columns A->P; normal is +z

function axialSlice(z: number, overrides: Partial<SlicePlane> = {}): SlicePlane {
  return {
    rows: 4,
    columns: 4,
    rowPixelSpacing: 0.7,
    columnPixelSpacing: 0.7,
    imageOrientationPatient: AXIAL,
    imagePositionPatient: [0, 0, z],
    ...overrides,
  };
}

describe('slicePosition', () => {
  it('projects onto the normal, so oblique acquisitions still order correctly', () => {
    // A 45-degree normal: neither x nor z alone would order these.
    const normal = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const near = axialSlice(0, { imagePositionPatient: [0, 0, 0] });
    const far = axialSlice(0, { imagePositionPatient: [10, 0, 10] });

    expect(slicePosition(near, normal)).toBeCloseTo(0);
    expect(slicePosition(far, normal)).toBeCloseTo(14.142, 3);
  });

  it('refuses a slice with no position rather than guessing', () => {
    expect(() => slicePosition(axialSlice(0, { imagePositionPatient: undefined }), [0, 0, 1]))
      .toThrow(NotReformattable);
  });
});

describe('deriveVolumeGeometry', () => {
  it('derives dimensions and spacing from the series', () => {
    const { geometry } = deriveVolumeGeometry([axialSlice(0), axialSlice(1), axialSlice(2)]);

    expect(geometry).toEqual({
      columns: 4,
      rows: 4,
      slices: 3,
      colSpacing: 0.7,
      rowSpacing: 0.7,
      sliceSpacing: 1,
    });
  });

  it('orders by position along the normal, not by arrival order', () => {
    // The reported bug shape: slices delivered out of order by the PACS. Sorting
    // by anything other than geometry yields an interleaved or inverted volume
    // that still looks like anatomy.
    const { order } = deriveVolumeGeometry([axialSlice(2), axialSlice(0), axialSlice(1)]);

    expect(order).toEqual([1, 2, 0]);
  });

  it('reports the origin of the first slice in geometric order', () => {
    const { origin } = deriveVolumeGeometry([axialSlice(5), axialSlice(1), axialSlice(3)]);

    expect(origin).toEqual([0, 0, 1]);
  });

  it('handles a descending acquisition', () => {
    // Feet-first vs head-first scanners disagree about direction; both are valid.
    const { order, geometry } = deriveVolumeGeometry([
      axialSlice(0),
      axialSlice(-1),
      axialSlice(-2),
    ]);

    expect(order).toEqual([2, 1, 0]);
    expect(geometry.sliceSpacing).toBe(1);
  });

  it('refuses a series with a gap in it', () => {
    // Two stitched acquisitions, or a dropped slice. Reformatting across it
    // compresses the patient at that level with nothing visible to show for it.
    expect(() => deriveVolumeGeometry([axialSlice(0), axialSlice(1), axialSlice(5)])).toThrow(
      /spacing varies/
    );
  });

  it('tolerates spacing jitter within the documented tolerance', () => {
    // Real scanners emit positions that are not bit-exact.
    const { geometry } = deriveVolumeGeometry([
      axialSlice(0),
      axialSlice(1.0),
      axialSlice(2.01),
    ]);

    expect(geometry.sliceSpacing).toBeCloseTo(1.005, 3);
  });

  it('refuses duplicate slice positions', () => {
    // A re-push storing the same instance twice would otherwise double-weight
    // that level in every slab average.
    expect(() => deriveVolumeGeometry([axialSlice(0), axialSlice(0), axialSlice(1)])).toThrow(
      /duplicate positions/
    );
  });

  it('refuses a series whose orientation changes partway', () => {
    const tilted = axialSlice(2, { imageOrientationPatient: [1, 0, 0, 0, 0.9, 0.43] });

    expect(() => deriveVolumeGeometry([axialSlice(0), axialSlice(1), tilted])).toThrow(
      /mixed ImageOrientationPatient/
    );
  });

  it('refuses a series whose slices differ in size', () => {
    const bigger = axialSlice(2, { rows: 8, columns: 8 });

    expect(() => deriveVolumeGeometry([axialSlice(0), axialSlice(1), bigger])).toThrow(
      /differ in size/
    );
  });

  it('refuses a series with no pixel spacing', () => {
    // It would render. Every measurement on it would be meaningless, which is
    // worse than not offering the reformat at all.
    const noSpacing = [
      axialSlice(0, { rowPixelSpacing: undefined }),
      axialSlice(1, { rowPixelSpacing: undefined }),
    ];

    expect(() => deriveVolumeGeometry(noSpacing)).toThrow(/PixelSpacing/);
  });

  it('refuses a single slice and an empty series', () => {
    expect(() => deriveVolumeGeometry([axialSlice(0)])).toThrow(/single slice/);
    expect(() => deriveVolumeGeometry([])).toThrow(/no slices/);
  });

  it('refuses a series with no orientation', () => {
    const noOrientation = [
      axialSlice(0, { imageOrientationPatient: undefined }),
      axialSlice(1, { imageOrientationPatient: undefined }),
    ];

    expect(() => deriveVolumeGeometry(noOrientation)).toThrow(/ImageOrientationPatient/);
  });
});
