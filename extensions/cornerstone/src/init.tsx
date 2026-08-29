import OHIF, { errorHandler } from '@ohif/core';
import React from 'react';

import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  init as cs3DInit,
  eventTarget,
  EVENTS,
  metaData,
  volumeLoader,
  imageLoadPoolManager,
  imageRetrievalPoolManager,
  getEnabledElement,
  Settings,
  utilities as csUtilities,
} from '@cornerstonejs/core';
import {
  cornerstoneStreamingImageVolumeLoader,
  cornerstoneStreamingDynamicImageVolumeLoader,
} from '@cornerstonejs/core/loaders';

import RequestTypes from '@cornerstonejs/core/enums/RequestType';

import initWADOImageLoader from './initWADOImageLoader';
import initCornerstoneTools from './initCornerstoneTools';

import { connectToolsToMeasurementService } from './initMeasurementService';
import initCineService from './initCineService';
import initStudyPrefetcherService from './initStudyPrefetcherService';
import {
  setNextViewportsEnabled,
  resolveNextViewportsEnabled,
  resolveViewportRendering,
  setViewportRenderingOverrides,
} from './utils/nextViewports';
import interleaveCenterLoader from './utils/interleaveCenterLoader';
import nthLoader from './utils/nthLoader';
import interleaveTopToBottom from './utils/interleaveTopToBottom';
import { getGpuInfo } from './utils/getGpuTier';
import {
  getRenderingProfile,
  resolveRetrievalConcurrency,
  resolveWebWorkerCount,
} from './utils/renderingProfile';
import initWebGLContextLossRecovery from './utils/initWebGLContextLossRecovery';
import initContextMenu from './initContextMenu';
import initDoubleClick from './initDoubleClick';
import initViewTiming from './utils/initViewTiming';
import { colormaps } from './utils/colormaps';
import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';
import { useLutPresentationStore } from './stores/useLutPresentationStore';
import { usePositionPresentationStore } from './stores/usePositionPresentationStore';
import { useSegmentationPresentationStore } from './stores/useSegmentationPresentationStore';
import { imageRetrieveMetadataProvider } from '@cornerstonejs/core/utilities';
import { initializeWebWorkerProgressHandler } from './utils/initWebWorkerProgressHandler';
import { installLoadTelemetry } from './utils/loadTelemetry';
import { installShealthBridge } from './utils/shealthBridge';

const { registerColormap } = csUtilities.colormap;

// TODO: Cypress tests are currently grabbing this from the window?
(window as any).cornerstone = cornerstone;
(window as any).cornerstoneTools = cornerstoneTools;
/**
 *
 */
