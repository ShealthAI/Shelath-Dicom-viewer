/**
 * The store is what keeps the toolbar control and the magnifier agreeing about
 * zoom, and what carries the radiologist's choice across a reload. Both are
 * silent when broken - the loupe simply magnifies by the wrong amount - so they
 * are pinned here.
 */

describe('magnifyZoomStore', () => {
  const load = () => {
    let mod;
    jest.isolateModules(() => {
      mod = require('./magnifyZoomStore');
    });
    return mod;
  };

  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('starts at the default when nothing was saved', () => {
    const s = load();
    expect(s.getMagnifyZoom()).toBe(s.DEFAULT_MAGNIFY_ZOOM);
  });

  it('restores a saved preference on load', () => {
    window.localStorage.setItem('shealth.magnify.zoom', '3.5');
    expect(load().getMagnifyZoom()).toBe(3.5);
  });

  it('clamps a saved value that is out of range', () => {
    window.localStorage.setItem('shealth.magnify.zoom', '999');
    const s = load();
    expect(s.getMagnifyZoom()).toBe(s.MAX_MAGNIFY_ZOOM);
  });

  it('falls back to the default for unparseable storage', () => {
    window.localStorage.setItem('shealth.magnify.zoom', 'not-a-number');
    const s = load();
    expect(s.getMagnifyZoom()).toBe(s.DEFAULT_MAGNIFY_ZOOM);
  });

  it('clamps on write and reports what was actually applied', () => {
    const s = load();
    // The caller renders the return value, so a rejected request must not leave
    // the control showing a zoom the magnifier is not using.
    expect(s.setMagnifyZoom(0)).toBe(s.MIN_MAGNIFY_ZOOM);
    expect(s.setMagnifyZoom(50)).toBe(s.MAX_MAGNIFY_ZOOM);
    expect(s.setMagnifyZoom(Number.NaN)).toBe(s.DEFAULT_MAGNIFY_ZOOM);
  });

  it('persists a write', () => {
    const s = load();
    s.setMagnifyZoom(4);
    expect(window.localStorage.getItem('shealth.magnify.zoom')).toBe('4');
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    const s = load();
    const seen: number[] = [];
    const off = s.subscribeMagnifyZoom(v => seen.push(v));

    s.setMagnifyZoom(3);
    s.setMagnifyZoom(3); // no-op: same value must not re-notify
    off();
    s.setMagnifyZoom(6);

    expect(seen).toEqual([3]);
  });

  it('keeps notifying the rest when one subscriber throws', () => {
    // Otherwise a single broken consumer desynchronises the loupe from the UI.
    const s = load();
    const seen: number[] = [];
    s.subscribeMagnifyZoom(() => {
      throw new Error('boom');
    });
    s.subscribeMagnifyZoom(v => seen.push(v));

    s.setMagnifyZoom(7);
    expect(seen).toEqual([7]);
  });

  it('survives storage being unavailable', () => {
    // Private browsing / blocked storage partition: forgetting the preference
    // is acceptable, throwing on boot is not.
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    const s = load();
    expect(s.getMagnifyZoom()).toBe(s.DEFAULT_MAGNIFY_ZOOM);
    expect(() => s.setMagnifyZoom(4)).not.toThrow();
    expect(s.getMagnifyZoom()).toBe(4);
  });
});
