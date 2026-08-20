import { Types } from '@ohif/core';
import { cache as cs3DCache, Enums, volumeLoader } from '@cornerstonejs/core';

import getCornerstoneViewportType from '../../utils/getCornerstoneViewportType';
import {
  assessVolumeFeasibility,
  findAvailableReformats,
} from '../../utils/assessVolumeFeasibility';
import { StackViewportData, VolumeViewportData } from '../../types/CornerstoneCacheService';
import { VOLUME_LOADER_SCHEME } from '../../constants';

/**
 * Marks "this device cannot build this volume" as distinct from a genuine
 * failure. Anything else that throws while building volume data is a real
 * error and must keep propagating.
 */
const VOLUME_NOT_FEASIBLE = 'VolumeNotFeasibleError';

class CornerstoneCacheService {
  static REGISTRATION = {
    name: 'cornerstoneCacheService',
    altName: 'CornerstoneCacheService',
    create: ({ servicesManager }: Types.Extensions.ExtensionParams): CornerstoneCacheService => {
      return new CornerstoneCacheService(servicesManager);
    },
  };

  stackImageIds: Map<string, string[]> = new Map();
  volumeImageIds: Map<string, string[]> = new Map();
  readonly servicesManager: AppTypes.ServicesManager;

  constructor(servicesManager: AppTypes.ServicesManager) {
    this.servicesManager = servicesManager;
  }

  public getCacheSize() {
    return cs3DCache.getCacheSize();
  }

  public getCacheFreeSpace() {
    return cs3DCache.getBytesAvailable();
  }

  public async createViewportData(
    displaySets: Types.DisplaySet[],
    viewportOptions: AppTypes.ViewportGrid.GridViewportOptions,
    dataSource: unknown,
    initialImageIndex?: number
  ): Promise<StackViewportData | VolumeViewportData> {
    const viewportType = viewportOptions.viewportType as string;

    const cs3DViewportType = getCornerstoneViewportType(viewportType, displaySets);
    let viewportData: StackViewportData | VolumeViewportData;

    // Native Generic ("next") viewport types (e.g. PLANAR_NEXT) intentionally
    // collapse the stack/volume distinction into a single type, so they cannot
    // drive the stack-vs-volume data-builder decision below. Resolve the data
    // shape from the legacy mapping (which preserves that distinction) and keep
    // the resolved native type as the produced viewportData's viewportType.
    let dataShapeType = getCornerstoneViewportType(viewportType, displaySets, false);

    // A data overlay (fusion) of two or more reconstructable image display sets
    // must render as a volume viewport so the source and overlay share one
    // representation (volume slice). Without this, a next (PLANAR_NEXT) viewport
    // keeps the source in vtkImage (stack) mode while the added overlay is a
    // vtkVolumeSlice, producing the broken/unstable fusion. SEG/RT overlays are
    // non-reconstructable, so they are not affected.
    //
    // Scoped to the native (PLANAR_NEXT) path via cs3DViewportType — NOT the flag, and
    // NOT the legacy lane: a legacy stack-shaped reconstructable overlay must keep its
    // existing stack build so the flag-off path stays byte-identical.
    const isReconstructableFusion =
      displaySets.length > 1 && displaySets.every(ds => ds.isReconstructable);
    if (
      isReconstructableFusion &&
      dataShapeType === Enums.ViewportType.STACK &&
      cs3DViewportType === Enums.ViewportType.PLANAR_NEXT
    ) {
      dataShapeType = Enums.ViewportType.ORTHOGRAPHIC;
    }

    if (
      dataShapeType === Enums.ViewportType.ORTHOGRAPHIC ||
      dataShapeType === Enums.ViewportType.VOLUME_3D
    ) {
      try {
        viewportData = await this._getVolumeViewportData(dataSource, displaySets, cs3DViewportType);
      } catch (error) {
        if ((error as Error)?.name !== VOLUME_NOT_FEASIBLE) {
          throw error;
        }

        // GRACEFUL DOWNGRADE.
        //
        // Refusing to build the volume was correct - this GPU genuinely cannot
        // hold it. What was wrong was refusing by throwing and stopping there:
        // nothing caught it, so setViewportData never ran and the pane stayed
        // flagged as a 3D viewport. Cornerstone then asked the browser for a 3D
        // context anyway, got null, and vtk died on it - the black pane and the
        // `setOpenGLRenderWindow` / `get3DContext` TypeErrors. The escaped
        // rejection also surfaced as a crash dialog on top of our own polite
        // message.
        //
        // Rebuilding as a stack is what turns a dead pane into a usable one:
        // every image at full resolution, correct window/level, measurements
        // intact. Nothing is downsampled and nothing is hidden - only the 3D
        // reconstruction is unavailable, and the notification says so and
        // offers the server-built coronal/sagittal series when the study has
        // them.
        console.warn('[shealth] falling back to 2D stack for this viewport');

        dataShapeType = Enums.ViewportType.STACK;
        viewportData = await this._getStackViewportData(
          dataSource,
          displaySets,
          initialImageIndex,
          Enums.ViewportType.STACK
        );
        viewportData.viewportType = Enums.ViewportType.STACK;
        viewportData.dataShapeType = Enums.ViewportType.STACK;

        return viewportData;
      }
    } else if (dataShapeType === Enums.ViewportType.STACK) {
      // Everything else looks like a stack
      viewportData = await this._getStackViewportData(
        dataSource,
        displaySets,
        initialImageIndex,
        cs3DViewportType
      );
    } else {
      viewportData = await this._getOtherViewportData(
        dataSource,
        displaySets,
        initialImageIndex,
        cs3DViewportType
      );
    }

    viewportData.viewportType = cs3DViewportType;
    // Persist the legacy stack/volume shape so consumers can distinguish stack from
    // volume content even when viewportType is a native Generic type (PLANAR_NEXT).
    viewportData.dataShapeType = dataShapeType;

    return viewportData;
  }

