/**
 * SHealth ↔ viewer message bridge.
 *
 * WHY THIS EXISTS
 * The SHealth workspace embeds this viewer in an iframe and talks to it over
 * `postMessage`. It sends two requests:
 *
 *   shealth:capture-request  → "give me the image the radiologist is looking at"
 *   shealth:render-check     → "has the study actually painted yet?"
 *
 * Until this module existed, nothing in the viewer listened for either one. The
 * host was not receiving a wrong answer - it was receiving no answer, and both
 * features degraded into timeouts that blamed the study:
 *
 *   - Capture waited 8s and reported "The viewer didn't respond. Wait for the
 *     image to load fully then retry." No amount of waiting helped; the request
 *     was never being read.
 *   - The render watchdog polled for a status that never came and eventually
 *     showed "The viewer is taking a while to render this study" over a study
 *     that had been on screen for a minute.
 *
 * The counterpart of this file is `loadTelemetry.ts`, which posts timings OUT to
 * the host. That one is send-only; this one is the receive half. Together they
 * are the whole of the SHealth ↔ viewer protocol.
 *
 * WHY NO IMPORTS FROM CORNERSTONE
 * Everything this module needs - the active viewport id, the viewport object,
 * its canvas - arrives through `servicesManager`, which the host extension
 * already owns. Importing `@cornerstonejs/core` here would buy nothing and cost
 * two things: the multi-bundle duplicate-instance trap that already burned
 * `loadTelemetry` (see its header), and a unit test that cannot run without the
 * full rendering stack. The seams are the service objects, so the tests drive
 * this with plain fakes.
 *
 * WHY IT NEVER POLLS
 * This module is purely reactive: one `message` listener, one reply per request.
 * The host owns the polling cadence for render-check and stops the moment it is
 * told `rendered: true`. A retry loop in here would race the host's own poll and
 * could keep firing after the host had given up.
 *
 * WHY IT ALWAYS REPLIES
 * Every path - no viewport, no image, an exception inside the capture - ends in
 * a reply. Silence is the one outcome the host cannot tell apart from a broken
 * viewer, and silence is what produced the bug this module fixes. An error the
 * host can show beats a correct answer it never receives.
 */

/** Host → viewer: capture the active viewport. */
export const CAPTURE_REQUEST_TYPE = 'shealth:capture-request';
/** Viewer → host: `{ dataUrl }` on success, `{ error }` otherwise. */
export const CAPTURE_RESPONSE_TYPE = 'shealth:capture-response';
/** Host → viewer: has the active viewport painted an image? */
export const RENDER_CHECK_TYPE = 'shealth:render-check';
/** Viewer → host: `{ rendered: boolean }`. */
export const RENDER_STATUS_TYPE = 'shealth:render-status';

/** Namespace every request must carry. Also the cheapest possible reject. */
const MESSAGE_NAMESPACE = 'shealth:';

// Error codes. Lower case and human-readable because the host interpolates them
// straight into a toast ("Capture failed: no image loaded") - a machine code
// would reach a radiologist as noise.
export const NO_VIEWPORT_ERROR = 'no active viewport';
export const NO_IMAGE_ERROR = 'no image loaded';
export const CAPTURE_FAILED_ERROR = 'capture failed';

/**
 * Longest edge of a captured image, in pixels.
 *
 * The capture is JSON-stringified into the report's `key_images` column, so its
 * size is a database row, not a temp file. A 4K viewport at full size is several
 * megabytes of base64 per key image; 1920 keeps a capture diagnostic-legible at
 * a fraction of that. Untouched when the viewport is already smaller.
 */
const MAX_CAPTURE_EDGE = 1920;

/** JPEG rather than PNG: same visual result on greyscale, far smaller payload. */
const CAPTURE_MIME = 'image/jpeg';
const CAPTURE_QUALITY = 0.9;

/**
 * Ceiling on rasterising the annotation layer.
 *
 * The host's own patience is 8s and annotations are a nice-to-have, so a slow or
 * stuck SVG decode must not consume the whole budget: past this we return the
 * image without the overlay rather than returning nothing.
 */
