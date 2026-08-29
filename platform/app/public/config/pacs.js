/**
 * Shealth PACS OHIF configuration.
 *
 * Sibling of `config/shealth.js`: same viewer, different product. Shealth PACS
 * is DICOM-storage-as-a-service sold to hospitals, so the viewer carries the
 * PACS product name rather than the telerad one, and falls back to the PACS
 * backend port rather than telerad's.
 *
 * Replaces the hand-mounted `Shealth-PACS/docker/ohif/app-config.js`. That file
 * was bind-mounted over the container's app-config.js, which CANNOT work with
 * this image: entrypoint.sh runs `gzip app-config.js`, and gzip must unlink its
 * source — impossible for a bind-mounted file (EBUSY), read-only or not. With
 * `gzip_static always` nginx then serves a stale or 0-byte .gz as the config,
 * i.e. a blank viewer. Baking it in is the fix, and it version-controls the
 * config alongside the code that reads it.
 *
 * Build/run with:
 *   docker build -f Dockerfile.shealth --build-arg APP_CONFIG=config/pacs.js \
 *     -t shealth-pacs-ohif:<n> .
 *
 * IMPORTANT — what is deliberately NOT set here:
 *
 *   webGlContextCount / preferSizeOverAccuracy / maxNumberOfWebWorkers /
 *   maxNumRequests
 *
 * The hand-mounted config pinned maxNumberOfWebWorkers and maxNumRequests to
 * fixed numbers. Those are now decided per-device at runtime by the GPU-tier
 * profile (extensions/cornerstone/src/utils/renderingProfile.ts). Setting any of
 * them here PINS it for every device and disables that adaptation — only do so
 * to work around a specific site issue.
 */

// ─── Resolve the DICOMweb backend at runtime ──────────────────────────────────
//
// The Next.js app embeds this viewer in an iframe and passes the EXACT backend
// it is itself using as `_backend` (see Shealth-PACS/lib/ohif.ts). The viewer
// must query the SAME backend, or the app's pre-flight "is this study in PACS?"
// check passes while the viewer looks somewhere else and renders nothing.
var __PACS_BACKEND__ = (function () {
  // 1. Explicit wins. lib/ohif.ts ALWAYS sends this, so it is the normal path
  //    and the fallbacks below are for a bookmarked or hand-typed URL.
  try {
    var b = new URLSearchParams(window.location.search).get('_backend');
    if (b) {
      return b.replace(/\/+$/, '');
    }
  } catch (_) {}

  // 2. Local development: the PACS API is served by the Next.js app on
  //    :3010 under /api. It was :8010 (a separate FastAPI service) until the
  //    backend migration on 2026-08-27; that service no longer owns these
  //    routes, so a viewer falling back to it would query a backend that is
  //    being decommissioned.
  //
  //    Scoped to loopback ONLY. `config/shealth.js` documents two incidents
  //    caused by an unconditional hardcoded backend — a viewer opened without
  //    the parameter silently queried production from whichever environment it
  //    was running in. Gating on hostname keeps dev convenient without
  //    reintroducing that.
  //
  //    Note this is only ever reached by a bookmarked or hand-typed viewer
  //    URL: Shealth-PACS/lib/ohif.ts sets `_backend` on every study link it
  //    builds, so the normal path never gets here.
  try {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return 'http://localhost:3010/api';
    }
  } catch (_) {}

  // 3. Nothing usable. Returning empty makes the failure obvious in the network
  //    tab as a relative request, rather than quietly succeeding against the
  //    wrong environment. Deployed PACS environments must pass `_backend`.
  return '';
})();