  /**
   * Tell the radiologist that 3D is unavailable - once, and with a way out.
   *
   * TWO THINGS THIS FIXES
   *
   * 1. It fired once PER PANE. An MPR layout opens three viewports, so one
   *    refusal produced up to three identical toasts stacked on the images.
   *    A stable `id` makes the toast library replace the existing toast rather
   *    than add another, so the count no longer depends on the layout.
   *
   *    Note the provider's own de-duplication does not help here: it is gated
   *    on `type === 'error'` (NotificationProvider), and this is a warning -
   *    correctly so, since nothing has failed. The id is what does the work.
   *
   * 2. It only described the problem. When the study has the server-built
   *    coronal/sagittal series, the message now carries a button that opens
   *    them in this very viewport. Those series are real lossless DICOM built
   *    once at ingest, so this is not a downgraded picture - it is the same
   *    reformatted view, computed somewhere that has the memory for it.
   */
  private _notifyVolumeUnavailable(displaySet, assessment, available): void {
    const { uiNotificationService, viewportGridService } = this.servicesManager.services;
    if (!uiNotificationService) {
      return;
    }

    // Coronal is offered in preference to sagittal only because it is the more
    // commonly read of the two; either is better than none.
    const targetUID = available?.coronalDisplaySetUID ?? available?.sagittalDisplaySetUID;
    const targetLabel = available?.coronalDisplaySetUID ? 'Open coronal' : 'Open sagittal';

    // Server-built series only.
    //
    // A browser-side CPU reformatter was built and removed: it charged every
    // radiologist ~380 MB and several seconds per study for work the server
    // does once at ingest, and it was being offered on machines that should
    // never have needed it. Reformats belong on the server; when a study has
    // none, the honest answer is 2D at full resolution rather than a slow
    // reconstruction on the reading machine.
    const action =
      targetUID && viewportGridService
        ? {
            label: targetLabel,
            onClick: () => {
              const viewportId = viewportGridService.getActiveViewportId?.();
              if (!viewportId) {
                return;
              }
              viewportGridService.setDisplaySetsForViewport({
                viewportId,
                displaySetInstanceUIDs: [targetUID],
              });
            },
          }
        : undefined;

    uiNotificationService.show({
      // Keyed by study, not by viewport or display set: the constraint is the
      // device against this study, and it is the same fact however many panes
      // discover it.
      id: `mpr-unavailable-${displaySet?.StudyInstanceUID ?? 'unknown'}`,
      title: '3D reconstruction unavailable on this device',
      message: assessment.userMessage,
      type: 'warning',
      duration: 15000,
      action,
    });
  }

