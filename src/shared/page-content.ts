/**
 * Text and links harvested from the live page, for the PDF's searchable and clickable layers.
 *
 * Everything here is in **document CSS pixels**, the same space a selected region uses, because that
 * is the only space in which the page can describe itself — the capture scale is not known to the
 * content script, and the image does not exist yet when this is measured.
 */

export interface ContentRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CapturedLink {
  href: string
  /** One rect per line: a link wrapping across two lines is two boxes, not one tall one. */
  rects: ContentRect[]
}

export interface CapturedTextRun extends ContentRect {
  text: string
}

export interface PageContent {
  links: CapturedLink[]
  runs: CapturedTextRun[]
}

/**
 * Caps, so a pathological page cannot turn a screenshot into a hundred-megabyte PDF or stall the
 * content script walking a million nodes. Both are far above any real page: a dense documentation
 * site runs to a few thousand text runs and a few hundred links.
 */
export const MAX_CAPTURED_LINKS = 2_000
/**
 * Runs are words, not lines, so this is a word budget: a long documentation page runs to a few
 * thousand, a book-length one to tens of thousands. Reaching the cap truncates the searchable layer
 * from the bottom of the page rather than dropping it, which is the failure worth having.
 */
export const MAX_CAPTURED_RUNS = 50_000

/** Anything smaller than this in CSS pixels is a spacer or a rounding artefact, not content. */
export const MIN_CONTENT_PX = 2

/**
 * Where a viewport point lands in the stitched image, in CSS pixels.
 *
 * This is the invariant the whole PDF text layer rests on, and it was wrong for every page whose
 * content lives in a nested scroller. Harvesting used `window.scrollY`, which on such a page is
 * simply 0 -- the document does not scroll, the container does -- so every word was placed at the
 * coordinate it happened to occupy *on screen* rather than its position down the capture. The text
 * layer then sat a whole scroll offset away from the picture it was supposed to describe.
 *
 * Written against the same `ScrollGeometry` the capture loop and the stitcher use, so the three
 * cannot disagree. For a document capture `captureX`/`captureY` are 0 and the offsets are the window
 * scroll, which is why this reduces exactly to the old behaviour there and changes nothing.
 */
export interface ImageSpaceGeometry {
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
  offsetX: number
  offset: number
}

export function viewportToImage(
  point: { x: number; y: number },
  geometry: ImageSpaceGeometry,
): { x: number; y: number } {
  return {
    x: point.x - geometry.captureX + geometry.offsetX,
    y: point.y - geometry.captureY + geometry.offset,
  }
}

/**
 * The offsets `toContentRects` must be given so its output lands in image space.
 *
 * The capture's own origin is subtracted later, by the worker, from `imageOrigin` -- so what is
 * added here is the content offset alone, and the two must be read from the same geometry.
 */
export function contentScrollOffset(geometry: ImageSpaceGeometry): { x: number; y: number } {
  return { x: geometry.offsetX, y: geometry.offset }
}

/**
 * The region of the viewport this capture photographs, in viewport coordinates.
 *
 * Everything outside it is cropped out of every screenshot, so it is the boundary of what the text
 * layer is allowed to describe. For a document capture that is the whole viewport; for a nested
 * scroller it is the scroller's box, and the page chrome above and beside it lies outside.
 */
export function captureRectFor(geometry: ImageSpaceGeometry): ClientRectLike {
  return {
    left: geometry.captureX,
    top: geometry.captureY,
    width: geometry.captureWidth,
    height: geometry.captureHeight,
  }
}

/** The image origin the worker must subtract, given the geometry the rects were harvested with. */
export function imageOriginFor(geometry: ImageSpaceGeometry): { x: number; y: number } {
  return { x: geometry.captureX, y: geometry.captureY }
}

