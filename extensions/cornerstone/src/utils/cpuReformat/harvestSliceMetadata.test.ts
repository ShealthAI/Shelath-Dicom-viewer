import {
  bytesPerVoxel,
  harvestPixelDescriptor,
  harvestPlane,
  harvestSeries,
  voxelArrayFor,
  type MetaDataProvider,
} from './harvestSliceMetadata';

/**
 * The failures guarded here are photometric rather than geometric, which makes
 * them worse: a reformat with the wrong rescale renders perfectly, looks like
 * normal anatomy, and reports the wrong density. Air at -1000 HU becomes
 * something in soft-tissue range. Nothing on screen says so.
 */

function provider(modules: Record<string, Record<string, unknown>>): MetaDataProvider {
  return { get: (type: string) => modules[type] };
}

const PLANE = {
  rows: 512,
  columns: 512,
  rowPixelSpacing: 0.7,
  columnPixelSpacing: 0.7,
  imagePositionPatient: [0, 0, 5],
  imageOrientationPatient: [1, 0, 0, 0, 1, 0],
};

describe('harvestPlane', () => {
  it('reads plane geometry', () => {
    const plane = harvestPlane(provider({ imagePlaneModule: PLANE }), 'img:1');

    expect(plane).toEqual({
      rows: 512,
      columns: 512,
      rowPixelSpacing: 0.7,
      columnPixelSpacing: 0.7,
      imagePositionPatient: [0, 0, 5],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    });
  });

  it('falls back to the raw PixelSpacing pair', () => {
    // Which of these a data source populates varies; both mean the same thing,
    // and PixelSpacing is ordered [row, column].
    const plane = harvestPlane(
      provider({
        imagePlaneModule: {
          ...PLANE,
          rowPixelSpacing: undefined,
          columnPixelSpacing: undefined,
          pixelSpacing: [0.488, 0.488],
        },
      }),
      'img:1'
    );

    expect(plane?.rowPixelSpacing).toBe(0.488);
    expect(plane?.columnPixelSpacing).toBe(0.488);
  });

  it('parses string-encoded numbers', () => {
    // DICOM DS values arrive as strings from some providers.
    const plane = harvestPlane(
      provider({ imagePlaneModule: { ...PLANE, rowPixelSpacing: '0.625' } }),
      'img:1'
    );

    expect(plane?.rowPixelSpacing).toBe(0.625);
  });

  it('leaves absent geometry undefined rather than inventing it', () => {
    // deriveVolumeGeometry refuses a series missing these. A plausible default
    // here would turn a clean refusal into a wrong image.
    const plane = harvestPlane(
      provider({ imagePlaneModule: { rows: 512, columns: 512 } }),
      'img:1'
    );

    expect(plane?.rowPixelSpacing).toBeUndefined();
    expect(plane?.imagePositionPatient).toBeUndefined();
  });

  it('returns nothing when the module or its dimensions are missing', () => {
    expect(harvestPlane(provider({}), 'img:1')).toBeUndefined();
    expect(harvestPlane(provider({ imagePlaneModule: { rows: 512 } }), 'img:1')).toBeUndefined();
  });
});

describe('harvestPixelDescriptor', () => {
  it('carries the modality LUT through', () => {
    const pixel = harvestPixelDescriptor(
      provider({
        imagePixelModule: { bitsAllocated: 16, pixelRepresentation: 1 },
        modalityLutModule: { rescaleSlope: 1, rescaleIntercept: -1024 },
        voiLutModule: { windowCenter: 40, windowWidth: 400 },
        generalSeriesModule: { modality: 'CT' },
      }),
      'img:1'
    );

    expect(pixel).toEqual({
      bitsAllocated: 16,
      pixelRepresentation: 1,
      rescaleSlope: 1,
      rescaleIntercept: -1024,
      windowCenter: 40,
      windowWidth: 400,
      invert: false,
      modality: 'CT',
    });
  });

  it('defaults an absent rescale to identity, which is what absence means', () => {
    // DICOM: no Rescale Slope/Intercept means slope 1, intercept 0. This is the
    // specification, not a guess.
    const pixel = harvestPixelDescriptor(provider({}), 'img:1');

    expect(pixel.rescaleSlope).toBe(1);
    expect(pixel.rescaleIntercept).toBe(0);
  });

  it('does not invent a window when none is published', () => {
    // Undefined lets the viewer apply its own default; a number here would
    // override the radiologist's modality preset with a fabricated one.
    const pixel = harvestPixelDescriptor(provider({}), 'img:1');

    expect(pixel.windowCenter).toBeUndefined();
    expect(pixel.windowWidth).toBeUndefined();
  });

  it('takes the first value of a multi-valued window', () => {
    // Multi-valued VOI is legal; the first pair is the primary preset.
    const pixel = harvestPixelDescriptor(
      provider({ voiLutModule: { windowCenter: [40, 300], windowWidth: [400, 1500] } }),
      'img:1'
    );

    expect(pixel.windowCenter).toBe(40);
    expect(pixel.windowWidth).toBe(400);
  });

  it('flags MONOCHROME1 as inverted', () => {
    // Missing this renders the reformat as a photographic negative.
    expect(
      harvestPixelDescriptor(
        provider({ imagePixelModule: { photometricInterpretation: 'MONOCHROME1' } }),
        'img:1'
      ).invert
    ).toBe(true);

    expect(
      harvestPixelDescriptor(
        provider({ imagePixelModule: { photometricInterpretation: 'MONOCHROME2' } }),
        'img:1'
      ).invert
    ).toBe(false);
  });
});

describe('harvestSeries', () => {
  const full = provider({
    imagePlaneModule: PLANE,
    modalityLutModule: { rescaleSlope: 1, rescaleIntercept: -1024 },
  });

  it('collects every slice', () => {
    const { planes, pixel } = harvestSeries(full, ['a', 'b', 'c']);

    expect(planes).toHaveLength(3);
    expect(pixel.rescaleIntercept).toBe(-1024);
  });

  it('refuses the whole series when one slice is unreadable', () => {
    // Reformatting the readable subset would silently omit levels of the
    // patient, with nothing on screen to show a gap.
    const patchy: MetaDataProvider = {
      get: (type, imageId) =>
        imageId === 'b' ? undefined : type === 'imagePlaneModule' ? PLANE : {},
    };

    expect(() => harvestSeries(patchy, ['a', 'b', 'c'])).toThrow(/slice metadata unavailable/);
  });

  it('refuses an empty series', () => {
    expect(() => harvestSeries(full, [])).toThrow(/no images/);
  });
});

describe('storage format', () => {
  it('sizes voxels by bit depth', () => {
    expect(bytesPerVoxel({ bitsAllocated: 16 } as never)).toBe(2);
    expect(bytesPerVoxel({ bitsAllocated: 8 } as never)).toBe(1);
  });

  it('picks a signed array for signed data', () => {
    // CT stores HU signed. An unsigned array turns -1000 into 64536.
    expect(voxelArrayFor({ bitsAllocated: 16, pixelRepresentation: 1 } as never, 4)).toBeInstanceOf(
      Int16Array
    );
    expect(voxelArrayFor({ bitsAllocated: 16, pixelRepresentation: 0 } as never, 4)).toBeInstanceOf(
      Uint16Array
    );
    expect(voxelArrayFor({ bitsAllocated: 8, pixelRepresentation: 0 } as never, 4)).toBeInstanceOf(
      Uint8Array
    );
  });
});