  public async invalidateViewportData(
    viewportData: VolumeViewportData | StackViewportData,
    invalidatedDisplaySetInstanceUID: string,
    dataSource,
    displaySetService
  ): Promise<VolumeViewportData | StackViewportData> {
    // Decide stack-vs-volume rebuild from the persisted data shape, NOT viewportType:
    // native viewports collapse both onto PLANAR_NEXT, so a native stack would
    // otherwise fall through to the volume rebuild and re-mount as volume data.
    // Falls back to viewportType for legacy/older viewportData (byte-identical off-path).
    const dataShapeType = viewportData.dataShapeType ?? viewportData.viewportType;

    if (dataShapeType === Enums.ViewportType.STACK) {
      const displaySet = displaySetService.getDisplaySetByUID(invalidatedDisplaySetInstanceUID);
      const imageIds = this._getCornerstoneStackImageIds(displaySet, dataSource);

      // remove images from the cache to be able to re-load them
      imageIds.forEach(imageId => {
        if (cs3DCache.getImageLoadObject(imageId)) {
          cs3DCache.removeImageLoadObject(imageId);
        }
      });

      return {
        // Preserve the original viewportType (legacy STACK or native PLANAR_NEXT);
        // the rebuilt data shape, not this field, drives the native re-mount dispatch.
        viewportType: viewportData.viewportType,
        dataShapeType: Enums.ViewportType.STACK,
        data: {
          StudyInstanceUID: displaySet.StudyInstanceUID,
          displaySetInstanceUID: invalidatedDisplaySetInstanceUID,
          imageIds,
        },
      };
    }

    // Todo: grab the volume and get the id from the viewport itself
    const volumeId = `${VOLUME_LOADER_SCHEME}:${invalidatedDisplaySetInstanceUID}`;

    const volume = cs3DCache.getVolume(volumeId);

    if (volume) {
      if (volume.imageIds) {
        // also for each imageId in the volume, remove the imageId from the cache
        // since that will hold the old metadata as well

        volume.imageIds.forEach(imageId => {
          if (cs3DCache.getImageLoadObject(imageId)) {
            cs3DCache.removeImageLoadObject(imageId, { force: true });
          }
        });
      }

      // this shouldn't be via removeVolumeLoadObject, since that will
      // remove the texture as well, but here we really just need a remove
      // from registry so that we load it again
      cs3DCache._volumeCache.delete(volumeId);
      this.volumeImageIds.delete(volumeId);
    }

    const displaySets = viewportData.data.map(({ displaySetInstanceUID }) =>
      displaySetService.getDisplaySetByUID(displaySetInstanceUID)
    );

    const newViewportData = await this._getVolumeViewportData(
      dataSource,
      displaySets,
      viewportData.viewportType
    );
    newViewportData.dataShapeType = dataShapeType;

    return newViewportData;
  }

  private async _getOtherViewportData(
    dataSource,
    displaySets,
    _initialImageIndex,
    viewportType: Enums.ViewportType
  ): Promise<StackViewportData> {
    // TODO - handle overlays and secondary display sets, but for now assume
    // the 1st display set is the one of interest
    const [displaySet] = displaySets;
    if (!displaySet.imageIds) {
      displaySet.imagesIds = this._getCornerstoneStackImageIds(displaySet, dataSource);
    }
    const { imageIds: data, viewportType: dsViewportType } = displaySet;
    return {
      viewportType: dsViewportType || viewportType,
      data: displaySets,
    };
  }

