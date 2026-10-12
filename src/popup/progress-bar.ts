/**
 * How the section bar is drawn when there are more sections than the popup has room for.
 *
 * The bar used to draw one segment per section. That is honest and legible up to a few dozen, and
 * then it fails twice over: at 124 sections in a 360px popup every segment measured **0px wide**, so
 * the bar was nothing but its own gaps -- and because flex gaps do not shrink, those 123 gaps became
 * the row's automatic minimum size and widened the popup window itself to 423px.
 *
 * So past the cap a segment stands for a bucket of sections rather than for one. The bar stops being
 * countable and becomes a proportion, which is all a reader could take from 124 tick marks anyway.
 */

/**
 * Chosen from the space the bar actually has: ~292px of panel interior, and a segment needs about
 * 3px of its own beside a 3px gap before it reads as a mark rather than as noise. Forty leaves each
 * segment ~4px wide, which is still a mark.
 */
export const MAX_SEGMENTS = 40

/** How many segments to draw for a capture of `total` sections. */
export function segmentCount(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(Math.floor(total), MAX_SEGMENTS)
}

/**
 * How many of those segments are filled at `current` sections taken.
 *
 * Rounds up, so the first section lights the first segment rather than leaving a bar that has
 * visibly not started while sections are visibly being taken; and clamps, so a capture that runs
 * past its own estimate -- which a growing page does -- cannot ask for a segment that is not there.
 */
export function filledSegments(current: number, total: number, segments: number): number {
  if (segments <= 0 || !Number.isFinite(current) || current <= 0) return 0
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(segments, Math.max(1, Math.ceil((current / total) * segments)))
}