/** The shape of a `DOMRect`, so rect filtering can be tested without a DOM. */
export interface ClientRectLike {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Turns the rects an element occupies into document-space rects, dropping the meaningless ones.
 *
 * Takes an `ArrayLike` and walks it by index, which is not fussiness: `getClientRects()` returns a
 * `DOMRectList`, and unlike `NodeList` that has **no** `Symbol.iterator` in Chrome. Iterating it
 * with `for...of` throws, which is exactly how this silently produced nothing for every capture --
 * the throw was swallowed as "this page has no content to offer".
 */
export function toContentRects(
  rects: ArrayLike<ClientRectLike>,
  scrollX: number,
  scrollY: number,
): ContentRect[] {
  const collected: ContentRect[] = []
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]
    if (!rect || rect.width < MIN_CONTENT_PX || rect.height < MIN_CONTENT_PX) continue
    collected.push({ x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height })
  }
  return collected
}

/**
 * Where each whitespace-delimited word sits in a string, as `[from, to)` character offsets.
 *
 * A run per word rather than per line is the difference between selection landing *on* the words and
 * landing near them. A line-long run has to be stretched horizontally to span its box, and since the
 * page's font is not the PDF's font, every character inside that span is placed by proportion rather
 * than by measurement. A word is short enough that its own box, measured directly, is the answer.
 */
export function wordSpans(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = []
  let start: number | undefined
  for (let index = 0; index < text.length; index += 1) {
    const blank = text[index]!.trim() === ''
    if (blank) {
      if (start !== undefined) spans.push({ from: start, to: index })
      start = undefined
    } else if (start === undefined) {
      start = index
    }
  }
  if (start !== undefined) spans.push({ from: start, to: text.length })
  return spans
}

/**
 * The overlap of two boxes, or `undefined` when they do not meet.
 *
 * Used to hold text and links inside whatever clips them. A word scrolled out of view inside an
 * `overflow: hidden` panel is not in the screenshot, so a selectable box for it would sit over
 * whatever the image shows there instead -- text you can select that you cannot see.
 */
export function intersectRect(a: ClientRectLike, b: ClientRectLike): ClientRectLike | undefined {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  if (right <= left || bottom <= top) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * The size of a CSS `clip: rect(t, r, b, l)` value, or `undefined` when it is not one.
 *
 * `position: absolute` plus a near-zero `clip` is the long-standing way to hide text from the screen
 * while leaving it to screen readers. That text is not in the screenshot, so putting it in the PDF's
 * searchable layer would make "skip to main content" findable in a picture that never showed it.
 */
export function cssClipSize(clip: string): { width: number; height: number } | undefined {
  const match = /^rect\((.+)\)$/.exec(clip.trim())
  if (!match) return undefined
  const parts = match[1]!.split(/[\s,]+/).map((part) => Number.parseFloat(part))
  if (parts.length < 4 || parts.some((part) => Number.isNaN(part))) return undefined
  const [top, right, bottom, left] = parts as [number, number, number, number]
  return { width: right - left, height: bottom - top }
}

/** How small a `clip` box has to be before it is hiding rather than trimming. */
export const CLIP_HIDDEN_PX = 4

/**
 * The words of a capture, folded into one string history can search.
 *
 * Derived once at save time rather than searched through on every keystroke: the runs are thousands
 * of objects with coordinates, and the list page wants a substring test. Deduplicated because a
 * page repeats itself and the index is for *finding* the capture, not reproducing it.
 */
export function searchableText(content: PageContent, limit = MAX_SEARCH_TEXT): string {
  const seen = new Set<string>()
  let length = 0
  for (const run of content.runs) {
    for (const word of run.text.toLowerCase().split(/\s+/)) {
      if (word === '' || seen.has(word)) continue
      if (length + word.length + 1 > limit) return [...seen].join(' ')
      seen.add(word)
      length += word.length + 1
    }
  }
  return [...seen].join(' ')
}

/** The cap on one entry's search index, so history storage is spent on pixels, not on prose. */
export const MAX_SEARCH_TEXT = 64_000