  private async _getStackViewportData(
    dataSource,
    displaySets,
    initialImageIndex,
    viewportType: Enums.ViewportType
  ): Promise<StackViewportData> {
    const { uiNotificationService } = this.servicesManager.services;
    const overlayDisplaySets = displaySets.filter(ds => ds.isOverlayDisplaySet);
    for (const overlayDisplaySet of overlayDisplaySets) {
      if (overlayDisplaySet.load && overlayDisplaySet.load instanceof Function) {
        const { userAuthenticationService } = this.servicesManager.services;
        const headers = userAuthenticationService.getAuthorizationHeader();
        try {
          await overlayDisplaySet.load({ headers });
        } catch (e) {
          uiNotificationService.show({
            title: 'Error loading displaySet',
            message: e.message,
            type: 'error',
          });
          console.error(e);
        }
      }
    }

    // Ensuring the first non-overlay `displaySet` is always the primary one
    const StackViewportData = [];
    for (const displaySet of displaySets) {
      const { displaySetInstanceUID, StudyInstanceUID, isCompositeStack } = displaySet;

      if (displaySet.load && displaySet.load instanceof Function) {
        const { userAuthenticationService } = this.servicesManager.services;
        const headers = userAuthenticationService.getAuthorizationHeader();
        try {
          await displaySet.load({ headers });
        } catch (e) {
          uiNotificationService.show({
            title: 'Error loading displaySet',
            message: e.message,
            type: 'error',
          });
          console.error(e);
        }
      }

      let stackImageIds = this.stackImageIds.get(displaySet.displaySetInstanceUID);

      if (!stackImageIds) {
        stackImageIds = this._getCornerstoneStackImageIds(displaySet, dataSource);
        // assign imageIds to the displaySet
        displaySet.imageIds = stackImageIds;
        this.stackImageIds.set(displaySet.displaySetInstanceUID, stackImageIds);
      }

      StackViewportData.push({
        StudyInstanceUID,
        displaySetInstanceUID,
        isCompositeStack,
        imageIds: stackImageIds,
        initialImageIndex,
      });
    }

    return {
      viewportType,
      data: StackViewportData,
    };
  }

