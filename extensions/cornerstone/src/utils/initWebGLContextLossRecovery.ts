/**
 * WebGL context-loss recovery.
 *
 * THE PROBLEM THIS SOLVES
 * On weak integrated GPUs, building an MPR volume can exhaust GPU memory and the
 * browser takes the context away:
 *
 *     WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost
 *     TypeError: Cannot read properties of null (reading 'isAttributeUsed')
 *         at publicAPI.setMapperShaderParameters (vtk.js volume mapper)
 *
 * By default nothing in OHIF listens for this. The canvas never comes back, vtk
 * keeps issuing draw calls against a dead context, and the radiologist is left
 * with a black viewport that only a full page reload fixes — mid-report.
 *
 * Two things are needed, and the ORDER matters:
 *
 *   1. `preventDefault()` on `webglcontextlost`. Without it the browser will not
 *      fire `webglcontextrestored` at all, so recovery is impossible by spec.
 *   2. Rebuild on restore. Pixel data still lives in Cornerstone's cache, so a
 *      re-render costs no network — only GPU upload.
 *
 * And a third, learned from the field: recovery alone can loop. If we restore
 * into the SAME configuration that just exhausted the GPU, it dies again in
 * seconds. So repeated losses downgrade the machine's rendering tier for the
 * rest of the session, trading quality for a viewer that stays alive.
 */

import { getRenderingEngines } from '@cornerstonejs/core';
import { forceGpuTier, getGpuInfo, type GpuTier } from './getGpuTier';

/** Losses within this window count toward the same "storm". */
const LOSS_WINDOW_MS = 5 * 60 * 1000;
/** Losses inside the window before we downgrade the tier. */
const LOSS_LIMIT = 2;

const NEXT_TIER_DOWN: Record<GpuTier, GpuTier | null> = {
  high: 'mid',
  mid: 'low',
  low: null, // already at the cheapest GPU profile — next stop is CPU rendering
};

/**
 * Only the one method we call is required, so tests can pass a stub and any
 * future notification service stays compatible. `show` is typed loosely on
 * purpose: OHIF's own signature accepts far more (promise states, positions,
 * actions) than we use, and re-declaring it here would drift.
 */
interface NotificationLike {
  // Loose on purpose: OHIF's `show` accepts a much richer object (promise
  // states, positions, actions) than we use. Narrowing it here would make the
  // real service fail to type-check against our stub for no benefit — we only
  // ever call it with {title, message, type, duration}.
  show: (...args: any[]) => unknown;
}

interface RecoveryDeps {
  /** OHIF UI notification service; optional so this can run headless in tests. */
  uiNotificationService?: NotificationLike;
  /** Called when even the lowest tier keeps failing — last-resort escalation. */
  onUnrecoverable?: () => void;
}

const lossTimestamps: number[] = [];
const attached = new WeakSet<HTMLCanvasElement>();
let observer: MutationObserver | null = null;

function recentLossCount(now: number): number {
  while (lossTimestamps.length && now - lossTimestamps[0] > LOSS_WINDOW_MS) {
    lossTimestamps.shift();
  }
  return lossTimestamps.length;
}

/**
 * Re-render every viewport from cache. Cornerstone repopulates GPU resources on
 * demand, so asking the engines to render is enough in the common case.
 */
function rerenderAll(): void {
  for (const engine of getRenderingEngines() ?? []) {
    try {
      engine.render();
    } catch (error) {
      // A destroyed or half-initialised engine is not fatal here: the viewport
      // grid re-creates engines when the layout next changes.
      console.warn('[shealth] rendering engine could not re-render after restore', error);
    }
  }
}

function handleLost(event: Event, deps: RecoveryDeps): void {
  // MUST be called for the browser to ever restore this context.
  event.preventDefault();

  const now = Date.now();
  lossTimestamps.push(now);
  const count = recentLossCount(now);
  const { tier, renderer } = getGpuInfo();

  console.warn(
    `[shealth] WebGL context lost (${count} in the last ${LOSS_WINDOW_MS / 60000} min) ` +
      `| tier=${tier} | gpu=${renderer}`
  );

  if (count >= LOSS_LIMIT) {
    const next = NEXT_TIER_DOWN[tier];
    if (next) {
      forceGpuTier(next);
      lossTimestamps.length = 0;
      deps.uiNotificationService?.show({
        title: 'Display reset',
        message:
          'This device ran out of graphics memory. Switching to a lighter display mode — ' +
          'reload the viewer to apply it.',
        type: 'warning',
        duration: 10000,
      });
      return;
    }

    // Already at 'low' and still losing the context: nothing left to trade.
    deps.uiNotificationService?.show({
      title: 'Viewer cannot render on this device',
      message:
        'The graphics hardware keeps running out of memory. Close other tabs and reload, ' +
        'or open this study on a workstation.',
      type: 'error',
      duration: 15000,
    });
    deps.onUnrecoverable?.();
    return;
  }

  deps.uiNotificationService?.show({
    title: 'Display reset',
    message: 'Recovering the image display…',
    type: 'info',
    duration: 4000,
  });
}

function handleRestored(deps: RecoveryDeps): void {
  console.info('[shealth] WebGL context restored — re-rendering viewports from cache');
  // Give the browser a frame to finish re-creating GL resources before we draw.
  requestAnimationFrame(() => {
    rerenderAll();
    deps.uiNotificationService?.show({
      title: 'Display restored',
      message: 'The image display has recovered.',
      type: 'success',
      duration: 3000,
    });
  });
}

function attachTo(canvas: HTMLCanvasElement, deps: RecoveryDeps): void {
  if (attached.has(canvas)) {
    return;
  }
  attached.add(canvas);
  canvas.addEventListener('webglcontextlost', e => handleLost(e, deps), false);
  canvas.addEventListener('webglcontextrestored', () => handleRestored(deps), false);
}

/**
 * Attach recovery to every Cornerstone canvas, now and as viewports appear.
 *
 * Cornerstone creates canvases as viewports are enabled and layouts change, so a
 * one-shot pass over the DOM would only cover the first layout. A MutationObserver
 * keeps later ones covered without each viewport having to opt in.
 */
export default function initWebGLContextLossRecovery(deps: RecoveryDeps = {}): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  document.querySelectorAll('canvas').forEach(c => attachTo(c as HTMLCanvasElement, deps));

  observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) {
          return;
        }
        if (node instanceof HTMLCanvasElement) {
          attachTo(node, deps);
          return;
        }
        node.querySelectorAll?.('canvas').forEach(c => attachTo(c as HTMLCanvasElement, deps));
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer?.disconnect();
    observer = null;
  };
}
