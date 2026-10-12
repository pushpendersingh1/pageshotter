/**
 * Region-select geometry, kept as pure functions over numbers so it can be unit-tested in plain Node
 * (there is no DOM in vitest, which is why every measurable part of capture lives behind exports
 * like these).
 *
 * A region is dragged on the *live page* but applied to the *captured image*, and the two do not
 * share an origin or a scale:
 *
 *  - the drag arrives in viewport CSS pixels, while the image is in device pixels at the capture
 *    scale (DPR × browser zoom), so coordinates need the scale measured from the segment rather
 *    than an assumed 1;
 *  - only the part of the viewport showing scrolled content is photographed, so the image's origin
 *    is the capture rect's top-left corner, not the window's.
 *
 * A drag may now scroll the page under itself, so a region is held in *document* CSS pixels. Two
 * things follow. A region that still fits on screen is served by the original single-screenshot path,
 * where the document offset cancels out and the mapping stays trivial. A region that does not is
 * captured as a band by the scroll loop, and the image origin is then the first segment's scroll
 * offset rather than the window's — which `regionToImageCrop` already expresses, as `captureY`.
 */

export interface SelectedRegion {
  /** Left edge in document CSS pixels. */
  x: number
  /** Top edge in document CSS pixels. */
  y: number
  width: number
  height: number
}

export interface ScrollOffset {
  x: number
  y: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionPoint {
  x: number
  y: number
}

/**
 * A drag smaller than this in CSS pixels is a stray click or a twitch, not a region anyone meant to
 * select. It matches `MIN_CROP_PX` on the result page: the two selections mean the same thing to a
 * user, so they must not disagree about what counts as deliberate.
 */
export const MIN_REGION_PX = 8

/**
 * Normalises a drag over the live page into a region, in viewport CSS pixels.
 *
 * Returns `undefined` for a drag too small to be deliberate, which is also what a plain click
 * produces. Callers treat that as "no region", not as an error.
 */
export function regionFromDrag(start: RegionPoint, end: RegionPoint): SelectedRegion | undefined {
  const left = Math.min(start.x, end.x)
  const right = Math.max(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const bottom = Math.max(start.y, end.y)

  const width = right - left
  const height = bottom - top
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return undefined

  return { x: left, y: top, width, height }
}

/**
 * Places a selected region onto the captured image, in image pixels.
 *
 * `captureX`/`captureY` are where the photographed rect sits inside the viewport, and the scales
 * convert CSS pixels to image pixels. The result is clamped to the image, so a region dragged over
 * a scrollbar gutter — or over viewport chrome that was cropped away — still exports the part that
 * was actually captured instead of failing.
 *
 * Returns `undefined` when the region lies entirely outside the captured rect, which is the honest
 * answer when there are no pixels to export.
 */
export function regionToImageCrop(
  region: SelectedRegion,
  scaleX: number,
  scaleY: number,
  captureX: number,
  captureY: number,
  imageWidth: number,
  imageHeight: number,
): PixelRect | undefined {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return undefined
  }
  if (imageWidth <= 0 || imageHeight <= 0) return undefined

  const left = clamp(Math.round((region.x - captureX) * scaleX), 0, imageWidth)
  const right = clamp(Math.round((region.x - captureX + region.width) * scaleX), 0, imageWidth)
  const top = clamp(Math.round((region.y - captureY) * scaleY), 0, imageHeight)
  const bottom = clamp(Math.round((region.y - captureY + region.height) * scaleY), 0, imageHeight)

  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return undefined

  return { x: left, y: top, width, height }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * How far to scroll per frame while the pointer is held past a viewport edge, in CSS pixels.
 *
 * Proportional to the overshoot rather than fixed: a fixed step is either too slow to pull a
 * selection down a long page or too fast to stop where you meant to. Capped so a pointer dragged far
 * off-screen cannot skip content faster than the box can be seen to move.
 */
export const REGION_SCROLL_MAX_STEP = 28

export function regionScrollStep(overshoot: number): number {
  if (!Number.isFinite(overshoot) || overshoot <= 0) return 0
  return Math.min(REGION_SCROLL_MAX_STEP, Math.max(2, Math.round(overshoot / 2)))
}

/**
 * Whether a document-space region lies entirely inside what is on screen right now.
 *
 * True is the fast path: one screenshot already contains every pixel of the region, so nothing is
 * scrolled and none of the scroll-loop machinery — overlay policy, background unpinning, lazy
 * settling, stitching — can affect the result. False means the region has to be captured as a band.
 */
export function regionFitsViewport(
  region: SelectedRegion,
  scroll: ScrollOffset,
  viewport: ViewportSize,
): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return false
  return (
    region.x >= scroll.x - 0.5 &&
    region.y >= scroll.y - 0.5 &&
    region.x + region.width <= scroll.x + viewport.width + 0.5 &&
    region.y + region.height <= scroll.y + viewport.height + 0.5
  )
}

/** Re-expresses a document-space region against the current scroll, for the single-screenshot path. */
export function regionToViewport(region: SelectedRegion, scroll: ScrollOffset): SelectedRegion {
  return { x: region.x - scroll.x, y: region.y - scroll.y, width: region.width, height: region.height }
}

/** The shape of a `DOMRect`, so element geometry can be tested without a DOM. */
export interface ViewportRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Converts an element's viewport rect into a document-space region.
 *
 * Rounded outward so a fractional layout — the normal case at non-integer zoom — never shaves a row
 * of the element's own border off its screenshot. Clamped at the document origin because an element
 * may start above or left of it (a negatively-offset banner, a transformed card), and the capture
 * loop has no pixels to offer from there.
 *
 * Returns `undefined` for anything smaller than a deliberate selection, which is the same threshold
 * a drag has to clear: a one-pixel spacer is a thing the pointer passes over, not a thing anyone
 * means to photograph.
 */
export function elementRectToRegion(rect: ViewportRect, scroll: ScrollOffset): SelectedRegion | undefined {
  const rawLeft = rect.left + scroll.x
  const rawTop = rect.top + scroll.y
  const left = Math.max(0, Math.floor(rawLeft))
  const top = Math.max(0, Math.floor(rawTop))
  const right = Math.ceil(rawLeft + rect.width)
  const bottom = Math.ceil(rawTop + rect.height)

  const width = right - left
  const height = bottom - top
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return undefined

  return { x: left, y: top, width, height }
}

/**
 * Whether two rects occupy the same place on screen, to within a pixel of rounding.
 *
 * This is the test that collapses a wrapper chain. A span filling its paragraph filling its div all
 * highlight identically, so the choice between them is invisible to the person hovering — and when
 * a choice is invisible the widest scope is the useful one, because it is the one whose siblings
 * are also enclosed. Anything that changes the highlight stops the walk, so this never silently
 * hands back a larger element than the one under the pointer.
 */
export function sameRect(a: ViewportRect, b: ViewportRect, tolerance = 1): boolean {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}