  private async _getVolumeViewportData(
    dataSource,
    displaySets,
    viewportType: Enums.ViewportType
  ): Promise<VolumeViewportData> {
    // Todo: Check the cache for multiple scenarios to see if we need to
    // decache the volume data from other viewports or not

    const volumeData = [];

    for (const displaySet of displaySets) {
      const { Modality } = displaySet;
      const isParametricMap = Modality === 'PMAP';
      const isSegOrRtstruct = Modality === 'SEG' || Modality === 'RTSTRUCT';

      // Don't create volumes for the displaySets that have custom load
      // function (e.g., SEG, RT, since they rely on the reference volumes
      // and they take care of their own loading after they are created in their
      // getSOPClassHandler method

      if (displaySet.load && displaySet.load instanceof Function) {
        const { userAuthenticationService } = this.servicesManager.services;
        const headers = userAuthenticationService.getAuthorizationHeader();

        try {
          await displaySet.load({ headers });
        } catch (e) {
          const { uiNotificationService } = this.servicesManager.services;
          uiNotificationService.show({
            title: 'Error loading displaySet',
            message: e.message,
            type: 'error',
          });
          console.error(e);
        }

        // Parametric maps have a `load` method but it should not be loaded in the
        // same way as SEG and RTSTRUCT but like a normal volume
        if (!isParametricMap) {
          volumeData.push({
            studyInstanceUID: displaySet.StudyInstanceUID,
            displaySetInstanceUID: displaySet.displaySetInstanceUID,
          });

          // Todo: do some cache check and empty the cache if needed
          continue;
        }
      }

      const volumeLoaderSchema = displaySet.volumeLoaderSchema ?? VOLUME_LOADER_SCHEME;
      const volumeId = `${volumeLoaderSchema}:${displaySet.displaySetInstanceUID}`;
      let volumeImageIds = this.volumeImageIds.get(displaySet.displaySetInstanceUID);
      let volume = cs3DCache.getVolume(volumeId);

      // Parametric maps do not have image ids but they already have volume data
      // therefore a new volume should not be created.
      if (!isParametricMap && !isSegOrRtstruct && (!volumeImageIds || !volume)) {
        volumeImageIds = this._getCornerstoneVolumeImageIds(displaySet, dataSource);

        // Refuse to build a volume this device cannot render — but NEVER by
        // dropping slices.
        //
        // Two ceilings kill MPR on weak hardware: GPU memory, and the hard
        // MAX_3D_TEXTURE_SIZE cap (commonly 2048 per axis), which a 2500-slice
        // series exceeds outright. When either is hit, the old failure mode was
        // a lost WebGL context and a black viewport mid-report.
        //
        // The tempting fix — build from every Nth slice — is not available to
        // us: a finding smaller than the new spacing could fall entirely inside
        // a skipped slice. A reconstruction that quietly contains less than the
        // scanner acquired is a diagnostic hazard, not an optimisation.
        //
        // So we fail loudly and safely instead: no volume, a plain-language
        // explanation, and the study still opens in 2D where every single image
        // is present at full resolution. Nothing is lost, and nothing crashes.
        // Only offer the server-built coronal/sagittal series if this study
        // actually has them — the reformat job is optional and may be off, and
        // pointing a radiologist at a series that is not there sends them
        // hunting through an empty study list.
        const { displaySetService } = this.servicesManager.services;
        const available = findAvailableReformats(
          (displaySetService?.activeDisplaySets ?? []).filter(
            (ds: { StudyInstanceUID?: string }) =>
              ds?.StudyInstanceUID === displaySet.StudyInstanceUID
          )
        );

        const assessment = assessVolumeFeasibility(displaySet, volumeImageIds, available);
        if (!assessment.feasible) {
          console.warn(`[shealth] MPR unavailable: ${assessment.reason}`);

          this._notifyVolumeUnavailable(displaySet, assessment, available);

          // Sentinel, not a crash. createViewportData catches this and rebuilds
          // the viewport as a 2D stack, so the radiologist gets the images
          // instead of a dead pane. It stays an exception because we are deep
          // inside a loop building per-display-set volume data and there is no
          // meaningful volume to return from here.
          const err = new Error(assessment.userMessage ?? assessment.reason);
          err.name = VOLUME_NOT_FEASIBLE;
          throw err;
        }

        console.info(`[shealth] MPR volume check: ${assessment.reason}`);

        volume = await volumeLoader.createAndCacheVolume(volumeId, {
          imageIds: volumeImageIds,
        });

        this.volumeImageIds.set(displaySet.displaySetInstanceUID, volumeImageIds);

        // Add imageIds to the displaySet for volumes
        displaySet.imageIds = volumeImageIds;
      }

      volumeData.push({
        StudyInstanceUID: displaySet.StudyInstanceUID,
        displaySetInstanceUID: displaySet.displaySetInstanceUID,
        volume,
        volumeId,
        imageIds: volumeImageIds,
        isDynamicVolume: displaySet.isDynamicVolume,
      });
    }

    return {
      viewportType,
      data: volumeData,
    };
  }

  private _getCornerstoneStackImageIds(displaySet, dataSource): string[] {
    return dataSource.getImageIdsForDisplaySet(displaySet);
  }

  private _getCornerstoneVolumeImageIds(displaySet, dataSource): string[] {
    if (displaySet.imageIds) {
      return displaySet.imageIds;
    }

    const stackImageIds = this._getCornerstoneStackImageIds(displaySet, dataSource);

    return stackImageIds;
  }
}

export default CornerstoneCacheService;