const ANNOTATION_RASTER_TIMEOUT_MS = 1500;

/**
 * Install marker.
 *
 * On `window`, not in a module-level boolean, for the reason spelled out in
 * loadTelemetry: a module-scope flag is reset by an HMR cycle or a second module
 * instance while the listener it was guarding is still attached, and the result
 * is two replies to every request. A window property outlives module scope
 * within the realm, which is exactly the lifetime of the listener.
 */
const INSTALL_MARKER = '__shealthBridgeInstalled';

// ── Minimal structural types ─────────────────────────────────────────────────
//
// Deliberately structural rather than imported from cornerstone/OHIF: this
// module only ever touches these few members, and typing them here is what lets
// the suite substitute plain objects.

interface ViewportLike {
  id?: string;
  element?: HTMLElement;
  getCanvas?: () => HTMLCanvasElement | null;
  render?: () => void;
  getImageData?: () => unknown;
  getActors?: () => unknown[];
  getCurrentImageId?: () => string | undefined;
  defaultOptions?: { background?: number[] };
}

interface BridgeServices {
  viewportGridService?: { getActiveViewportId?: () => string | undefined };
  cornerstoneViewportService?: {
    getCornerstoneViewport?: (viewportId: string) => ViewportLike | null;
    getViewportIds?: () => string[];
  };
}

export interface ShealthBridgeOptions {
  /**
   * OHIF's services manager. Typed as `unknown` at this boundary on purpose:
   * the real one is a large class whose viewport services this module only
   * duck-types, and demanding structural conformance here would turn an
   * unrelated upstream signature change into a build break in a file that never
   * touched the member in question. The narrowing happens once, on read.
   */
  servicesManager: { services?: unknown };
  /**
   * Optional host origin allowlist. When set, only these origins are answered.
   * When unset the bridge falls back to "must have come from our embedder"
   * (see `isTrustedRequest`) - the viewer is deployed against several SHealth
   * hosts (prod, test, local) and hardcoding them here would break the others.
   */
  allowedOrigins?: string[];
}

/** Swallow anything a viewport getter throws; a probe must never break capture. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * The viewport the radiologist is actually looking at.
 *
 * `viewportGridService.getActiveViewportId()` is the authority - it is the same
 * value OHIF's own toolbar acts on, so a capture follows the focus border
 * through every layout change. The fallback exists only for the window between
 * "viewports enabled" and "grid has published an active id", and walks the
 * service's own id order.
 *
 * NOT "the largest canvas on the page". That heuristic captures the wrong series
 * in every multi-viewport layout the moment the radiologist selects a smaller
 * pane, and it fails silently - the capture looks plausible and belongs to
 * another image.
 */
export function resolveActiveViewport(
  services: BridgeServices | undefined
): { viewport: ViewportLike; viewportId: string } | null {
  const cornerstoneViewportService = services?.cornerstoneViewportService;
  const getViewport = cornerstoneViewportService?.getCornerstoneViewport;

  if (!getViewport) {
    return null;
  }

  const read = (viewportId: string): ViewportLike | null => {
    const viewport = attempt(() => getViewport.call(cornerstoneViewportService, viewportId));
    return viewport ?? null;
  };

  const activeId = attempt(() => services?.viewportGridService?.getActiveViewportId?.());

  if (activeId) {
    const viewport = read(activeId);
    if (viewport) {
      return { viewport, viewportId: activeId };
    }
  }

  const ids =
    attempt(() => cornerstoneViewportService?.getViewportIds?.call(cornerstoneViewportService)) ??
    [];

  for (const id of ids) {
    const viewport = read(id);
    if (viewport) {
      return { viewport, viewportId: id };
    }
  }

  return null;
}

