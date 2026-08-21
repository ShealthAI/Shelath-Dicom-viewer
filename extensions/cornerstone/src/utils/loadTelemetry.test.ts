/**
 * This wraps a logging helper that runs on every study open. The failures worth
 * guarding are not "the number is wrong" — a slightly-off millisecond count
 * costs nothing — but "the wrap broke the viewer" and "the numbers are
 * fabricated". A telemetry module that throws, or that reports timings for
 * things that never ran, is worse than no telemetry at all.
 */

jest.mock('@ohif/core', () => {
  const log = {
    timingKeys: {} as Record<string, boolean>,
    time(key: string) {
      log.timingKeys[key] = true;
    },
    timeEnd(key: string) {
      log.timingKeys[key] = false;
    },
  };
  return { log };
});

import { log } from '@ohif/core';
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
    (log as { timingKeys: Record<string, boolean> }).timingKeys = {};
    posted = [];

    originalParent = window.parent;
    // jsdom makes window.parent === window, which the module reads as
    // "standalone". Give it a distinct parent so the post path is exercised.
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: unknown) => posted.push(msg) },
    });

    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    performance.clearMarks?.();
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    jest.restoreAllMocks();
  });

  it('reports a duration for a timing that ran', () => {
    installLoadTelemetry();

    log.time('studyToFirstImage');
    log.timeEnd('studyToFirstImage');

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

    log.timeEnd('neverStarted');

    expect(posted).toHaveLength(0);
  });

  it('still delegates to the original log implementation', () => {
    // The wrap must not swallow upstream behaviour — console timing has to keep
    // working for anyone debugging with DevTools open.
    installLoadTelemetry();

    log.time('displaySetsToAllImages');
    expect(log.timingKeys['displaySetsToAllImages']).toBe(true);

    log.timeEnd('displaySetsToAllImages');
    expect(log.timingKeys['displaySetsToAllImages']).toBe(false);
  });

  it('is idempotent — installing twice does not double-report', () => {
    // React StrictMode runs effects twice in development; without the guard
    // every timing would be sent two or four times.
    installLoadTelemetry();
    installLoadTelemetry();

    log.time('scriptToView');
    log.timeEnd('scriptToView');

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
      log.time('studyToFirstImage');
      log.timeEnd('studyToFirstImage');
    }).not.toThrow();
  });

  it('survives being opened standalone, with no parent', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window });
    installLoadTelemetry();

    expect(() => {
      log.time('studyToFirstImage');
      log.timeEnd('studyToFirstImage');
    }).not.toThrow();
    expect(posted).toHaveLength(0);
  });

  it('reports scriptToView even though its mark predates this module', () => {
    // scriptToView is started by an inline script in index.html, long before
    // any bundle loads, so there is no mark to measure against. It is the single
    // most useful number of the set — time from script start to a visible image
    // — so it falls back to the navigation clock rather than being dropped.
    installLoadTelemetry();

    (log as { timingKeys: Record<string, boolean> }).timingKeys['scriptToView'] = true;
    log.timeEnd('scriptToView');

    expect(posted).toHaveLength(1);
    const msg = posted[0] as { timing: { key: string; duration: number } };
    expect(msg.timing.key).toBe('scriptToView');
    expect(msg.timing.duration).toBeGreaterThan(0);
  });

  it('tolerates upstream changing shape', () => {
    // If log.time / log.timeEnd ever move, losing telemetry is acceptable;
    // throwing during viewer startup is not.
    _resetLoadTelemetry();
    const saved = { time: log.time, timeEnd: log.timeEnd };
    (log as Record<string, unknown>).time = undefined;
    (log as Record<string, unknown>).timeEnd = undefined;

    expect(() => installLoadTelemetry()).not.toThrow();

    Object.assign(log, saved);
  });
});
