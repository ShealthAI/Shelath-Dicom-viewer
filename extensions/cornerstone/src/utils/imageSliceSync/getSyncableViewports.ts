import { DisplaySetService, ViewportGridService } from '@ohif/core';

/**
 * Which viewports take part in scroll synchronisation.
 *
 * WHY THIS EXISTS
 * Radiologists reported that with sync enabled "only the image on the right
 * scrolls". It is not a missing feature — the previous selector admitted a
 * viewport only when its display set was `isReconstructable`, so any panel
 * showing a scout/localiser, a two-slice series, a CR/DX, or anything else the
 * pipeline did not mark reconstructable was silently dropped from the sync
 * group. The panel then sat still while its neighbour scrolled, with nothing in
 * the UI to say why.
 *
 * Reconstructability is the wrong test. It answers "can this be turned into a
 * volume for MPR", which has nothing to do with "can this stack be stepped
 * through in step with another". A plain stack scrolls perfectly well.
 *
 * WHAT IS ACTUALLY REQUIRED
 * Cornerstone's imageSlice callback matches slices by patient position, using
 * the frame of reference or a computed spatial registration. So a viewport can
 * participate if it simply HAS images. Whether a given pair ends up matching is
 * the callback's business, decided per pair at runtime — not something to
 * pre-filter whole panels on.
 *
 * The old implementation also had a loop bug: it `return`ed on the FIRST
 * display set of a viewport, so for a viewport with several display sets only
 * the first was ever considered.
 */

export interface SyncableViewportsOptions {
  /**
   * Restrict to display sets that can be reconstructed into a volume.
   * Off by default — see above. Kept so a caller that genuinely needs volume
   * semantics (e.g. a future slab-thickness sync) can ask for it explicitly.
   */
  requireReconstructable?: boolean;
}

/**
 * Viewports eligible for slice synchronisation, in grid order.
 *
 * A viewport qualifies when it is displaying at least one display set that has
 * images. Empty panels are skipped: adding them to the group would do nothing
 * and would make the toggle's "is sync on?" state ambiguous.
 */
export function getSyncableViewports(
  viewportGridService: ViewportGridService,
  displaySetService: DisplaySetService,
  options: SyncableViewportsOptions = {}
) {
  const { requireReconstructable = false } = options;
  const { viewports } = viewportGridService.getState();

  return [...viewports.values()].filter(viewport => {
    const uids = viewport?.displaySetInstanceUIDs;
    if (!uids?.length) {
      return false;
    }

    // `some`, not a loop with an early return: a viewport with several display
    // sets qualifies if ANY of them is displayable, and every UID is examined.
    return uids.some(uid => {
      const displaySet = displaySetService.getDisplaySetByUID(uid);
      if (!displaySet) {
        return false;
      }
      if (requireReconstructable) {
        return Boolean(displaySet.isReconstructable);
      }
      // Anything with image content can be stepped through. `numImageFrames`
      // is absent on some display set types, so fall back to the images array
      // before deciding a panel has nothing to scroll.
      const frames = Number(displaySet.numImageFrames ?? 0);
      return frames > 0 || Boolean(displaySet.images?.length) || Boolean(displaySet.instances?.length);
    });
  });
}

export default getSyncableViewports;