window.config = {
  routerBasename: '/',

  // Embedded per-study from the PACS workspace — the built-in study list would
  // just be a second, conflicting worklist.
  showStudyList: false,

  // The stock "investigational use only" banner just eats viewport height in a
  // clinical workspace that already carries its own compliance chrome.
  investigationalUseDialog: { option: 'never' },

  extensions: [],
  modes: [],
  defaultDataSourceName: 'dicomweb',

  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: false,

  // Leave false: CPU rendering is the last-resort fallback, reached
  // automatically when no WebGL is available, or per session with
  // `?viewportRendering=cpu`. Forcing it globally would make every study slow to
  // protect the few machines the GPU-tier profile already handles.
  useCPURendering: false,

  // Progressive volume streaming when the page is cross-origin isolated
  // (COOP/COEP). 'AUTO' falls back safely when the headers are absent — which
  // they currently are on the PACS deployment — so this is harmless to leave on
  // and starts working the day the headers land.
  useSharedArrayBuffer: 'AUTO',

  // Prefetch a few neighbours of the current frame, not the whole study. NOT
  // part of the GPU-tier profile (that governs decode workers and GPU memory,
  // not look-ahead depth), so it stays configured here.
  imagePrefetcher: {
    enabled: true,
    maxImagesToPrefetch: 5,
    preserveExistingPool: false,
  },

  // ── Data source: FastAPI DICOMweb proxy → Orthanc ───────────────────────────
  // Flow: OHIF → FastAPI /dicomweb/* → Orthanc /dicom-web/*
  // FastAPI injects Orthanc's Basic-Auth server-side, so no credentials are
  // needed (or exposed) in the browser.
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'Hospital PACS',
        name: 'hospital',

        // Evaluated in the BROWSER, so these must be reachable from the
        // radiologist's machine — hence deriving them from `_backend` rather
        // than hardcoding a host that drifts between environments.
        qidoRoot: __PACS_BACKEND__ + '/dicomweb',
        wadoRoot: __PACS_BACKEND__ + '/dicomweb',
        wadoUriRoot: __PACS_BACKEND__ + '/wado',

        qidoSupportsIncludeField: false,
        supportsReject: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        omitQuotationForMultipartRequest: true,

        // Transfer syntax is deliberately NOT forced. Orthanc runs with
        // HasWadoRsUniversalTransferSyntax, so omitting this returns each frame
        // in its ORIGINAL stored syntax — no server-side transcoding, no
        // "Unable to get transcoded file" 500s, and cornerstone decodes the
        // source syntax client-side. Forcing '1.2.840.10008.1.2.4.50' made
        // Orthanc fail to transcode and 500 on EVERY frame.
        // requestTransferSyntaxUID: '1.2.840.10008.1.2.4.50',

        bulkDataURI: { enabled: true, relativeResolution: 'series' },
      },
    },
  ],

  // ── Viewport overlays ───────────────────────────────────────────────────────
  //
  // What a radiologist needs visible on the image without clicking anything:
  // who the patient is, which slice this is, and the geometry they are about to
  // measure against. Stock OHIF shows only study date + series description.
  //
  // Slice thickness and slice location matter clinically — a measurement read
  // off the wrong slice thickness is a wrong measurement — so they are on the
  // image, not buried in a panel.
  //
  // Secondary fields hide below 768 px so the overlay never covers the anatomy
  // on a laptop or tablet.
  customizationService: {
    'viewportOverlay.topLeft': [
      {
        id: 'PatientName',
        inheritsFrom: 'ohif.overlayItem',
        label: '',
        title: 'Patient name',
        condition: ({ instance }) => instance?.PatientName,
        contentF: ({ instance }) =>
          (instance.PatientName?.Alphabetic ?? String(instance.PatientName ?? ''))
            .replace(/\^/g, ' ')
            .trim() + (instance.PatientSex ? ` (${instance.PatientSex})` : ''),
      },
      {
        id: 'PatientID',
        inheritsFrom: 'ohif.overlayItem',
        label: 'PID:',
        title: 'Patient ID',
        condition: ({ instance }) => instance?.PatientID,
        contentF: ({ instance }) => instance.PatientID,
      },
      {
        id: 'PatientDOB',
        inheritsFrom: 'ohif.overlayItem',
        label: 'DOB:',
        title: 'Date of birth',
        // Hidden on narrow screens — identity is already established by name+PID.
        condition: ({ instance }) => instance?.PatientBirthDate && window.innerWidth > 768,
        contentF: ({ instance, formatters: { formatDate } }) =>
          formatDate(instance.PatientBirthDate),
      },
    ],

    'viewportOverlay.topRight': [
      {
        id: 'StudyDescription',
        inheritsFrom: 'ohif.overlayItem',
        label: '',
        title: 'Study description',
        condition: ({ referenceInstance }) => referenceInstance?.StudyDescription,
        contentF: ({ referenceInstance }) => referenceInstance.StudyDescription,
      },
      {
        id: 'StudyDate',
        inheritsFrom: 'ohif.overlayItem',
        label: '',
        title: 'Study date',
        condition: ({ referenceInstance }) => referenceInstance?.StudyDate,
        contentF: ({ referenceInstance, formatters: { formatDate } }) =>
          formatDate(referenceInstance.StudyDate),
      },
      {
        id: 'StudyTime',
        inheritsFrom: 'ohif.overlayItem',
        label: '',
        title: 'Study time',
        condition: ({ referenceInstance }) =>
          referenceInstance?.StudyTime && window.innerWidth > 768,
        contentF: ({ referenceInstance, formatters: { formatTime } }) =>
          formatTime(referenceInstance.StudyTime),
      },
    ],

    'viewportOverlay.bottomLeft': [
      {
        id: 'WindowLevel',
        inheritsFrom: 'ohif.overlayItem.windowLevel',
        title: 'Window level',
      },
      {
        id: 'SeriesNumber',
        inheritsFrom: 'ohif.overlayItem',
        label: 'Ser:',
        title: 'Series number',
        condition: ({ referenceInstance }) => referenceInstance?.SeriesNumber != null,
        contentF: ({ referenceInstance }) => referenceInstance.SeriesNumber,
      },
      {
        id: 'SliceThickness',
        inheritsFrom: 'ohif.overlayItem',
        label: 'Thk:',
        title: 'Slice thickness (mm)',
        // Clinically load-bearing: measurements are only valid against the
        // geometry they were made on.
        condition: ({ instance }) => instance?.SliceThickness != null,
        contentF: ({ instance }) => `${Number(instance.SliceThickness).toFixed(1)} mm`,
      },
      {
        id: 'SliceLocation',
        inheritsFrom: 'ohif.overlayItem',
        label: 'Loc:',
        title: 'Slice location (mm)',
        condition: ({ instance }) => instance?.SliceLocation != null && window.innerWidth > 768,
        contentF: ({ instance }) => `${Number(instance.SliceLocation).toFixed(1)} mm`,
      },
    ],
  },

  // ── White-label ─────────────────────────────────────────────────────────────
  //
  // Deliberately TEXT ONLY, and deliberately not the Shealth mark that
  // `config/shealth.js` renders. PACS is sold to hospitals as their storage
  // service; the viewer inside it names that product, not the telerad company.
  //
  // Rendered as text rather than an image so it stays sharp at every zoom and
  // pixel density, needs no asset shipped with the build, and takes its colour
  // from the palette instead of having it baked into a PNG.
  //
  // RESPONSIVE, because the header is a fixed-height strip shared with the
  // toolbar: every pixel this takes is a pixel the toolbar loses, which on a
  // narrow window is the difference between a tool being on the toolbar and
  // being buried in the overflow menu. Below 1100px "PACS" alone is still
  // unambiguous inside the product.
  //
  // Done with a media query rather than a resize listener: the browser already
  // tracks viewport width, and no React state means no re-render of the header
  // while the radiologist drags a panel divider.
  whiteLabeling: {
    createLogoComponentFn: function (React) {
      var css = [
        '@media (max-width: 1100px) {',
        '  .pacs-wordmark__qualifier { display: none; }',
        '}',
      ].join(' ');

      return React.createElement(
        'a',
        {
          href: '/',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            textDecoration: 'none',
            padding: '0 14px 0 12px',
            height: '100%',
            alignSelf: 'center',
            // A wrapped product name would push the fixed-height header strip
            // out of alignment on a narrow window.
            whiteSpace: 'nowrap',
          },
          'aria-label': 'Hospital PACS Viewer',
        },
        React.createElement('style', { key: 'pacs-wordmark-style' }, css),
        React.createElement(
          'span',
          {
            className: 'pacs-wordmark__qualifier',
            style: {
              color: '#0f9d76',
              fontSize: '16px',
              fontWeight: 700,
              letterSpacing: '0.2px',
              lineHeight: 1,
            },
          },
          'Hospital'
        ),
        React.createElement(
          'span',
          {
            style: {
              color: '#0f9d76',
              fontSize: '16px',
              fontWeight: 700,
              letterSpacing: '0.2px',
              lineHeight: 1,
            },
          },
          'PACS'
        )
      );
    },
  },

  // ── Hotkeys ─────────────────────────────────────────────────────────────────
  hotkeys: [
    { commandName: 'incrementActiveViewport', label: 'Next Viewport', keys: ['right'] },
    { commandName: 'decrementActiveViewport', label: 'Previous Viewport', keys: ['left'] },
    { commandName: 'rotateViewportCW', label: 'Rotate CW', keys: ['r'] },
    { commandName: 'rotateViewportCCW', label: 'Rotate CCW', keys: ['l'] },
    { commandName: 'invertViewport', label: 'Invert', keys: ['i'] },
    { commandName: 'flipViewportHorizontal', label: 'Flip H', keys: ['h'] },
    { commandName: 'flipViewportVertical', label: 'Flip V', keys: ['v'] },
    { commandName: 'scaleUpViewport', label: 'Zoom In', keys: ['+'] },
    { commandName: 'scaleDownViewport', label: 'Zoom Out', keys: ['-'] },
    { commandName: 'fitViewportToWindow', label: 'Fit to Window', keys: ['='] },
    { commandName: 'resetViewport', label: 'Reset', keys: ['space'] },
    { commandName: 'nextImage', label: 'Next Slice', keys: ['down'] },
    { commandName: 'previousImage', label: 'Prev Slice', keys: ['up'] },
    { commandName: 'nextSeries', label: 'Next Series', keys: ['pagedown'] },
    { commandName: 'previousSeries', label: 'Prev Series', keys: ['pageup'] },
  ],
};

// ─── Release WebGL contexts on teardown ───────────────────────────────────────
//
// NOT covered by the fork's initWebGLContextLossRecovery, which recovers a
// context the driver took away; this releases contexts the iframe still holds.
//
// Chrome pools WebGL contexts per GPU process and is slow to reclaim the ones an
// <iframe> held once it is navigated away. Opening study after study leaks
// contexts until the pool is exhausted and every viewer in the browser goes
// black. On `pagehide`, explicitly lose each context so the driver frees it.
//
// The onboarding-tour auto-dismiss that used to live here is GONE: the tour is
// removed in code as of dff7ea32e, so polling the DOM for a "Skip all" button
// is now dead weight.
try {
  if (typeof window !== 'undefined' && window.parent !== window) {
    window.addEventListener('pagehide', function () {
      try {
        var canvases = document.querySelectorAll('canvas');
        for (var i = 0; i < canvases.length; i++) {
          try {
            var gl = canvases[i].getContext('webgl2') || canvases[i].getContext('webgl');
            if (gl) {
              var ext = gl.getExtension('WEBGL_lose_context');
              if (ext) {
                ext.loseContext();
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    });
  }
} catch (_) {}
