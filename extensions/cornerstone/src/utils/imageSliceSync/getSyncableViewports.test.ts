import { getSyncableViewports } from './getSyncableViewports';

/**
 * The behaviour under test is the radiologist-visible one: with scroll link on,
 * EVERY panel showing images scrolls. The previous selector admitted only
 * `isReconstructable` display sets, so a panel holding a scout, a CR, or a short
 * series sat motionless while its neighbour scrolled — reported as "only the
 * image on the right scrolls".
 */

function grid(viewports: Array<{ id: string; uids: string[] }>) {
  return {
    getState: () => ({
      viewports: new Map(
        viewports.map(v => [
          v.id,
          { viewportOptions: { viewportId: v.id }, displaySetInstanceUIDs: v.uids },
        ])
      ),
    }),
  } as never;
}

function sets(map: Record<string, Record<string, unknown>>) {
  return { getDisplaySetByUID: (uid: string) => map[uid] } as never;
}

// The selector returns OHIF grid viewports; we only care about identity here,
// so read the id through a narrow structural type rather than importing the
// full GridViewport shape into a test.
const ids = (result: unknown[]) =>
  (result as Array<{ viewportOptions: { viewportId: string } }>).map(
    v => v.viewportOptions.viewportId
  );

describe('getSyncableViewports', () => {
  it('includes a non-reconstructable panel — the reported bug', () => {
    // Left: a scout/localiser (not reconstructable). Right: a thin-slice CT.
    // Both must scroll together; previously only the right one did.
    const result = getSyncableViewports(
      grid([
        { id: 'left', uids: ['scout'] },
        { id: 'right', uids: ['ct'] },
      ]),
      sets({
        scout: { isReconstructable: false, numImageFrames: 2 },
        ct: { isReconstructable: true, numImageFrames: 400 },
      })
    );

    expect(ids(result)).toEqual(['left', 'right']);
  });

  it('skips empty panels', () => {
    // An empty panel in the group would do nothing and make the toggle's
    // on/off state ambiguous.
    const result = getSyncableViewports(
      grid([
        { id: 'empty', uids: [] },
        { id: 'ct', uids: ['ct'] },
      ]),
      sets({ ct: { numImageFrames: 100 } })
    );

    expect(ids(result)).toEqual(['ct']);
  });

  it('skips a panel whose display set has no images', () => {
    const result = getSyncableViewports(
      grid([
        { id: 'sr', uids: ['report'] },
        { id: 'ct', uids: ['ct'] },
      ]),
      sets({ report: { numImageFrames: 0 }, ct: { numImageFrames: 100 } })
    );

    expect(ids(result)).toEqual(['ct']);
  });

  it('examines EVERY display set of a viewport, not just the first', () => {
    // The old implementation returned inside its loop after the first UID, so a
    // fusion/overlay panel was judged solely on whichever set happened to be
    // first.
    const result = getSyncableViewports(
      grid([{ id: 'fusion', uids: ['overlay-no-images', 'ct'] }]),
      sets({ 'overlay-no-images': { numImageFrames: 0 }, ct: { numImageFrames: 300 } })
    );

    expect(ids(result)).toEqual(['fusion']);
  });

  it('counts images from `images` or `instances` when numImageFrames is absent', () => {
    const result = getSyncableViewports(
      grid([
        { id: 'a', uids: ['byImages'] },
        { id: 'b', uids: ['byInstances'] },
      ]),
      sets({
        byImages: { images: [{}, {}] },
        byInstances: { instances: [{}, {}, {}] },
      })
    );

    expect(ids(result)).toEqual(['a', 'b']);
  });

  it('can still restrict to reconstructable sets when a caller needs volume semantics', () => {
    const result = getSyncableViewports(
      grid([
        { id: 'scout', uids: ['scout'] },
        { id: 'ct', uids: ['ct'] },
      ]),
      sets({
        scout: { isReconstructable: false, numImageFrames: 2 },
        ct: { isReconstructable: true, numImageFrames: 400 },
      }),
      { requireReconstructable: true }
    );

    expect(ids(result)).toEqual(['ct']);
  });

  it('tolerates a missing display set rather than throwing mid-scroll', () => {
    const result = getSyncableViewports(
      grid([{ id: 'stale', uids: ['gone'] }]),
      sets({})
    );

    expect(ids(result)).toEqual([]);
  });
});
