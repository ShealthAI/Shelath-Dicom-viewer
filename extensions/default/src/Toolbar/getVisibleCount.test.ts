import { getVisibleCount } from './getVisibleCount';

/**
 * This is the whole of the overflow decision, and it is the kind of arithmetic
 * that is wrong by exactly one and looks right on screen. The failure it exists
 * to prevent is the original bug: tools silently vanishing off the end of the
 * row with nothing to say they are still reachable.
 */

const GAP = 4;
const OVERFLOW = 40;

describe('getVisibleCount', () => {
  it('shows everything when it all fits', () => {
    // 5 x 40 + 4 gaps x 4 = 216
    expect(getVisibleCount([40, 40, 40, 40, 40], 216, GAP, OVERFLOW)).toBe(5);
  });

  it('shows everything when it fits exactly, without reserving for a menu', () => {
    // No overflow means no trigger, so the trigger must not be charged for.
    expect(getVisibleCount([40, 40, 40], 128, GAP, OVERFLOW)).toBe(3);
  });

  it('reserves room for the trigger as soon as one button has to go', () => {
    // 127px: one pixel short of all three. Budget becomes 127 - 40 - 4 = 83,
    // which holds two buttons (40 + 4 + 40 = 84 > 83 -> only one fits).
    expect(getVisibleCount([40, 40, 40], 127, GAP, OVERFLOW)).toBe(1);
  });

  it('never shows a button it cannot fully fit', () => {
    const widths = [40, 40, 40, 40];
    const count = getVisibleCount(widths, 150, GAP, OVERFLOW);
    const used = widths.slice(0, count).reduce((a, b) => a + b, 0) + GAP * Math.max(0, count - 1);
    expect(used).toBeLessThanOrEqual(150 - OVERFLOW - GAP);
  });

  it('returns zero rather than a partial button when nothing fits beside the trigger', () => {
    // The caller still renders the trigger, so every tool stays reachable.
    expect(getVisibleCount([40, 40], 50, GAP, OVERFLOW)).toBe(0);
  });

  it('handles buttons of differing widths', () => {
    // A layout selector or menu button is wider than a plain icon button.
    expect(getVisibleCount([40, 90, 40, 40], 200, GAP, OVERFLOW)).toBe(2);
  });

  it('shows everything when the width is not known yet', () => {
    // First layout pass: measuring has not happened, so hiding anything would
    // be guessing. Showing all is what produces the measurements.
    expect(getVisibleCount([40, 40, 40], 0, GAP, OVERFLOW)).toBe(3);
    expect(getVisibleCount([40, 40, 40], -1, GAP, OVERFLOW)).toBe(3);
  });

  it('handles an empty toolbar', () => {
    expect(getVisibleCount([], 500, GAP, OVERFLOW)).toBe(0);
  });

  it('is monotonic: more width never shows fewer buttons', () => {
    // Guards against an off-by-one that would make a tool flicker in and out
    // while a panel divider is dragged.
    const widths = [40, 40, 56, 40, 40, 40, 72, 40];
    let previous = 0;
    for (let available = 0; available <= 600; available += 1) {
      const count = getVisibleCount(widths, available, GAP, OVERFLOW);
      // available === 0 is the "not measured yet" case and legitimately shows
      // all of them, so start comparing once there is a real width.
      if (available > 0) {
        expect(count).toBeGreaterThanOrEqual(previous);
        previous = count;
      }
    }
    expect(previous).toBe(widths.length);
  });
});
