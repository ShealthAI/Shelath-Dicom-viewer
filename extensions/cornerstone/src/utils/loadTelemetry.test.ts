/**
 * This wraps a timing helper that runs on every study open. The failures worth
 * guarding are not "the number is wrong" — a slightly-off millisecond count
 * costs nothing — but "the wrap broke the viewer", "the numbers are fabricated",
 * and "the wrap captured nothing at all".
 *
 * The third one is not hypothetical. The first version of this module wrapped
 * `log.time` imported from '@ohif/core'. Every test below passed, because the
 * suite imported the same module instance the module under test did. In the
 * real multi-bundle build it does not: '@ohif/core' is instantiated more than
 * once, so the wrap landed on a copy nobody called. It shipped to production
 * and captured zero timings, silently.
 *
 * Hence the final block: the wrap now targets `console`, and that block drives
 * it the way OHIF actually does — through a separate `log` object this module
 * has never seen — so "wrapped the wrong object" fails here instead of in
 * production.
 */

import {
  TELEMETRY_MESSAGE_TYPE,
  _resetLoadTelemetry,
  installLoadTelemetry,
} from './loadTelemetry';

describe('loadTelemetry', () => {
  let posted: unknown[];
  let originalParent: Window;

  beforeEach(() => {
    _resetLoadTelemetry();
    posted = [];

    originalParent = window.parent;
    // jsdom makes window.parent === window, which the module reads as
    // "standalone". Give it a distinct parent so the post path is exercised.
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: unknown) => posted.push(msg) },
    });

    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    // Silence the real timer output, and give the wrap a known original to
    // delegate to. Spying BEFORE install matters: install captures whatever is
    // on console at that moment.
    jest.spyOn(console, 'time').mockImplementation(() => undefined);
    jest.spyOn(console, 'timeEnd').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Unwrap before restoring the spies, or the wrapper outlives the spy it
    // captured and leaks into the next test file.
    _resetLoadTelemetry();
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    jest.restoreAllMocks();
  });

  it('reports a duration for a timing that ran', () => {
    installLoadTelemetry();

    console.time('studyToFirstImage');
    console.timeEnd('studyToFirstImage');

    expect(posted).toHaveLength(1);
    const msg = posted[0] as { type: string; timing: { key: string; duration: number } };
    expect(msg.type).toBe(TELEMETRY_MESSAGE_TYPE);
    expect(msg.timing.key).toBe('studyToFirstImage');
    expect(typeof msg.timing.duration).toBe('number');
    expect(msg.timing.duration).toBeGreaterThanOrEqual(0);
  });

  it('does NOT report a timing that was never started', () => {
    // The failure this prevents: a stream of zero-length timings that look like
    // instant loads and quietly poison whatever dashboard consumes them.
    installLoadTelemetry();

    console.timeEnd('neverStarted');

    expect(posted).toHaveLength(0);
  });

  it('still delegates to the original console implementation', () => {
    // The wrap must not swallow console timing — it has to keep working for
    // anyone debugging with DevTools open.
    const time = console.time as jest.Mock;
    const timeEnd = console.timeEnd as jest.Mock;
    installLoadTelemetry();

    console.time('displaySetsToAllImages');
    console.timeEnd('displaySetsToAllImages');

    expect(time).toHaveBeenCalledWith('displaySetsToAllImages');
    expect(timeEnd).toHaveBeenCalledWith('displaySetsToAllImages');
  });

  it('is idempotent — installing twice does not double-report', () => {
    // React StrictMode runs effects twice in development; without the guard
    // every timing would be sent two or four times.
    installLoadTelemetry();
    installLoadTelemetry();

    console.time('displaySetsToAllImages');
    console.timeEnd('displaySetsToAllImages');

    expect(posted).toHaveLength(1);
  });

  it('does not report the same timing twice after a single start', () => {
    // A double timeEnd would otherwise emit a second, meaningless duration
    // measured from a start that was already consumed.
    installLoadTelemetry();

    console.time('studyToFirstImage');
    console.timeEnd('studyToFirstImage');
    console.timeEnd('studyToFirstImage');

    expect(posted).toHaveLength(1);
  });

  it('survives a parent that refuses messages', () => {
    // A cross-origin parent can throw on postMessage. Telemetry failing must
    // never surface to a radiologist mid-read.
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {
        postMessage: () => {
          throw new Error('blocked by the browser');
        },
      },
    });
    installLoadTelemetry();

    expect(() => {
      console.time('studyToFirstImage');
      console.timeEnd('studyToFirstImage');
    }).not.toThrow();
  });

  it('survives being opened standalone, with no parent', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window });
    installLoadTelemetry();

    expect(() => {
      console.time('studyToFirstImage');
      console.timeEnd('studyToFirstImage');
    }).not.toThrow();
    expect(posted).toHaveLength(0);
  });

  it('reports scriptToView even though its start predates this module', () => {
    // scriptToView is started by an inline script in index.html, long before
    // any bundle loads, so there is no start time to subtract. It is the single
    // most useful number of the set — time from script start to a visible image
    // — so it falls back to the navigation clock rather than being dropped.
    installLoadTelemetry();

    console.timeEnd('scriptToView');

    expect(posted).toHaveLength(1);
    const msg = posted[0] as { timing: { key: string; duration: number } };
    expect(msg.timing.key).toBe('scriptToView');
    expect(msg.timing.duration).toBeGreaterThan(0);
  });

  it('tolerates console timing being absent', () => {
    // Losing telemetry is acceptable; throwing during viewer startup is not.
    _resetLoadTelemetry();
    const saved = { time: console.time, timeEnd: console.timeEnd };
    (console as Record<string, unknown>).time = undefined;
    (console as Record<string, unknown>).timeEnd = undefined;

    expect(() => installLoadTelemetry()).not.toThrow();

    Object.assign(console, saved);
  });

  describe('driven the way OHIF drives it', () => {
    /**
     * A stand-in for the `log` in platform/core/src/log.js. The module under
     * test holds no reference to this object — which is the whole point. If
     * someone reverts to wrapping an imported `log`, every other test in this
     * file still passes and this one fails.
     */
    const makeLog = () => {
      const log = {
        timingKeys: { scriptToView: true } as Record<string, boolean>,
        time: (key: string) => {
          log.timingKeys[key] = true;
          console.time(key);
        },
        timeEnd: (key: string) => {
          if (!log.timingKeys[key]) {
            return;
          }
          log.timingKeys[key] = false;
          console.timeEnd(key);
        },
      };
      return log;
    };

    it('captures timings routed through a log object it never imported', () => {
      installLoadTelemetry();
      const log = makeLog();

      log.time('displaySetsToAllImages');
      log.timeEnd('displaySetsToAllImages');

      expect(posted).toHaveLength(1);
      const msg = posted[0] as { timing: { key: string } };
      expect(msg.timing.key).toBe('displaySetsToAllImages');
    });

    it('respects the suppression upstream applies', () => {
      // log.timeEnd returns early when the key was never started, so nothing
      // reaches console — and nothing should be reported.
      installLoadTelemetry();
      const log = makeLog();

      log.timeEnd('neverStarted');

      expect(posted).toHaveLength(0);
    });
  });
});