/**
 * Has this viewport painted something?
 *
 * Cheap by design. The host polls this every 2s, so it must cost near nothing:
 * no capture, no `toDataURL`, and above all no pixel readback - that stalls the
 * GPU pipeline, and doing it on a timer would make the viewer slower in exactly
 * the situation the check exists to detect.
 *
 * Three structural signals, any of which means content is mounted. They are
 * tried in order because viewport types implement different subsets: stack
 * viewports answer `getImageData`/`getCurrentImageId`, volume and video
 * viewports answer `getActors`.
 *
 * Pixel darkness is deliberately NOT a signal. A brain window on a non-contrast
 * CT is mostly black; "looks black" and "is blank" are indistinguishable from
 * the pixels, and guessing wrong here resurrects the false "taking a while"
 * banner this bridge exists to remove.
 */
export function isViewportRendered(viewport: ViewportLike | null | undefined): boolean {
  if (!viewport) {
    return false;
  }

  const canvas = attempt(() => viewport.getCanvas?.());
  if (!canvas?.width || !canvas?.height) {
    return false;
  }

  if (attempt(() => viewport.getImageData?.()) != null) {
    return true;
  }

  const actors = attempt(() => viewport.getActors?.());
  if (Array.isArray(actors) && actors.length > 0) {
    return true;
  }

  return Boolean(attempt(() => viewport.getCurrentImageId?.()));
}

/** Viewport background as a CSS colour; cornerstone stores it as 0..1 RGB. */
function backgroundColor(viewport: ViewportLike): string {
  const background = viewport.defaultOptions?.background;

  if (!Array.isArray(background) || background.length < 3) {
    return '#000000';
  }

  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
  return `rgb(${channel(background[0])}, ${channel(background[1])}, ${channel(background[2])})`;
}

/**
 * Copy the live viewport canvas into an offscreen 2D canvas.
 *
 * MUST be called synchronously after `viewport.render()`. Under the context-pool
 * rendering engine the on-screen canvas IS a WebGL canvas, and a WebGL drawing
 * buffer created without `preserveDrawingBuffer` is cleared once the browser
 * composites the frame. Reading it in the same task as the draw call gets the
 * pixels; reading it after an `await` gets a blank image - intermittently, and
 * only on the machines using that engine, which is the worst way to find out.
 *
 * Once the pixels are in this 2D canvas they are ours and awaiting is safe,
 * which is why the annotation overlay happens afterwards rather than inline.
 */
function copyToOffscreenCanvas(
  source: HTMLCanvasElement,
  background: string
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(CAPTURE_FAILED_ERROR);
  }

  // Fill first: JPEG has no alpha, so transparent pixels would encode as white
  // fringing around the image instead of the viewport's own background.
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  return { canvas, context };
}

/** Duplicate an already-captured canvas, so the pristine copy survives. */
function cloneCanvas(source: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(CAPTURE_FAILED_ERROR);
  }

  context.drawImage(source, 0, 0);
  return { canvas, context };
}

/**
 * The annotation overlay for a viewport, or null when there is nothing to draw.
 *
 * Cornerstone draws measurements into an SVG sibling of the image canvas
 * (`svg-layer-<viewportId>`), so a canvas copy alone loses every length, angle
 * and arrow the radiologist placed - the parts of a key image that carry the
 * argument. An empty layer returns null so an unannotated capture skips the
 * whole rasterise path.
 */
function findAnnotationLayer(element: HTMLElement | undefined): SVGSVGElement | null {
  if (!element?.querySelector) {
    return null;
  }

  const svg =
    element.querySelector<SVGSVGElement>('svg[id^="svg-layer"]') ??
    element.querySelector<SVGSVGElement>('svg');

  if (!svg || svg.childNodes.length === 0) {
    return null;
  }

  return svg;
}

/** Decode a data URL, giving up after `timeoutMs` rather than hanging capture. */
function loadImage(src: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    let settled = false;
    const image = new Image();

    const finish = (value: HTMLImageElement | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };

    const timer = window.setTimeout(() => finish(null), timeoutMs);

    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = src;
  });
}

/**
 * Rasterise the annotation SVG over an already-copied image. Returns whether
 * anything was drawn - false means "capture the image without annotations",
 * never "fail the capture".
 */
