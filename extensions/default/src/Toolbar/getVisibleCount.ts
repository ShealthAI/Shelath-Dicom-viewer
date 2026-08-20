/**
 * How many toolbar buttons to show when the row is too narrow for all of them.
 *
 * Kept apart from the component deliberately. This is the whole of the overflow
 * decision and it is the kind of arithmetic that is wrong by exactly one and
 * still looks plausible on screen, so it needs to be testable without dragging
 * React and the whole component library into the test.
 *
 * Returns how many of `widths` fit in `available`, reserving room for the
 * overflow trigger whenever anything has to be hidden. Buttons are dropped from
 * the END of the row, so the tool order a radiologist has learned never
 * reshuffles - tools only ever move into or out of the menu.
 */
export function getVisibleCount(
  widths: number[],
  available: number,
  gap: number,
  overflowWidth: number
): number {
  if (!widths.length || available <= 0) {
    // available <= 0 is the first layout pass, before anything has been
    // measured. Hiding buttons then would be guessing, and showing them all is
    // what produces the measurements.
    return widths.length;
  }

  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
  if (totalWidth <= available) {
    // Everything fits, so there is no trigger and it must not be charged for.
    return widths.length;
  }

  const budget = available - overflowWidth - gap;
  let used = 0;
  let count = 0;

  for (const width of widths) {
    const cost = count === 0 ? width : width + gap;
    if (used + cost > budget) {
      break;
    }
    used += cost;
    count += 1;
  }

  // May legitimately be 0: if not even one button fits beside the trigger, the
  // trigger alone is still shown, because every tool reachable through a menu
  // beats a row that renders nothing.
  return count;
}

export default getVisibleCount;
