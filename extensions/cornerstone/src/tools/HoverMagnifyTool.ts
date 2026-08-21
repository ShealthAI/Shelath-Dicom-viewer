import { MagnifyTool, Enums as csToolsEnums } from '@cornerstonejs/tools';
import {
  Enums as csCoreEnums,
  StackViewport,
  eventTarget,
  getEnabledElement,
  getEnabledElements,
  utilities as csCoreUtils,
} from '@cornerstonejs/core';
import { vec3 } from 'gl-matrix';
import { getMagnifyZoom, subscribeMagnifyZoom } from './magnifyZoomStore';

/**
 * A magnifier that follows the pointer.
 *
 * WHY THIS EXISTS
 * Neither stock tool does what a radiologist means by "magnify":
 *
 *   - MagnifyTool requires holding the mouse button down and dragging. Letting
 *     go destroys the loupe, so surveying an organ means clamping the button
 *     while tracing across the image.
 *   - AdvancedMagnifyTool pins a magnifying glass where you clicked. It is a
 *     placed annotation: the pointer moves, the loupe does not.
 *
 * What was asked for, and what Synapse does, is simpler: turn it on, and the
 * magnified region tracks the cursor. That is this tool.
 *
 * HOW
 * MagnifyTool already knows how to build the magnification viewport, position
 * its camera, and tear it down. All of that is reused. The only change is WHEN:
 * the loupe is created on the first pointer move over the image rather than on
 * mouse-down, and it is updated on every subsequent move instead of on drag.
 * Reimplementing the viewport plumbing here would duplicate a hundred lines and
 * drift from upstream at the next Cornerstone bump.
 *
 * DESIGN NOTES
 *   - The loupe is destroyed when the pointer leaves the image, so it never
 *     hangs over the UI or an adjacent viewport.
 *   - Mouse-down is deliberately NOT hijacked: with the loupe following the
 *     cursor, a click should still do what a click normally does.
 *   - Camera is positioned from absolute world coordinates rather than the
 *     accumulated deltas MagnifyTool uses for dragging. Deltas drift over a long
 *     hover; absolute positioning cannot.
 */
class HoverMagnifyTool extends MagnifyTool {
  static toolName = 'HoverMagnify';
  /** Set by initCornerstoneTools; declared so it type-checks as a static. */
  static isAnnotation = false;

  private _isShowing = false;
  private _boundMove: ((evt: Event) => void) | null = null;
  private _boundLeave: ((evt: Event) => void) | null = null;
  private _rafId: number | null = null;
  private _openLoupe: MagnifyTool['preMouseDownCallback'];
  private _boundElementEnabled: ((evt: Event) => void) | null = null;
  private _unsubscribeZoom: (() => void) | null = null;
  private _last: {
    element: HTMLElement;
    enabledElement;
    currentPoints;
  } | null = null;
  private _pending: {
    element: HTMLElement;
    enabledElement;
    currentPoints;
  } | null = null;