export default async function init({
  servicesManager,
  commandsManager,
  extensionManager,
  appConfig,
}: withAppTypes): Promise<void> {
  // Use a public library path of PUBLIC_URL plus the component name
  // This safely separates components that are loaded as-is.
  window.PUBLIC_LIB_URL ||= './${component}/';

  // Note: this should run first before initializing the cornerstone
  // DO NOT CHANGE THE ORDER

  // Enable cornerstone's stats/debug overlay when `?debug=true` is in the URL.
  // Mirrors the cornerstone demo trigger so the same overlay is available inside
  // OHIF: FPS / MS / MB panels plus the per-viewport actor & mapper bindings.
  const statsOverlay =
    new URLSearchParams(window.location.search).get('debug') === 'true';

  // ── Device-aware rendering profile ──────────────────────────────────────────
  //
  // Cornerstone reserves GPU memory per WebGL context (default: 7) BEFORE any
  // voxel is uploaded. On the integrated Intel GPUs several of our radiologists
  // read on, that pool plus a CT volume texture exceeds the GPU's budget, the
  // browser takes the context away, and vtk.js then draws on a dead context —
  // the black-screen MPR crash. Fewer contexts and half-precision textures are
  // what make the same study fit on the same laptop.
  //
  // A machine with a real GPU keeps stock behaviour: this only spends less where
  // there is less to spend. `?gpuTier=` overrides detection for support.
  const gpuInfo = getGpuInfo();
  const renderingProfile = getRenderingProfile(gpuInfo.tier);

  console.info(
    `[shealth] GPU tier: ${gpuInfo.tier} (${gpuInfo.reason}) | ` +
      `contexts=${renderingProfile.webGLContextCount} ` +
      `halfFloat=${renderingProfile.preferSizeOverAccuracy} ` +
      `workers<=${renderingProfile.maxWebWorkers} cores=${gpuInfo.logicalCores}`
  );

  await cs3DInit({
    peerImport: appConfig.peerImport,
    debug: { statsOverlay },
    rendering: {
      // NOTE the casing: cornerstone's key is `webGlContextCount`, not
      // `webGLContextCount`. An unknown key here is silently ignored, so a typo
      // looks exactly like "the setting does nothing" — which is how this lever
      // was missed until now.
      webGlContextCount:
        appConfig.webGlContextCount ?? renderingProfile.webGLContextCount,
      // Half-float volume textures: ~half the GPU memory, and safe on Intel
      // integrated parts. (norm16 would save the same again but is the exact
      // configuration known to hard-crash those drivers; cornerstone 5.x no
      // longer exposes it at all.)
      preferSizeOverAccuracy:
        appConfig.preferSizeOverAccuracy ?? renderingProfile.preferSizeOverAccuracy,
      strictZSpacingForVolumeViewport: appConfig.strictZSpacingForVolumeViewport,
      useGenericViewport: Boolean(appConfig.useGenericViewport),
    },
  });

  // Capture the load timings OHIF already computes but only prints. Installed
  // early so nothing that happens during startup is missed - scriptToView in
  // particular ends shortly after this point.
  installLoadTelemetry();

  // Answer the SHealth workspace's capture / render-check requests.
  //
  // The host has always sent these; nothing here listened, so Capture timed out
  // after 8s ("The viewer didn't respond") and the render watchdog eventually
  // claimed a fully-painted study was still rendering. Installed here, beside
  // the telemetry hook, because both halves of that protocol belong together and
  // this runs once per viewer boot with `servicesManager` already in hand.
  //
  // The bridge resolves the viewport lazily on each request, so installing
  // before any viewport exists is correct: early requests are answered
  // "not rendered" rather than dropped.
  installShealthBridge({
    servicesManager,
    // Optional allowlist. Unset by default: the viewer serves several SHealth
    // hosts (prod, test, local) and the bridge then requires messages to come
    // from its actual embedder instead.
    allowedOrigins: appConfig?.shealthHostOrigins,
  });

  // Turn a permanent black viewport into a self-heal. Must be attached before
  // viewports render: `webglcontextlost` has to be preventDefault()-ed or the
  // browser never fires `webglcontextrestored` and recovery is impossible.
  initWebGLContextLossRecovery({
    uiNotificationService: servicesManager.services.uiNotificationService,
  });

  cornerstone.setUseCPURendering(Boolean(appConfig.useCPURendering));

  // All native ("next") Generic Viewport settings live under one config object:
  // appConfig.genericViewports = { enabled, viewportRendering }.
  const genericViewportsConfig = appConfig.genericViewports ?? {};

  // viewportRendering selects the render backend per-session:
  // `?viewportRendering=cpu|webgl|webgpu|auto` for all viewports, plus
  // `?<viewportType>.viewportRendering=<backend>` (e.g.
  // `?orthographic.viewportRendering=cpu`) to override a single viewport type
  // via the per-mount renderBackend option. The global value maps to
  // cornerstone's setRenderBackend; 'cpu'/'gpu' additionally drive the legacy
  // useCPURendering flag so pre-generic viewports follow the same selection
  // (letting a session force GPU when the deployed config defaults to CPU).
  const { renderBackend, renderBackendByViewportType } = resolveViewportRendering(
    genericViewportsConfig.viewportRendering
  );
  if (renderBackend) {
    if (renderBackend === 'cpu') {
      cornerstone.setUseCPURendering(true);
    } else if (renderBackend === 'gpu') {
      cornerstone.setUseCPURendering(false);
    }
    try {
      cornerstone.setRenderBackend(renderBackend as cornerstone.RenderBackendValue);
    } catch (error) {
      console.warn(
        `viewportRendering: "${renderBackend}" is not a registered render backend; ` +
          `keeping "${cornerstone.getRenderBackend()}".`,
        error
      );
    }
  }
  setViewportRenderingOverrides(renderBackendByViewportType);

  cornerstone.setConfiguration({
    ...cornerstone.getConfiguration(),
    rendering: {
      ...cornerstone.getConfiguration().rendering,
      strictZSpacingForVolumeViewport: appConfig.strictZSpacingForVolumeViewport,
      // Opt-in: route legacy viewport types through the new GenericViewport render
      // paths while keeping the legacy public API via compatibility adapters.
      // No-op on cornerstone builds that predate the GenericViewport architecture.
      useGenericViewport: Boolean(appConfig.useGenericViewport),
    },
  });

  // Opt-in: drive viewports through the DIRECT native GenericViewport ("next")
  // API (PLANAR_NEXT, setDisplaySets, ...). Read by getCornerstoneViewportType
  // and the CornerstoneViewportService backend split. Distinct from
  // useGenericViewport above (which only enables cornerstone's compat remap).
  // resolveNextViewportsEnabled lets a `?useNextViewports=true` URL param opt in
  // per-session; when the param is absent, appConfig.genericViewports.enabled wins.
  setNextViewportsEnabled(resolveNextViewportsEnabled(genericViewportsConfig.enabled));

  // For debugging large datasets, otherwise prefer the defaults
  const { maxCacheSize } = appConfig;
  if (maxCacheSize) {
    cornerstone.cache.setMaxCacheSize(maxCacheSize);
  }

  initCornerstoneTools();

  Settings.getRuntimeSettings().set('useCursors', Boolean(appConfig.useCursors));

  const {
    userAuthenticationService,
    customizationService,
    uiModalService,
    uiNotificationService,
    cornerstoneViewportService,
    hangingProtocolService,
    viewportGridService,
    segmentationService,
    measurementService,
    colorbarService,
    displaySetService,
    toolbarService,
  } = servicesManager.services;

  toolbarService.registerEventForToolbarUpdate(colorbarService, [
    colorbarService.EVENTS.STATE_CHANGED,
  ]);

  toolbarService.registerEventForToolbarUpdate(segmentationService, [
    segmentationService.EVENTS.SEGMENTATION_MODIFIED,
    segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
    segmentationService.EVENTS.SEGMENTATION_ANNOTATION_CUT_MERGE_PROCESS_COMPLETED,
  ]);

  window.services = servicesManager.services;
  window.extensionManager = extensionManager;
  window.commandsManager = commandsManager;

  if (appConfig.showCPUFallbackMessage && cornerstone.getShouldUseCPURendering()) {
    _showCPURenderingModal(uiModalService, hangingProtocolService);
  }
  const { getPresentationId: getLutPresentationId } = useLutPresentationStore.getState();

  const { getPresentationId: getSegmentationPresentationId } =
    useSegmentationPresentationStore.getState();

  const { getPresentationId: getPositionPresentationId } = usePositionPresentationStore.getState();

  // register presentation id providers
  viewportGridService.addPresentationIdProvider(
    'positionPresentationId',
    getPositionPresentationId
  );
  viewportGridService.addPresentationIdProvider('lutPresentationId', getLutPresentationId);
  viewportGridService.addPresentationIdProvider(
    'segmentationPresentationId',
    getSegmentationPresentationId
  );

  segmentationService.setStyle(
    { type: SegmentationRepresentations.Contour },
    {
      // Declare these alpha values at the Contour type level so that they can be set/changed/inherited for all contour segmentations.
      fillAlpha: 0.5,
      fillAlphaInactive: 0.4,

      // In general do not fill contours so that hydrated RTSTRUCTs are not filled in when active or inactive by default.
      // However, hydrated RTSTRUCTs are filled in when active or inactive if the user chooses to fill ALL contours.
      // Those Contours created in OHIF (i.e. using the Segmentation Panel) will override both fill properties upon creation.
      renderFill: false,
      renderFillInactive: false,
    }
  );

  const metadataProvider = OHIF.classes.MetadataProvider;

  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstoneStreamingImageVolumeLoader
  );

  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingDynamicImageVolume',
    cornerstoneStreamingDynamicImageVolumeLoader
  );

  // Register strategies using the wrapper
  const imageLoadStrategies = {
    interleaveCenter: interleaveCenterLoader,
    interleaveTopToBottom: interleaveTopToBottom,
    nth: nthLoader,
  };

  Object.entries(imageLoadStrategies).forEach(([name, strategyFn]) => {
    hangingProtocolService.registerImageLoadStrategy(
      name,
      createMetadataWrappedStrategy(strategyFn)
    );
  });

  // ── Fetch concurrency ───────────────────────────────────────────────────────
  //
  // Frame loading here has always been ASYNCHRONOUS — this pool runs many
  // requests at once, and MPR already loads in an interleaved order (see the
  // `nth` strategy registered above), which is why a volume fills coarse-to-fine
  // rather than top-to-bottom. What made loading *look* serial was that the
  // concurrency was one fixed number tuned for the slowest clinic link, which
  // then starves a radiologist sitting on a hospital LAN.
  //
  // Now it scales with the device class (a 2-core laptop cannot decode 25
  // parallel frames anyway — it just queues them and stutters the UI), and an
  // explicit app-config value still wins so ops can pin it per site.
  // One typed read of the app-config overrides, shared by both pools.
  //
  // `appConfig` is untyped here, so reaching into it inline meant repeating an
  // unchecked property access eight times. Narrowing once keeps the override
  // behaviour identical and stops the pattern spreading further.
  const configuredRequests = (appConfig as {
    maxNumRequests?: Partial<Record<'interaction' | 'thumbnail' | 'prefetch' | 'compute', number>>;
  } | undefined)?.maxNumRequests;

  // DECODE pool — bounded by CPU. A 2-core laptop cannot decode 25 frames in
  // parallel; it queues them and stutters the UI. Device class is the right axis
  // for this one.
  imageLoadPoolManager.maxNumRequests = {
    [RequestTypes.Interaction]:
      configuredRequests?.interaction || renderingProfile.maxNumRequests.interaction,
    [RequestTypes.Thumbnail]:
      configuredRequests?.thumbnail || renderingProfile.maxNumRequests.thumbnail,
    [RequestTypes.Prefetch]:
      configuredRequests?.prefetch || renderingProfile.maxNumRequests.prefetch,
    [RequestTypes.Compute]:
      configuredRequests?.compute || renderingProfile.maxNumRequests.compute,
  };

  // NETWORK pool — bounded by the link, and until now never configured at all.
  //
  // These are two different pools with two different limits, and only this one
  // governs how much of the connection is in use. It was left at Cornerstone's
  // default of 5 prefetch requests on every machine, while the decode pool above
  // was carefully tuned per GPU tier - so the tuning that existed could not
  // affect link saturation even in principle.
  //
  // A retrieval slot frees the moment bytes arrive, independent of the decode
  // backlog, which is exactly why this can be set well above the decode limit
  // without starving a weak CPU.
  const retrievalConcurrency = resolveRetrievalConcurrency();
  imageRetrievalPoolManager.maxNumRequests = {
    [RequestTypes.Interaction]:
      configuredRequests?.interaction || retrievalConcurrency.interaction,
    [RequestTypes.Thumbnail]:
      configuredRequests?.thumbnail || retrievalConcurrency.thumbnail,
    [RequestTypes.Prefetch]:
      configuredRequests?.prefetch || retrievalConcurrency.prefetch,
    [RequestTypes.Compute]:
      configuredRequests?.compute || retrievalConcurrency.compute,
  };

  // Decode workers. `initWADOImageLoader` clamps to cores-1 already; this makes
  // the ceiling device-aware instead of a single global constant, while leaving
  // one core for the UI thread so a volume build cannot freeze the tab (which,
  // being an iframe inside the reporting workspace, would freeze the report too).
  if (!appConfig.maxNumberOfWebWorkers) {
    appConfig.maxNumberOfWebWorkers = resolveWebWorkerCount(
      renderingProfile.maxWebWorkers,
      gpuInfo.logicalCores
    );
  }

  initWADOImageLoader(userAuthenticationService, appConfig, extensionManager);

  // Add OHIF metadata providers after dicomImageLoader.init().
  // The linked metadata branch clears providers during loader init.
  metaData.addProvider(csUtilities.genericMetadataProvider.get, 9998);
  metaData.addProvider(
    csUtilities.calibratedPixelSpacingMetadataProvider.get.bind(
      csUtilities.calibratedPixelSpacingMetadataProvider
    )
  ); // this provider is required for Calibration tool
  metaData.addProvider(metadataProvider.get.bind(metadataProvider), 9999);

  /* Measurement Service */
  this.measurementServiceSource = connectToolsToMeasurementService({
    servicesManager,
    commandsManager,
    extensionManager,
  });

  initCineService(servicesManager);
  initStudyPrefetcherService(servicesManager);

  measurementService.subscribe(measurementService.EVENTS.JUMP_TO_MEASUREMENT, evt => {
    const { measurement } = evt;
    const { uid: annotationUID } = measurement;
    commandsManager.runCommand('jumpToMeasurementViewport', { measurement, annotationUID, evt });
  });

  // When a custom image load is performed, update the relevant viewports
  hangingProtocolService.subscribe(
    hangingProtocolService.EVENTS.CUSTOM_IMAGE_LOAD_PERFORMED,
    volumeInputArrayMap => {
      const { lutPresentationStore } = useLutPresentationStore.getState();
      const { segmentationPresentationStore } = useSegmentationPresentationStore.getState();
      const { positionPresentationStore } = usePositionPresentationStore.getState();

      for (const entry of volumeInputArrayMap.entries()) {
        const [viewportId, volumeInputArray] = entry;
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

        const ohifViewport = cornerstoneViewportService.getViewportInfo(viewportId);

        const { presentationIds } = ohifViewport.getViewportOptions();

        const presentations = {
          positionPresentation: positionPresentationStore[presentationIds?.positionPresentationId],
          lutPresentation: lutPresentationStore[presentationIds?.lutPresentationId],
          segmentationPresentation:
            segmentationPresentationStore[presentationIds?.segmentationPresentationId],
        };

        cornerstoneViewportService.setVolumesForViewport(viewport, volumeInputArray, presentations);
      }
    }
  );

  initContextMenu({
    cornerstoneViewportService,
    customizationService,
    commandsManager,
  });

  initDoubleClick({
    customizationService,
    commandsManager,
  });

  /**
   * Runs error handler for failed requests.
   *
   * `getHTTPErrorHandler()` returns undefined unless the app registered one,
   * and nothing in this build does. Calling it unguarded threw
   *
   *   TypeError: handler is not a function
   *
   * from inside a cornerstone event listener EVERY time a frame failed to
   * load. That aborts the listener chain, so the retry/report path that should
   * have run for the failed image never did — a single transient 502 on one
   * frame of a 400-slice series was enough to leave the viewport empty.
   *
   * The failure must be visible either way: with no handler registered the
   * error was previously swallowed by the TypeError it caused, so log it.
   */
  const imageLoadFailedHandler = ({ detail }) => {
    const handler = errorHandler.getHTTPErrorHandler();
    if (typeof handler === 'function') {
      try {
        handler(detail?.error);
      } catch (e) {
        // A throwing app-supplied handler must not take out the listener chain
        // either — same failure mode, different origin.
        console.error('[shealth] HTTP error handler threw', e);
      }
      return;
    }
    console.error('[shealth] image load failed', detail?.error ?? detail);
  };

  eventTarget.addEventListener(EVENTS.IMAGE_LOAD_FAILED, imageLoadFailedHandler);
  eventTarget.addEventListener(EVENTS.IMAGE_LOAD_ERROR, imageLoadFailedHandler);

  const getDisplaySetFromVolumeId = (volumeId: string) => {
    const allDisplaySets = displaySetService.getActiveDisplaySets();
    const volume = cornerstone.cache.getVolume(volumeId);
    const imageIds = volume.imageIds;
    return allDisplaySets.find(ds => ds.imageIds?.some(id => imageIds.includes(id)));
  };

  function elementEnabledHandler(evt) {
    const { element } = evt.detail;
    const { viewport } = getEnabledElement(element);
    initViewTiming({ element });

    element.addEventListener(EVENTS.CAMERA_RESET, evt => {
      const { element } = evt.detail;
      const enabledElement = getEnabledElement(element);
      if (!enabledElement) {
        return;
      }
      const { viewportId } = enabledElement;
      commandsManager.runCommand('resetCrosshairs', { viewportId });
    });

    // limitation: currently supporting only volume viewports with fusion
    if (viewport.type !== cornerstone.Enums.ViewportType.ORTHOGRAPHIC) {
      return;
    }
  }

  eventTarget.addEventListener(EVENTS.ELEMENT_ENABLED, elementEnabledHandler.bind(null));

  colormaps.forEach(registerColormap);

  // Event listener
  eventTarget.addEventListenerDebounced(
    EVENTS.ERROR_EVENT,
    ({ detail }) => {
      // Create a stable ID for deduplication based on error type and message
      const errorId = `cornerstone-error-${detail.type}-${detail.message.substring(0, 50)}`;

      uiNotificationService.show({
        title: detail.type,
        message: detail.message,
        type: 'error',
        id: errorId,
        allowDuplicates: false, // Prevent duplicate error notifications
        deduplicationInterval: 30000, // 30 seconds deduplication window
      });
    },
    100
  );

  // Subscribe to actor events to dynamically update colorbars

  // Call this function when initializing
  initializeWebWorkerProgressHandler(servicesManager.services.uiNotificationService);
}