async function overlayAnnotations(
  context: CanvasRenderingContext2D,
  svg: SVGSVGElement,
  width: number,
  height: number
): Promise<boolean> {
  const bounds = attempt(() => svg.getBoundingClientRect?.());
  // The SVG layer is absolutely positioned over the canvas at the same CSS size,
  // so its own box is the coordinate space its children were laid out in. The
  // canvas backing store may be larger (device pixel ratio); drawing the raster
  // across the full backing store rescales the annotations to match the image
  // without needing to know the ratio.
  const layoutWidth = bounds?.width || width;
  const layoutHeight = bounds?.height || height;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(layoutWidth));
  clone.setAttribute('height', String(layoutHeight));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${layoutWidth} ${layoutHeight}`);
  }

  const markup = new XMLSerializer().serializeToString(clone);
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
    ANNOTATION_RASTER_TIMEOUT_MS
  );

  if (!image) {
    return false;
  }

  context.drawImage(image, 0, 0, width, height);
  return true;
}

/**
 * Capture the given viewport as a JPEG data URL, annotations included.
 *
 * Throws `NO_IMAGE_ERROR` when there is no canvas to read. Every other failure
 * degrades: a missing or unrasterisable annotation layer costs the overlay, not
 * the capture.
 */
export async function captureViewport(viewport: ViewportLike): Promise<string> {
  const source = attempt(() => viewport.getCanvas?.());

  if (!source?.width || !source?.height) {
    throw new Error(NO_IMAGE_ERROR);
  }

  // Force a frame, then copy in the same task - see copyToOffscreenCanvas.
  attempt(() => viewport.render?.());
  const base = copyToOffscreenCanvas(source, backgroundColor(viewport));

  const svg = findAnnotationLayer(viewport.element);
  if (!svg) {
    return base.canvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
  }

  // Annotations go onto a copy. Rasterising an SVG can taint a canvas in some
  // browsers, and a tainted canvas throws on toDataURL - at which point the only
  // way back to an untainted image is a copy made before the overlay. Re-reading
  // the live viewport canvas then would be too late: the WebGL buffer is gone.
  const annotated = attempt(() => cloneCanvas(base.canvas));
  if (!annotated) {
    return base.canvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
  }

  const drew = await overlayAnnotations(
    annotated.context,
    svg,
    annotated.canvas.width,
    annotated.canvas.height
  ).catch(() => false);

  if (!drew) {
    return base.canvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
  }

  try {
    return annotated.canvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
  } catch {
    return base.canvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
  }
}

/**
 * Is this message one we should act on?
 *
 * Two independent gates, because a `message` listener hears from every frame
 * that can reach this window:
 *
 *  - Type. Must be an object carrying a `shealth:`-namespaced string type.
 *  - Sender. With an allowlist configured, the origin must be on it. Without
 *    one, the message must have come from our embedder - `event.source` is set
 *    by the browser and cannot be forged by the sender, so an unrelated frame
 *    or a same-window script cannot pose as the host.
 *
 * A viewer opened standalone has no embedder (`window.parent === window`) and
 * answers nothing: there is no host to serve, and accepting self-posted
 * messages would turn any script on the page into the host.
 */
function isTrustedRequest(event: MessageEvent, allowedOrigins?: string[]): boolean {
  const data = event?.data as { type?: unknown } | null;

  if (!data || typeof data !== 'object') {
    return false;
  }

  if (typeof data.type !== 'string' || !data.type.startsWith(MESSAGE_NAMESPACE)) {
    return false;
  }

  if (!window.parent || window.parent === window) {
    return false;
  }

  if (allowedOrigins?.length) {
    return allowedOrigins.includes(event.origin);
  }

  return event.source === window.parent;
}

/** Reply to whoever asked, pinned to their origin where the browser gave us one. */
function respond(event: MessageEvent, payload: Record<string, unknown>): void {
  const target = (event.source as Window | null) ?? window.parent;

  if (!target?.postMessage) {
    return;
  }

  // '*' only for an opaque origin (a sandboxed host reports "null"), where there
  // is no origin to pin to. The host validates our origin on its side regardless.
  const targetOrigin = event.origin && event.origin !== 'null' ? event.origin : '*';

  try {
    target.postMessage(payload, targetOrigin);
  } catch {
    /* a host that refuses messages must not break the viewer */
  }
}

/** Uninstaller for the listener currently attached, if any. */
let activeUninstall: (() => void) | null = null;

/**
 * Attach the bridge. Idempotent, and returns an uninstaller.
 *
 * No per-request state and no in-flight lock: two overlapping captures cost one
 * extra frame copy, whereas a lock that failed to clear would silence the bridge
 * for the rest of the session - the exact failure mode this file exists to fix.
 */
export function installShealthBridge(options: ShealthBridgeOptions): () => void {
  const noop = () => undefined;

  if (typeof window === 'undefined') {
    return noop;
  }

  if ((window as unknown as Record<string, unknown>)[INSTALL_MARKER]) {
    return activeUninstall ?? noop;
  }

  const { servicesManager, allowedOrigins } = options;

  /** The one place the manager is narrowed to what this module actually uses. */
  const services = () => servicesManager?.services as BridgeServices | undefined;

  const handleCapture = async (event: MessageEvent): Promise<void> => {
    try {
      const active = resolveActiveViewport(services());

      if (!active) {
        respond(event, { type: CAPTURE_RESPONSE_TYPE, error: NO_VIEWPORT_ERROR });
        return;
      }

      if (!isViewportRendered(active.viewport)) {
        respond(event, { type: CAPTURE_RESPONSE_TYPE, error: NO_IMAGE_ERROR });
        return;
      }

      const dataUrl = await captureViewport(active.viewport);

      if (!dataUrl) {
        respond(event, { type: CAPTURE_RESPONSE_TYPE, error: NO_IMAGE_ERROR });
        return;
      }

      respond(event, {
        type: CAPTURE_RESPONSE_TYPE,
        dataUrl,
        viewportId: active.viewportId,
      });
    } catch (error) {
      respond(event, {
        type: CAPTURE_RESPONSE_TYPE,
        error: (error as Error)?.message || CAPTURE_FAILED_ERROR,
      });
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (!isTrustedRequest(event, allowedOrigins)) {
      return;
    }

    const { type } = event.data as { type: string };

    if (type === RENDER_CHECK_TYPE) {
      const active = resolveActiveViewport(services());
      respond(event, {
        type: RENDER_STATUS_TYPE,
        rendered: isViewportRendered(active?.viewport),
        viewportId: active?.viewportId,
      });
      return;
    }

    if (type === CAPTURE_REQUEST_TYPE) {
      // Fire and forget: `handleCapture` owns its own error handling and always
      // replies, so there is nothing here left to await or catch.
      void handleCapture(event);
    }
  };

  window.addEventListener('message', onMessage);
  (window as unknown as Record<string, unknown>)[INSTALL_MARKER] = true;

  // One line, at install, never per request.
  //
  // The original bug was indistinguishable from a slow study, and the question
  // that would have settled it in seconds - "is the bundle serving this iframe
  // one that has the bridge?" - had no answer from the outside. This is that
  // answer, and it is the first thing to look for in the console when capture
  // misbehaves: no line means the host is talking to an older build.
  // eslint-disable-next-line no-console
  console.info('[shealth] viewer bridge ready (capture + render-check)');

  activeUninstall = () => {
    window.removeEventListener('message', onMessage);
    delete (window as unknown as Record<string, unknown>)[INSTALL_MARKER];
    activeUninstall = null;
  };

  return activeUninstall;
}

/** Test seam - detach whatever is installed, so a suite starts clean. */
export function _resetShealthBridge(): void {
  activeUninstall?.();
  activeUninstall = null;
  delete (window as unknown as Record<string, unknown>)[INSTALL_MARKER];
}
