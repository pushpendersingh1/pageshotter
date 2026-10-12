/**
 * Pure geometry for one scroll step, shared by the content script and its tests.
 *
 * `offset` is the content offset of the pixel at the top of the capture rect and `contentHeight`
 * is the content height that scrolling can actually expose, so the capture loop and the stitcher
 * use identical math whether the document or a nested container is being scrolled.
 */
export interface ScrollGeometry {
  offset: number
  offsetX: number
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
  contentHeight: number
  contentWidth: number
  /** CSS pixels of the scroller clipped above the viewport; always 0 when the document scrolls. */
  clippedTop: number
}

/** Measurements of a scrollable element's padding box, relative to the viewport. */
export interface ContainerBox {
  paddingLeft: number
  paddingTop: number
  clientWidth: number
  clientHeight: number
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  scrollHeight: number
  viewportWidth: number
  viewportHeight: number
}

/**
 * Capture hides scrollbars for the duration of the job, which normally gives the document the full
 * viewport. Some pages still reserve the gutter (`scrollbar-gutter: stable`, or a page rule that
 * outranks ours), so any residual gutter is cropped out instead — otherwise the scrollbar column is
 * stamped down the edge of every segment.
 */
export function documentCaptureGeometry(
  scrollX: number,
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
  documentWidth: number,
  documentHeight: number,
  scrollbarWidth = 0,
  scrollbarHeight = 0,
): ScrollGeometry {
  return {
    offset: scrollY,
    offsetX: scrollX,
    captureX: 0,
    captureY: 0,
    captureWidth: Math.max(0, viewportWidth - Math.max(0, scrollbarWidth)),
    captureHeight: Math.max(0, viewportHeight - Math.max(0, scrollbarHeight)),
    contentHeight: documentHeight,
    contentWidth: documentWidth,
    clippedTop: 0,
  }
}

export function containerCaptureGeometry(box: ContainerBox): ScrollGeometry {
  const visibleLeft = Math.max(0, box.paddingLeft)
  const visibleTop = Math.max(0, box.paddingTop)
  const visibleRight = Math.min(box.viewportWidth, box.paddingLeft + box.clientWidth)
  const visibleBottom = Math.min(box.viewportHeight, box.paddingTop + box.clientHeight)
  const captureWidth = Math.max(0, visibleRight - visibleLeft)
  const captureHeight = Math.max(0, visibleBottom - visibleTop)
  const clippedTop = visibleTop - box.paddingTop
  const maxScrollTop = Math.max(0, box.scrollHeight - box.clientHeight)

  return {
    offset: box.scrollTop + clippedTop,
    offsetX: box.scrollLeft,
    captureX: visibleLeft,
    captureY: visibleTop,
    captureWidth,
    captureHeight,
    // Content below the container's on-screen area can never be shown, so the reachable height is
    // what the last scroll position exposes rather than the raw scrollHeight.
    contentHeight: Math.min(box.scrollHeight, maxScrollTop + clippedTop + captureHeight),
    contentWidth: box.scrollWidth,
    clippedTop,
  }
}

/**
 * Where a viewport-anchored overlay belongs in a stitched screenshot.
 *
 * - `top`   — a header-style bar: it is drawn in the first segment and suppressed afterwards, so it
 *             appears exactly once, at the top, where a reader expects it.
 * - `other` — a bottom bar, floating button or fixed rail: it tracks the viewport, so wherever it is
 *             drawn it covers real content. It is suppressed for the whole capture.
 * - `shell` — an element as large as the capture area: this is the page or app shell itself, never
 *             an overlay, and hiding it would blank the screenshot.
 */
export type OverlayAnchor = 'top' | 'other' | 'shell'

export interface OverlayRect {
  top: number
  bottom: number
  width: number
  height: number
}

export interface CaptureRect {
  captureY: number
  captureWidth: number
  captureHeight: number
}

export const OVERLAY_ANCHOR_TOLERANCE_PX = 6
const SHELL_COVERAGE_RATIO = 0.9
/**
 * A fixed rail is top-anchored just like a header, so height is what separates them: a rail runs
 * the length of the viewport, a header — however tall — does not. An earlier version cut at half
 * the viewport, which quietly suppressed any header taller than that for the entire capture.
 */
