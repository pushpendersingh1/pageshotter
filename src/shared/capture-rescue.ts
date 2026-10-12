/**
 * Two things a page does that a full-page screenshot photographs wrongly, and the rules for fixing
 * them.
 *
 * Both fixes are mutations to a live page, which the content script owns; what lives here is only
 * the decision -- whether an element qualifies, and what value to give it -- expressed over plain
 * numbers so it can be tested in a suite with no DOM. The predicates are deliberately conservative:
 * a rescue that fires on the wrong element changes what the user sees into something they did not
 * see, which is a worse defect than the one being fixed.
 */

/** A rectangle in viewport coordinates, which is what `getBoundingClientRect` returns. */
export interface RescueBox {
  left: number
  top: number
  right: number
  bottom: number
}

/*
 * Scroll-reveal animations start their subject at `opacity: 0` and raise it when the element enters
 * the viewport. A screenshot scrolls faster than any such animation completes -- and on a page that
 * never fires the observer at all, because the capture moves the scroller rather than the user,
 * whole paragraphs are photographed as blank bands. Forcing those back to full opacity is the
 * single highest-value correction available on the modern web.
 */

/** Above this the element is at least faintly visible, and its opacity is a design choice. */
export const REVEAL_OPACITY_CEILING = 0.05

/**
 * Below this an invisible element is not a hidden paragraph. Rescuing every tiny transparent node
 * on a page reveals tooltips, screen-reader affordances and animation scaffolding, none of which
 * the page was going to show.
 */
export const MIN_REVEAL_AREA_PX = 2_500

/**
 * A ceiling on how much of a page one capture will rewrite. A page needing more than this is not
 * using a reveal animation, it is using opacity as a layout system, and forcing three hundred more
 * elements visible would produce a picture of something that never existed.
 */
export const MAX_TEXT_REVEALS = 300

export interface RevealCandidate {
  opacity: number
  visibility: string
  display: string
  position: string
  width: number
  height: number
  /** Whether the element contains non-whitespace text. Only text is worth this risk. */
  hasText: boolean
}

export function isRevealCandidate(candidate: RevealCandidate): boolean {
  const { opacity, visibility, display, position, width, height, hasText } = candidate
  if (!hasText) return false
  if (!Number.isFinite(opacity) || opacity > REVEAL_OPACITY_CEILING) return false
  if (visibility === 'hidden' || visibility === 'collapse' || display === 'none') return false
  /*
   * Fixed and absolute elements are skipped for two separate reasons. A fixed one is an overlay,
   * which this session already classifies and positions deliberately -- reviving it here would
   * fight that policy and stamp a hidden dialog into every segment. An absolute one is typically
   * the inactive half of a stack: a closed accordion panel, an unselected tab, a carousel slide
   * waiting its turn.
   */
  if (position === 'fixed' || position === 'absolute') return false
  return width * height >= MIN_REVEAL_AREA_PX
}

export function overlapArea(a: RescueBox, b: RescueBox): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  return width * height
}

/**
 * Whether a visible sibling sits over most of this element -- the signature of a deliberate swap
 * rather than an unfinished animation.
 *
 * A tab panel, a carousel slide and a cross-fade all leave the outgoing copy at `opacity: 0`
 * underneath the incoming one. Reviving it stacks two sets of words in the same place, which is a
 * far more obvious defect than the blank band this rescue exists to fix, so the tie goes to leaving
 * the page alone.
 */
export function isCoveredBySibling(box: RescueBox, siblings: readonly RescueBox[]): boolean {
  const area = (box.right - box.left) * (box.bottom - box.top)
  if (area <= 0) return false
  return siblings.some((sibling) => overlapArea(box, sibling) / area > 0.6)
}

/*
 * A <video> below the fold has usually loaded nothing at all, so it photographs as an empty black
 * box where the page would have shown a frame. Assigning a non-zero `currentTime` forces the
 * browser to fetch and decode, which paints one.
 */

/**
 * How far into the video to seek.
 *
 * Near the start, because the honest answer to "what does this page look like" is the frame the
 * page itself would have shown, and that is the first one. It cannot be zero: the video is already
 * at zero, so assigning zero is not a seek and decodes nothing.
 */
export function videoSeekTarget(duration: number): number {
  return Math.min(0.1, duration / 2)
}

export interface VideoCandidate {
  /** The element's top edge in viewport coordinates, at the moment capture begins. */
  top: number
  viewportHeight: number
  loop: boolean
  /** `NaN` until metadata loads, which for `preload="none"` is never. */
  duration: number
  /** A poster is already a frame, and it is the frame the page chose. */
  hasPoster: boolean
  /** `HTMLMediaElement.readyState`; 2 (HAVE_CURRENT_DATA) or more means a frame already exists. */
  readyState: number
}

/**
 * What, if anything, to do about one video.
 *
 * Two steps rather than one because of `preload="none"`, which is exactly what a page puts on a
 * video below the fold -- the whole population this rescue is for. Such an element has no metadata
 * at all, so its `duration` is `NaN` and there is nothing to seek *to* yet. Loading metadata first
 * is what makes the seek possible; a rule that simply required a finite duration would decline to
 * act on almost every video it was written for.
 */
export type VideoRescueStep = 'skip' | 'load-metadata' | 'seek'

export function videoRescueStep(candidate: VideoCandidate): VideoRescueStep {
  const { top, viewportHeight, loop, duration, hasPoster, readyState } = candidate
  /*
   * Only videos below the first viewport. One already on screen is showing the user something, and
   * a screenshot that seeks it would differ from the page in front of them -- the exact failure
   * this whole function is meant to prevent.
   */
  if (top <= viewportHeight) return 'skip'
  if (hasPoster || loop) return 'skip'
  if (readyState >= 2) return 'skip'
  if (Number.isFinite(duration)) return duration > 0 ? 'seek' : 'skip'
  // Infinity is a live stream: it has metadata, and there is no frame to seek to.
  if (duration === Number.POSITIVE_INFINITY) return 'skip'
  return 'load-metadata'
}
