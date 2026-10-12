/**
 * Time-remaining estimate for the popup, kept here as a pure function over numbers so it can be
 * tested — the popup module itself touches the DOM on import and cannot run under Vitest.
 *
 * The estimate is the mean section time so far projected over the sections still expected. It is
 * deliberately conservative about when it speaks at all:
 *
 * - nothing before two sections have landed, because the first carries page preparation and
 *   lazy-content settling and a single sample consistently overestimates;
 * - nothing once the expected total stops exceeding what is done;
 * - nothing while the page is still growing, which is the case this was always meant to cover and
 *   did not. The guard above fires when the estimate has been *overshot*; on a page that appends as
 *   it is scrolled the estimate is never overshot, because it grows with the count. So the estimate
 *   was at its most confident exactly when it was most wrong, and it counted *up* -- "about 2 min
 *   left", then 3, then 4. Growth is now passed in rather than inferred from numbers that cannot
 *   show it.
 *
 * Returning an empty string means "say nothing", which is always better than counting down to a
 * wrong zero on a page that keeps growing.
 */
export function captureEtaLabel(
  current: number,
  estimatedTotal: number,
  elapsedMs: number,
  growingPage = false,
): string {
  if (growingPage) return ''
  if (current < 2 || estimatedTotal <= current || elapsedMs <= 0) return ''
  const remainingSeconds = Math.round(((elapsedMs / current) * (estimatedTotal - current)) / 1_000)
  if (remainingSeconds <= 0) return 'almost done'
  if (remainingSeconds < 60) return `about ${remainingSeconds}s left`
  return `about ${Math.round(remainingSeconds / 60)} min left`
}
