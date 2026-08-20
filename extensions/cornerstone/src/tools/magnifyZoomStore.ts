/**
 * The magnifier's zoom factor, shared between the toolbar control and the tool.
 *
 * WHY A STORE RATHER THAN TOOL CONFIGURATION
 * The obvious place for this is `configuration.magnifySize` on the tool
 * instance. It is the wrong place for a user-facing setting:
 *
 *   * there is one tool INSTANCE PER TOOL GROUP, so writing the configuration
 *     means walking every group and keeping them in step, and any group created
 *     later (a new viewport, a mode switch) silently starts on the old value;
 *   * tool configuration is rebuilt when tool groups are, so the radiologist's
 *     choice would not survive a layout change, let alone a reload.
 *
 * One module-level value with a subscription solves both: the tool reads it at
 * the moment it positions the camera, so every group is correct by
 * construction, and it is persisted so the preference outlives the session.
 */

const STORAGE_KEY = 'shealth.magnify.zoom';

/**
 * Below ~2x the loupe is not worth the screen it covers. Above ~10x there is
 * nothing left to see on the low-matrix series where magnification is most
 * often reached for: a 160x160 EPI at 10x is showing roughly one acquired pixel
 * per 20 screen pixels, which is the "blurry" complaint, not a rendering fault.
 */
export const MIN_MAGNIFY_ZOOM = 2;
export const MAX_MAGNIFY_ZOOM = 10;
export const MAGNIFY_ZOOM_STEP = 0.25;
export const DEFAULT_MAGNIFY_ZOOM = 5;

type Listener = (zoom: number) => void;

const listeners = new Set<Listener>();

export function clampMagnifyZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAGNIFY_ZOOM;
  }
  return Math.min(MAX_MAGNIFY_ZOOM, Math.max(MIN_MAGNIFY_ZOOM, value));
}

function readPersisted(): number {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return DEFAULT_MAGNIFY_ZOOM;
    }
    return clampMagnifyZoom(Number.parseFloat(raw));
  } catch {
    // Private-browsing or a blocked storage partition. A working magnifier that
    // forgets the setting beats a viewer that throws on boot.
    return DEFAULT_MAGNIFY_ZOOM;
  }
}

let current = readPersisted();

export function getMagnifyZoom(): number {
  return current;
}

export function setMagnifyZoom(value: number): number {
  const next = clampMagnifyZoom(value);
  if (next === current) {
    return current;
  }
  current = next;

  try {
    window.localStorage?.setItem(STORAGE_KEY, String(next));
  } catch {
    /* not persisting is survivable; not applying the change is not */
  }

  // A throwing listener must not stop the others from updating, or the loupe
  // and the slider can disagree about the current zoom.
  listeners.forEach(listener => {
    try {
      listener(next);
    } catch {
      /* ignore a broken subscriber */
    }
  });

  return next;
}

export function subscribeMagnifyZoom(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
