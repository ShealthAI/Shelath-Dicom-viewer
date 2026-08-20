import { getSyncableViewports } from './getSyncableViewports';

const IMAGE_SLICE_SYNC_NAME = 'IMAGE_SLICE_SYNC';

export default function toggleImageSliceSync({
  servicesManager,
  viewports: providedViewports,
  syncId,
}: withAppTypes) {
  const { syncGroupService, viewportGridService, displaySetService, cornerstoneViewportService } =
    servicesManager.services;

  syncId ||= IMAGE_SLICE_SYNC_NAME;

  // Every panel with images participates. Filtering on `isReconstructable`
  // here is what made a panel silently refuse to scroll with its neighbour —
  // see getSyncableViewports for the full reasoning.
  const viewports =
    providedViewports || getSyncableViewports(viewportGridService, displaySetService);

  // Todo: right now we don't have a proper way to define specific
  // viewports to add to synchronizers, and right now it is global or not
  // after we do that, we should do fine grained control of the synchronizers
  const someViewportHasSync = viewports.some(viewport => {
    const syncStates = syncGroupService.getSynchronizersForViewport(
      viewport.viewportOptions.viewportId
    );

    const imageSync = syncStates.find(syncState => syncState.id === syncId);

    return !!imageSync;
  });

  if (someViewportHasSync) {
    return disableSync(syncId, servicesManager);
  }

  // create synchronization group and add the viewports to it.
  viewports.forEach(gridViewport => {
    const { viewportId } = gridViewport.viewportOptions;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!viewport) {
      return;
    }
    syncGroupService.addViewportToSyncGroup(viewportId, viewport.getRenderingEngine().id, {
      type: 'imageSlice',
      id: syncId,
      source: true,
      target: true,
    });
  });
}

function disableSync(syncName, servicesManager: AppTypes.ServicesManager) {
  const { syncGroupService, viewportGridService, displaySetService, cornerstoneViewportService } =
    servicesManager.services;
  // Must use the SAME selector as enabling, or a panel that was added to the
  // group cannot be removed from it and stays wired to a synchroniser the UI
  // believes is off.
  const viewports = getSyncableViewports(viewportGridService, displaySetService);
  viewports.forEach(gridViewport => {
    const { viewportId } = gridViewport.viewportOptions;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!viewport) {
      return;
    }
    syncGroupService.removeViewportFromSyncGroup(
      viewport.id,
      viewport.getRenderingEngine().id,
      syncName
    );
  });
}