const RAIL_COVERAGE_RATIO = 0.85

export function classifyOverlay(rect: OverlayRect, capture: CaptureRect): OverlayAnchor {
  if (
    rect.width >= capture.captureWidth * SHELL_COVERAGE_RATIO &&
    rect.height >= capture.captureHeight * SHELL_COVERAGE_RATIO
  ) {
    return 'shell'
  }

  const anchoredToTop = rect.top <= capture.captureY + OVERLAY_ANCHOR_TOLERANCE_PX
  const spansCapture = rect.height >= capture.captureHeight * RAIL_COVERAGE_RATIO
  return anchoredToTop && !spansCapture ? 'top' : 'other'
}

/**
 * Whether an overlay is suppressed in the segment the capture is about to take.
 *
 * `top` overlays belong to the top of the finished image, and the top strip of the document is
 * photographed exactly once -- by the segment that starts at offset 0. A top-anchored element
 * discovered later -- Google Search's header is static at the top of the page and only becomes
 * fixed once the user scrolls -- has already been photographed in flow, so showing it again would
 * stamp a second copy right below a seam. It is suppressed for every segment after the first,
 * whether or not it was ever seen, a deliberate trade: everything fixed is
 * hidden after the first segment. `seen` keeps the older rule intact for overlays present at
 * offset 0: once drawn there, they are not drawn again.
 */
export function overlayHiddenInSegment(anchor: OverlayAnchor, seen: boolean, offset: number): boolean {
  if (anchor === 'other') return true
  return seen || offset > OVERLAY_ANCHOR_TOLERANCE_PX
}

/**
 * Whether a viewport rect overlaps the area being photographed.
 *
 * Used to decide whether an element that is not part of the scrolled container is nonetheless
 * painted over it. Touching edges do not count as overlap: a header that ends exactly where the
 * capture rect begins is beside the capture, not on it.
 */
export function overlapsCaptureRect(
  rect: { top: number; bottom: number; left: number; right: number },
  capture: {
    captureX: number
    captureY: number
    captureWidth: number
    captureHeight: number
  },
): boolean {
  const right = capture.captureX + capture.captureWidth
  const bottom = capture.captureY + capture.captureHeight
  return (
    rect.right > capture.captureX &&
    rect.left < right &&
    rect.bottom > capture.captureY &&
    rect.top < bottom
  )
}

/** Converts a target content offset back into the container's own `scrollTop`. */
export function containerScrollTopFor(offset: number, clippedTop: number): number {
  return Math.max(0, offset - clippedTop)
}

/** How far the settled offset may sit from the requested one before it counts as drift. */
export const SCROLL_DRIFT_TOLERANCE_PX = 1

/**
 * How many times a segment will re-assert its scroll position before giving up on it.
 *
 * This is what separates a person from a page. Someone nudging the wheel moves the scroller once,
 * so scrolling back lands where it was asked to; a page that fights -- CSS scroll snapping, a
 * scrolljacking library -- lands somewhere else again on every attempt. Four is enough to ride out
 * several flicks of a wheel and few enough that a page genuinely refusing to hold position still
 * reports it rather than looping.
 */
export const SCROLL_REASSERT_ATTEMPTS = 4

/**
 * Whether a segment is positioned where it was asked to be, or should be scrolled back and settled
 * again.
 *
 * Landing short of the target at the very bottom is not drift: the page is simply shorter than the
 * plan expected, which happens whenever content collapses during the capture. Retrying there would
 * burn every attempt on a position that is already correct.
 */
export function scrollSettleOutcome(
  requestedOffset: number,
  settledOffset: number,
  contentHeight: number,
  captureHeight: number,
  tolerance = SCROLL_DRIFT_TOLERANCE_PX,
): 'settled' | 'drifted' {
  if (Math.abs(settledOffset - requestedOffset) <= tolerance) return 'settled'
  const maxOffset = Math.max(0, contentHeight - captureHeight)
  if (requestedOffset >= maxOffset && Math.abs(settledOffset - maxOffset) <= tolerance) {
    return 'settled'
  }
  return 'drifted'
}
