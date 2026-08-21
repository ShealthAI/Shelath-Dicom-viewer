import { log } from '@ohif/core';

/**
 * Capture the viewer's own load timings and hand them to the host application.
 *
 * WHY THIS EXISTS
 * OHIF already computes exactly the numbers we need - studyToFirstImage,
 * displaySetsToAllImages, scriptToView - but emits them with console.time /
 * console.timeEnd. That prints a duration and throws it away: there is no return
 * value and no event, so nothing can collect it.
 *
 * The result is that every performance claim about this viewer is an argument
 * rather than a measurement. "MPR feels slow", "the fix helped" - neither can be
 * settled, because the one system that knows how long anything took writes it to
 * a console nobody is reading.
 *
 * WHY WRAP RATHER THAN EDIT `log`
 * `platform/core/src/log.js` is upstream. Editing it would work and would be
 * carried as a conflict at every Cornerstone bump, for no benefit - `log` is a
 * plain object, so its methods can be wrapped from here and upstream stays
 * untouched.
 *
 * WHY postMessage RATHER THAN AN HTTP POST
 * The viewer runs in an iframe inside the workspace, on a different origin. A
 * direct POST would need its own endpoint, its own CORS allowance and its own
 * auth. The parent already exchanges messages with this iframe, so the timings
 * ride the channel that exists; the host decides what to do with them. If the
 * viewer is opened standalone there is no parent, and nothing happens.
 */

/** Message type the host listens for. Namespaced so it cannot collide. */
export const TELEMETRY_MESSAGE_TYPE = 'shealth:viewer-timing';

export interface LoadTiming {
  /** The timing key OHIF used, e.g. 'studyToFirstImage'. */
  key: string;
  /** Milliseconds. */
  duration: number;
  /** StudyInstanceUID from the URL, when present - so timings can be grouped. */
  studyInstanceUID?: string;
}

/** Prefix for the optional performance marks, so ours stand out in a profile. */
const MARK_PREFIX = 'shealth:timing:';

/**
 * Start times, keyed by timing name.
 *
 * A plain Map rather than the User Timing API. Marks were the first attempt and
 * are the wrong dependency: `performance.getEntriesByName` is only partially
 * implemented in some environments, the entry buffer is finite and silently
 * drops old marks during a long reading session, and it needs clearing to avoid
 * unbounded growth. A Map has none of those properties and is exact.
 *
 * `performance.mark` is still called, purely so these show up on a DevTools
 * performance timeline - but nothing depends on it succeeding.
 */
const startedAt = new Map<string, number>();

/**
 * Marker set on the functions this module installs.
 *
 * The guard lives on the WRAPPER, not in a module-level boolean, because those
 * two can disagree. A boolean says "I have installed"; the marker says "this
 * function is already mine" - and only the second survives a module reload, an
 * HMR cycle, or anything else that gives you a fresh module scope over an
 * already-wrapped `log`.
 *
 * Getting this wrong is quiet and expensive: wraps stack, every timing is
 * reported once per layer, and a dashboard shows load times that look fine
 * while the counts are multiples of the truth.
 */
const WRAPPED = '__shealthTelemetryWrapped';

type Wrappable = ((key: string) => void) & { [WRAPPED]?: boolean; __original?: unknown };

function alreadyWrapped(fn: unknown): boolean {
  return Boolean((fn as Wrappable)?.[WRAPPED]);
}

function currentStudyUID(): string | undefined {
  try {
    const value = new URLSearchParams(window.location.search).get('StudyInstanceUIDs');
    // Multiple UIDs are comma-separated; the first identifies the study being read.
    return value ? value.split(',')[0] : undefined;
  } catch {
    return undefined;
  }
}

function report(timing: LoadTiming): void {
  // Structured console line as well as the host message. Keeps the numbers
  // usable when someone is debugging with DevTools open and no host attached.
  // eslint-disable-next-line no-console
  console.info(`[shealth:timing] ${timing.key}=${Math.round(timing.duration)}ms`);

  try {
    // Only speak to a real parent. `window.parent === window` when standalone.
    if (window.parent && window.parent !== window) {
      // '*' rather than a pinned origin: the host is deployed on several
      // domains (prod, test, local) and this payload carries only durations and
      // a study UID the parent already knows - it opened the viewer with it.
      window.parent.postMessage({ type: TELEMETRY_MESSAGE_TYPE, timing }, '*');
    }
  } catch {
    /* a cross-origin parent that refuses messages must not break the viewer */
  }
}

/**
 * Wrap `log.time` / `log.timeEnd` so every timing OHIF already records is also
 * measured numerically and reported.
 *
 * Idempotent: installing twice would double-report, and React StrictMode calls
 * effects twice in development.
 */
export function installLoadTelemetry(): void {
  if (alreadyWrapped(log.time) || alreadyWrapped(log.timeEnd)) {
    return;
  }

  const originalTime = log.time?.bind(log);
  const originalTimeEnd = log.timeEnd?.bind(log);

  if (!originalTime || !originalTimeEnd) {
    // Upstream changed shape. Losing telemetry is acceptable; breaking the
    // viewer because a logging helper moved is not.
    return;
  }

  const wrappedTime: Wrappable = (key: string) => {
    startedAt.set(key, performance.now());
    try {
      // Profiler visibility only. Nothing reads this back.
      performance.mark?.(`${MARK_PREFIX}${key}`);
    } catch {
      /* mark budget exhausted, or the API is absent - irrelevant either way */
    }
    originalTime(key);
  };

  const wrappedTimeEnd: Wrappable = (key: string) => {
    // Read the flag BEFORE delegating: upstream clears it, and a timing that
    // was never started must not be reported as a zero-length one.
    const wasRunning = Boolean(log.timingKeys?.[key]);

    originalTimeEnd(key);

    if (!wasRunning) {
      return;
    }

    try {
      const start = startedAt.get(key);

      if (start === undefined) {
        // `scriptToView` is started by an inline script in index.html, long
        // before this module exists, so there is no start time to subtract. It
        // is the most useful number of the set - script start to a visible
        // image - so it falls back to the navigation clock, which is the same
        // origin that inline script measured from.
        if (key === 'scriptToView') {
          report({ key, duration: performance.now(), studyInstanceUID: currentStudyUID() });
        }
        return;
      }

      startedAt.delete(key);
      report({
        key,
        duration: performance.now() - start,
        studyInstanceUID: currentStudyUID(),
      });
    } catch {
      /* telemetry must never surface to a radiologist */
    }
  };

  wrappedTime[WRAPPED] = true;
  wrappedTimeEnd[WRAPPED] = true;
  // Kept so the test seam can put `log` back exactly as it found it.
  wrappedTime.__original = originalTime;
  wrappedTimeEnd.__original = originalTimeEnd;

  log.time = wrappedTime;
  log.timeEnd = wrappedTimeEnd;
}

/**
 * Test seam — unwrap, so a suite starts from a genuinely clean `log`.
 *
 * Restores the captured originals rather than just clearing a flag. Clearing a
 * flag while leaving the wrapper installed is exactly the disagreement the
 * marker above exists to prevent, and it is how the stacking bug was found.
 */
export function _resetLoadTelemetry(): void {
  const time = log.time as Wrappable;
  const timeEnd = log.timeEnd as Wrappable;

  if (alreadyWrapped(time) && time.__original) {
    log.time = time.__original as typeof log.time;
  }
  if (alreadyWrapped(timeEnd) && timeEnd.__original) {
    log.timeEnd = timeEnd.__original as typeof log.timeEnd;
  }
  startedAt.clear();
}
