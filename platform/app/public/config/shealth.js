/**
 * Shealth production OHIF configuration.
 *
 * Replaces the hand-mounted `shealth-ai-be/ohif/app-config.js` that was injected
 * into the stock OHIF container. Everything here is now version-controlled with
 * the viewer source, so a config change and the code that reads it ship together.
 *
 * Build/run with:  APP_CONFIG=config/shealth.js
 *
 * IMPORTANT — what is deliberately NOT set here:
 *
 *   webGlContextCount / preferSizeOverAccuracy / maxNumberOfWebWorkers /
 *   maxNumRequests
 *
 * Those are decided per-device at runtime by the GPU-tier profile
 * (extensions/cornerstone/src/utils/renderingProfile.ts), because one fixed
 * value cannot serve both a radiologist on a dual-core Intel-UHD laptop and one
 * on a workstation. Setting any of them here PINS it for every device and
 * disables that adaptation — only do so to work around a specific site issue.
 */

// ─── Silence verbose console noise in production ──────────────────────────────
// OHIF + the JPEG2000/charls wasm decoders log a flood of INFO lines
// ("j2k main header", "ProtocolEngine::matchImages", timing, etc). Harmless but
// spammy, and it slows the devtools console on the very machines least able to
// afford it. Keep warn + error so real problems still surface.
(function () {
  try {
    var h = window.location.hostname || '';
    var isProd = /shealth\.ai$/.test(h);
    if (isProd) {
      var noop = function () {};
      console.log = noop;
      console.info = noop;
      console.debug = noop;
      // console.warn / console.error intentionally preserved.
    }
  } catch (_) {}
})();

// ─── Resolve the DICOMweb backend at runtime ──────────────────────────────────
//
// The workspace embeds this viewer in an iframe and passes the EXACT backend it
// is itself using as `_backend` (http://localhost:8000 in dev,
// https://backend.shealth.ai on prod, test.backend… on test). The viewer must
// query the SAME backend, or the parent's pre-flight "is this study in PACS?"
// check passes while the viewer looks somewhere else and renders nothing.
var __SHEALTH_BACKEND__ = (function () {
  try {
    var qs = new URLSearchParams(window.location.search);
    var b = qs.get('_backend');
    if (b) {
      return b.replace(/\/+$/, '');
    }
  } catch (_) {}
  return 'https://backend.shealth.ai';
})();

window.config = {
  routerBasename: '/',

  // Viewer is always opened per-study from the Shealth workspace.
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
  // (COOP/COEP). With SharedArrayBuffer cornerstone streams slices into one
  // preallocated volume buffer: MPR planes fill progressively instead of staying
  // blank until 100%, and peak RAM is lower. 'AUTO' falls back safely when the
  // headers are absent, so this is harmless to leave on.
  useSharedArrayBuffer: 'AUTO',

  // ── Data source: FastAPI DICOMweb proxy → Orthanc ───────────────────────────
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'SHealth AI PACS',
        name: 'shealth',

        // Evaluated in the BROWSER, so these must be reachable from the
        // radiologist's machine — hence deriving them from `_backend` rather
        // than hardcoding a host that drifts between environments.
        qidoRoot: __SHEALTH_BACKEND__ + '/dicomweb',
        wadoRoot: __SHEALTH_BACKEND__ + '/dicomweb',
        wadoUriRoot: __SHEALTH_BACKEND__ + '/wado',

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
        // source syntax client-side. Re-add a specific UID only if a codec gap
        // appears on a real study.
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
        condition: ({ referenceInstance }) => referenceInstance?.StudyTime && window.innerWidth > 768,
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
  // The real Shealth AI mark, the same asset the main app serves at /logos.png.
  // Copied into this build (platform/app/public/logos.png) rather than linked
  // across origins: the viewer runs on its own host, so a cross-origin <img> to
  // the app would break whenever the two are on different domains — which is
  // exactly the normal deployment.
  //
  // Height-constrained with width:auto so the 722x345 source keeps its aspect
  // ratio inside the 48px header. NOT inverted: the FE sidebar applies
  // `brightness-0 invert` to force the mark white on its dark sidebar, but this
  // header is white, so the logo is used in its own colours.
  whiteLabeling: {
    createLogoComponentFn: function (React) {
      return React.createElement(
        'a',
        {
          href: '/',
          style: {
            display: 'flex',
            alignItems: 'center',
            textDecoration: 'none',
            // Breathing room on both sides so the mark never touches the header
            // edge or crowds the toolbar sitting next to it.
            padding: '0 14px 0 10px',
            height: '100%',
          },
          'aria-label': 'Shealth AI',
        },
        React.createElement('img', {
          src: './logos.png',
          alt: 'Shealth AI',
          style: {
            // 26px inside the 48px bar leaves ~11px above and below. Sizing by
            // height only (width:auto) preserves the 722x345 aspect ratio.
            height: '26px',
            width: 'auto',
            objectFit: 'contain',
            display: 'block',
          },
        })
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
  ],
};
