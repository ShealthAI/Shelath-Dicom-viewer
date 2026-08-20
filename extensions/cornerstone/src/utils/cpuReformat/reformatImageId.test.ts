import { makeReformatImageId, parseReformatImageId } from './reformatImageLoader';

/**
 * The imageId is the only thing carried between the viewport asking for a
 * picture and the worker producing one. A parse that quietly succeeds on
 * malformed input would ask for the wrong plane - and a coronal shown where a
 * sagittal was requested is still a plausible-looking image of the patient.
 */

describe('reformat imageIds', () => {
  it('round-trips', () => {
    const imageId = makeReformatImageId('ds-42', 'coronal', 17);

    expect(imageId).toBe('shealthmpr:ds-42/coronal/17');
    expect(parseReformatImageId(imageId)).toEqual({
      sessionId: 'ds-42',
      plane: 'coronal',
      index: 17,
    });
  });

  it('handles index zero', () => {
    // A falsy index is the classic place a truthiness check drops the first
    // plane of the series.
    expect(parseReformatImageId(makeReformatImageId('s', 'sagittal', 0))).toEqual({
      sessionId: 's',
      plane: 'sagittal',
      index: 0,
    });
  });

  it('ignores imageIds belonging to other loaders', () => {
    // The provider sits in a shared chain; claiming a DICOM imageId here would
    // shadow real study metadata.
    expect(parseReformatImageId('wadors:https://pacs/studies/1.2.3/frames/1')).toBeUndefined();
    expect(parseReformatImageId('dicomweb:https://example/x.dcm')).toBeUndefined();
    expect(parseReformatImageId('')).toBeUndefined();
  });

  it('refuses an unknown plane rather than defaulting to one', () => {
    expect(parseReformatImageId('shealthmpr:ds-42/axial/3')).toBeUndefined();
    expect(parseReformatImageId('shealthmpr:ds-42//3')).toBeUndefined();
  });

  it('refuses a non-numeric or missing index', () => {
    expect(parseReformatImageId('shealthmpr:ds-42/coronal/abc')).toBeUndefined();
    expect(parseReformatImageId('shealthmpr:ds-42/coronal/')).toBeUndefined();
    expect(parseReformatImageId('shealthmpr:ds-42/coronal')).toBeUndefined();
  });

  it('refuses a missing session', () => {
    expect(parseReformatImageId('shealthmpr:/coronal/3')).toBeUndefined();
  });

  it('keeps session ids containing dots intact', () => {
    // Display set UIDs are dotted DICOM UIDs, and they are what identifies a
    // session in practice.
    const sessionId = '1.2.840.113619.2.55.3.604688119.971.1618';
    const parsed = parseReformatImageId(makeReformatImageId(sessionId, 'coronal', 5));

    expect(parsed?.sessionId).toBe(sessionId);
  });
});