  constructor(
    toolProps = {},
    defaultToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {
        // Larger window and gentler magnification than upstream's 250px @ 10.
        // A small window at high zoom shows very few acquired pixels, which is
        // what reads as a blurry smear on low-matrix series.
        magnifySize: 5,
        magnifyWidth: 350,
        magnifyHeight: 350,
      },
    }
  ) {
    super(toolProps, defaultToolProps);

    // Keep a handle on upstream's real entry point before shadowing it: _show
    // still needs to call it to build the magnification viewport.
    this._openLoupe = this.preMouseDownCallback;

    // The framework invokes preMouseDownCallback on the active tool for every
    // mouse-down, and whatever it throws goes straight to the error boundary.
    //
    // Two guards, for two different failures seen in production:
    //
    //   * ALREADY OPEN. Clicking while the loupe follows the pointer would
    //     build a SECOND magnification viewport over the first, append a second
    //     DOM node, and re-arm the drag listeners _show deliberately unbinds.
    //
    //   * UNSUPPORTED VIEWPORT. MagnifyTool throws on anything that is not a
    //     stack or native planar viewport. On hover that throw is caught in
    //     _show, so the loupe simply never appears - but a plain mouse-down on
    //     an MPR pane came through here uncaught and put "MagnifyTool only
    //     works on Stack or native planar viewports" on screen as a crash
    //     dialog, over the study.
    //
    // Returning false in both cases leaves the click to behave normally.
    this.preMouseDownCallback = (evt: Parameters<typeof this._openLoupe>[0]) => {
      if (this._isShowing || !this._canMagnify(evt?.detail?.element)) {
        return false;
      }
      try {
        return this._openLoupe(evt);
      } catch {
        // Belt and braces: the capability check above should already have
        // prevented this, but nothing this tool does is worth a modal.
        return false;
      }
    };
  }

  /**
   * Cornerstone calls this when the tool becomes the active binding. Attaching
   * here (rather than on mouse-down) is what makes the loupe hover-driven.
   */
  onSetToolActive(): void {
    this._attach();
  }

  onSetToolPassive(): void {
    this._detach();
  }

  onSetToolEnabled(): void {
    this._detach();
  }

  onSetToolDisabled(): void {
    this._detach();
  }

  private _attach(): void {
    if (this._boundMove) {
      return;
    }
    this._boundMove = (evt: Event) => this._handleMove(evt as CustomEvent);
    this._boundLeave = () => this._hide();

    // Bind to each viewport element, NOT to document.
    //
    // Cornerstone dispatches its events as `new CustomEvent(type, { detail,
    // cancelable })` with no `bubbles` flag, so they default to bubbles:false
    // and never reach document. A document-level listener reads as correct and
    // is silently dead — the loupe would simply never appear.
    this._forEachElement(element => this._bindElement(element));

    // Panels that appear AFTER the tool was switched on must be bound too.
    // Changing layout (1x1 to 2x2, or loading another series) enables new
    // viewport elements; without this the loupe would work on the panes that
    // happened to exist when the button was pressed and be silently dead on the
    // rest, which looks like the feature randomly not working.
    this._boundElementEnabled = (evt: Event) => {
      const element = (evt as CustomEvent)?.detail?.element as HTMLElement | undefined;
      if (element) {
        this._bindElement(element);
      }
    };
    eventTarget.addEventListener(
      csCoreEnums.Events.ELEMENT_ENABLED,
      this._boundElementEnabled
    );

    // Dragging the zoom slider must move the loupe that is already open, not
    // only the next one. Re-position from the last known pointer location.
    this._unsubscribeZoom = subscribeMagnifyZoom(zoom => {
      this.configuration.magnifySize = zoom;
      if (this._isShowing && this._last) {
        this._moveTo(this._last.element, this._last.enabledElement, this._last.currentPoints);
      }
    });
  }

  /** Idempotent: removeEventListener first, so a re-bind cannot double-fire. */
  private _bindElement(element: HTMLElement): void {
    if (!this._boundMove || !this._boundLeave) {
      return;
    }
    element.removeEventListener(csToolsEnums.Events.MOUSE_MOVE, this._boundMove);
    element.removeEventListener('mouseleave', this._boundLeave);
    element.addEventListener(csToolsEnums.Events.MOUSE_MOVE, this._boundMove);
    element.addEventListener('mouseleave', this._boundLeave);
  }

  private _detach(): void {
    this._forEachElement(element => {
      if (this._boundMove) {
        element.removeEventListener(csToolsEnums.Events.MOUSE_MOVE, this._boundMove);
      }
      if (this._boundLeave) {
        element.removeEventListener('mouseleave', this._boundLeave);
      }
    });
    this._unsubscribeZoom?.();
    this._unsubscribeZoom = null;
    if (this._boundElementEnabled) {
      eventTarget.removeEventListener(
        csCoreEnums.Events.ELEMENT_ENABLED,
        this._boundElementEnabled
      );
      this._boundElementEnabled = null;
    }
    this._boundMove = null;
    this._boundLeave = null;
    this._hide();
  }

  /** Every currently enabled viewport element. */
  private _forEachElement(fn: (element: HTMLElement) => void): void {
    try {
      for (const enabled of getEnabledElements() ?? []) {
        const element = enabled?.viewport?.element as HTMLElement | undefined;
        if (element) {
          fn(element);
        }
      }
    } catch {
      /* rendering engine torn down mid-teardown — nothing to bind */
    }
  }

  private _handleMove(evt: CustomEvent): void {
    const detail = evt?.detail;
    const element = detail?.element;
    if (!element || !detail?.currentPoints) {
      return;
    }

    const enabledElement = getEnabledElement(element);
    if (!enabledElement) {
      return;
    }

    // Skip panes the loupe cannot work on rather than attempting and catching.
    // An MPR pane simply gets no magnifier, which is the honest outcome - and
    // it keeps the throw out of the mouse-down path entirely.
    if (!this._canMagnify(element)) {
      return;
    }

    if (!this._isShowing) {
      this._show(evt, element, enabledElement);
      return;
    }

    this._scheduleMove(element, enabledElement, detail.currentPoints);
  }

  /**
   * Coalesce pointer moves to one update per frame.
   *
   * MOUSE_MOVE fires at the pointer's report rate, which on a 1000 Hz mouse is
   * far above the display refresh. Every one of those would otherwise cost a
   * setCamera plus a render. On the weak integrated GPUs this viewer has to run
   * on that is wasted work competing with the volume for the same budget, so
   * only the newest position each frame is drawn — which is all that is
   * visible anyway.
   */
  private _scheduleMove(element: HTMLElement, enabledElement, currentPoints): void {
    this._pending = { element, enabledElement, currentPoints };
    if (this._rafId !== null) {
      return;
    }
    this._rafId = window.requestAnimationFrame(() => {
      this._rafId = null;
      const pending = this._pending;
      this._pending = null;
      if (pending && this._isShowing) {
        this._moveTo(pending.element, pending.enabledElement, pending.currentPoints);
      }
    });
  }

  /**
   * Whether MagnifyTool can operate on this pane.
   *
   * Deliberately the same test MagnifyTool makes internally before throwing.
   * Asking first rather than catching afterwards is what keeps the error out of
   * the framework's mouse-down path, where it becomes a crash dialog.
   */
  private _canMagnify(element?: HTMLElement): boolean {
    if (!element) {
      return false;
    }
    try {
      const viewport = getEnabledElement(element as HTMLDivElement)?.viewport;
      if (!viewport) {
        return false;
      }
      return viewport instanceof StackViewport || Boolean(csCoreUtils.isGenericViewport(viewport));
    } catch {
      return false;
    }
  }

  private _show(evt: CustomEvent, element: HTMLElement, enabledElement): void {
    try {
      // Upstream builds the magnification viewport asynchronously and sets its
      // camera from `configuration.magnifySize` when the stack resolves —
      // AFTER the _moveTo below has run. Without this line the loupe would open
      // at the built-in default and only jump to the radiologist's chosen zoom
      // on the next pointer move.
      this.configuration.magnifySize = getMagnifyZoom();

      // Reuse MagnifyTool's own entry point: it validates the viewport type,
      // resolves the referenced image, creates the magnification viewport and
      // hides the cursor. Everything after this is just repositioning.
      const handled = this._openLoupe?.(evt);
      if (!handled) {
        return;
      }

      // Immediately undo the drag machinery preMouseDownCallback switched on.
      // It is built for press-drag-release and actively fights hover mode:
      //
      //   * it binds MOUSE_UP and MOUSE_CLICK to _dragEndCallback, so the first
      //     click anywhere on the image would tear the loupe down, and
      //   * it sets the global `isInteractingWithTool` flag, which stays true
      //     for the whole hover and suppresses other tools' hover handling.
      //
      // _deactivateDraw unbinds those listeners and clears the flag while
      // leaving the magnification viewport and its DOM node in place — which is
      // exactly the state hover mode wants, since we drive movement ourselves
      // from MOUSE_MOVE.
      this._deactivateDraw?.(element as HTMLDivElement);

      this._isShowing = true;

      // DELIBERATELY NOT calling _moveTo here.
      //
      // _createMagnificationViewport positions the camera inside
      // `setStack(...).then(...)`, and it derives the camera DISTANCE by reading
      // the viewport's current camera at that moment. Writing a camera before
      // that promise resolves means writing into a viewport with no stack - and
      // upstream then reads our value back and preserves it for the life of the
      // loupe.
      //
      // That is what produced a correctly sized, correctly positioned, solid
      // black loupe: whatever distance we wrote first became permanent, and the
      // image sat outside the resulting clipping range. It was not the value we
      // chose that was wrong so much as the timing of writing one at all.
      //
      // Upstream positions the first frame from the pointer location it was
      // given, which is exactly where it should be. Tracking takes over on the
      // next pointer move, by which time the stack has resolved and the camera
      // is real.
    } catch (error) {
      // A non-stack viewport (e.g. a volume/MPR pane) throws by design in
      // MagnifyTool. Failing quietly is correct: the radiologist simply gets no
      // loupe there rather than an error dialog mid-read.
      this._isShowing = false;
      // A throw part-way through creation can leave the loupe div behind.
      this._removeOrphanedLoupes();
    }
  }

  private _moveTo(element: HTMLElement, enabledElement, currentPoints): void {
    const magnifyElement = element.querySelector('.magnifyTool') as HTMLElement | null;
    if (!magnifyElement) {
      this._isShowing = false;
      return;
    }

    const { magnifyWidth, magnifyHeight } = this.configuration;
    const canvasPos = currentPoints.canvas;

    magnifyElement.style.left = `${canvasPos[0] - magnifyWidth / 2}px`;
    magnifyElement.style.top = `${canvasPos[1] - magnifyHeight / 2}px`;

    const { renderingEngine } = enabledElement;
    const magnifyViewport = renderingEngine?.getViewport('magnify-viewport');
    if (!magnifyViewport) {
      return;
    }

    this._last = { element, enabledElement, currentPoints };

    // Absolute world positioning. MagnifyTool accumulates drag deltas, which is
    // fine for a short drag but drifts across a long hover; deriving the camera
    // from the pointer's world position every time cannot drift.
    const world = currentPoints.world;
    const camera = magnifyViewport.getCamera();
    const normal = camera.viewPlaneNormal ?? [0, 0, 1];

    // Camera distance is READ from the viewport, never invented.
    //
    // This line used to be `const distance = 100`, which produced a loupe that
    // was correctly sized and positioned and rendered solid black. A camera
    // distance is in patient millimetres and the viewport's clipping range is
    // derived from the distance it was set up with; dropping the camera to an
    // arbitrary 100 mm put the image outside that range, so there was nothing
    // left in front of the camera to draw.
    //
    // Upstream never invents it either - both _createMagnificationViewport and
    // _dragCallback preserve the existing focalPoint→position vector. This does
    // the same, and only moves where that vector points.
    const focal = camera.focalPoint ?? [0, 0, 0];
    const position = camera.position ?? [0, 0, 0];
    const distance =
      Math.hypot(
        focal[0] - position[0],
        focal[1] - position[1],
        focal[2] - position[2]
      ) || 1;

    // Re-derive the zoom on every move instead of taking whatever was set when
    // the loupe was created. Two things depend on this:
    //   * the zoom slider changes the magnification of an OPEN loupe, and
    //   * magnification stays relative to the base image, so zooming the
    //     underlying viewport no longer silently changes how much the loupe
    //     actually magnifies.
    const sourceScale = this._sourceParallelScale(enabledElement?.viewport);
    const parallelScale =
      sourceScale === undefined ? undefined : sourceScale / getMagnifyZoom();

    magnifyViewport.setCamera({
      ...(parallelScale === undefined ? {} : { parallelScale }),
      focalPoint: [world[0], world[1], world[2]],
      position: [
        world[0] + normal[0] * distance,
        world[1] + normal[1] * distance,
        world[2] + normal[2] * distance,
      ],
    });
    magnifyViewport.render();
  }

  /**
   * The source viewport's parallel scale, i.e. the world height its canvas
   * covers. Dividing it by the zoom factor is what magnifies.
   *
   * Mirrors upstream's own computation, including the generic-viewport branch:
   * a generic (native planar / video) viewport has no meaningful camera
   * parallelScale, so it is measured from how much world one canvas pixel
   * spans. Diverging here would make the loupe a different size on those
   * viewports than the tool it extends.
   */
  private _sourceParallelScale(viewport): number | undefined {
    if (!viewport) {
      return undefined;
    }
    try {
      if (csCoreUtils.isGenericViewport(viewport)) {
        const worldTop = viewport.canvasToWorld([0, 0]);
        const worldBottom = viewport.canvasToWorld([0, 1]);
        const worldPerPixel = vec3.distance(worldTop, worldBottom);
        return (worldPerPixel * viewport.element.clientHeight) / 2;
      }
      return viewport.getCamera?.()?.parallelScale;
    } catch {
      // Leaving the existing scale alone is the safe failure: the loupe keeps
      // working at whatever magnification it already had.
      return undefined;
    }
  }

  private _hide(): void {
    if (!this._isShowing) {
      // Still sweep. _isShowing goes false on its own whenever _moveTo finds no
      // loupe element, so "we think nothing is open" is exactly the state in
      // which an orphan can already be sitting on the images. Returning early
      // here left it there until the next full teardown.
      this._removeOrphanedLoupes();
      return;
    }
    this._isShowing = false;
    if (this._rafId !== null) {
      window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._pending = null;
    this._last = null;
    try {
      // MagnifyTool's own teardown: disables the magnify viewport, removes the
      // DOM node and restores the cursor. It resolves the element from
      // editData when the detail omits one, so an empty detail is the
      // documented way to say "tear down whatever is open".
      (this._dragEndCallback as unknown as (evt: { detail: Record<string, unknown> }) => void)?.({
        detail: {},
      });
    } catch {
      /* upstream teardown failed - the sweep below is what actually matters */
    }

    // Upstream's teardown does `viewportElement.removeChild(magnifyToolElement)`
    // with no null guard, so if the pane's `.viewport-element` has gone - a
    // layout change, a viewport rebuild - it throws PART WAY THROUGH and leaves
    // the loupe div in the DOM. It renders as an opaque black square sitting
    // over the images, which is what was reported from production.
    //
    // So the DOM is swept unconditionally afterwards: whatever upstream managed
    // to remove is already gone, and anything it left behind goes here.
    this._removeOrphanedLoupes();
  }

  /** Remove any magnifier DOM left over from a failed teardown. */
  private _removeOrphanedLoupes(): void {
    this._forEachElement(element => {
      element.querySelectorAll('.magnifyTool').forEach(node => node.remove());
    });
  }
}

export default HoverMagnifyTool;