/**
 * Creates a wrapped image load strategy with metadata handling
 * @param strategyFn - The image loading strategy function to wrap
 * @returns A wrapped strategy function that handles metadata configuration
 */
const createMetadataWrappedStrategy = (strategyFn: (args: any) => any) => {
  return (args: any) => {
    const clonedConfig = imageRetrieveMetadataProvider.clone();
    imageRetrieveMetadataProvider.clear();

    try {
      const result = strategyFn(args);
      return result;
    } finally {
      // Ensure metadata is always restored, even if there's an error
      setTimeout(() => {
        imageRetrieveMetadataProvider.restore(clonedConfig);
      }, 10);
    }
  };
};

function CPUModal() {
  return (
    <div>
      <p>
        Your computer does not have enough GPU power to support the default GPU rendering mode. OHIF
        has switched to CPU rendering mode. Please note that CPU rendering does not support all
        features such as Volume Rendering, Multiplanar Reconstruction, and Segmentation Overlays.
      </p>
    </div>
  );
}

function _showCPURenderingModal(uiModalService, hangingProtocolService) {
  const callback = progress => {
    if (progress === 100) {
      uiModalService.show({
        content: CPUModal,
        title: 'OHIF Fell Back to CPU Rendering',
      });

      return true;
    }
  };

  const { unsubscribe } = hangingProtocolService.subscribe(
    hangingProtocolService.EVENTS.PROTOCOL_CHANGED,
    () => {
      const done = callback(100);

      if (done) {
        unsubscribe();
      }
    }
  );
}
