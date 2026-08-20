/**
 * No tours.
 *
 * Second line of defence: the <Onboarding> render site is already gone from
 * ViewerLayout, so nothing consumes this. It is emptied as well so that
 * re-adding the component - or any other consumer of `ohif.tours` - cannot
 * quietly bring the step-through popover back over a study being read.
 *
 * The upstream tour definitions were deleted rather than commented out; they
 * are in git history if a guided tour is ever wanted deliberately.
 */
export default {
  'ohif.tours': [],
};
