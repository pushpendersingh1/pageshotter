import { BROWSER } from './browser'
import { PageShotterError } from './errors'
import {
  flattenParts,
  noticeNumber,
  noticeText,
  noticeValue,
  type NoticePart,
} from './notice-parts'

export const CAPTURE_LIMITS = {
  maxSegments: 200,
  /** Chrome's per-axis canvas limit. */
  maxCanvasDimension: 65_535,
  /** Chrome's total canvas area limit (2^28 pixels). */
  maxCanvasPixels: 268_435_456,
  /**
   * WebP's own container limit, and the reason WebP is not simply another MIME string.
   *
   * The format stores each axis in a 14-bit field, so 16,383 px is a hard ceiling in the file
   * format itself -- a quarter of what Chrome's canvas allows, and *below the height of an ordinary
   * full-page capture*. A canvas that exceeds it encodes to nothing useful, so the size check has to
   * know which format is being asked for; a single check against the canvas limit would pass and
   * then hand the user a failure at the moment they clicked Download.
   */
  maxWebpDimension: 16_383,
} as const

export function nextScrollY(
  currentY: number,
  viewportHeight: number,
  documentHeight: number,
): number | null {
  if (viewportHeight <= 0 || documentHeight <= 0) {
    throw new PageShotterError('INVALID_PAGE_SIZE', `${BROWSER.name} reported an invalid page size.`)
  }

  if (currentY + viewportHeight >= documentHeight - 1) return null

  const maxScrollY = Math.max(0, documentHeight - viewportHeight)
  const next = Math.min(currentY + viewportHeight, maxScrollY)
  return next > currentY ? next : null
}

export function estimatedSegmentCount(documentHeight: number, viewportHeight: number): number {
  if (documentHeight <= 0 || viewportHeight <= 0) return 1
  return Math.max(1, Math.ceil(documentHeight / viewportHeight))
}

/**
 * The deepest content offset, in CSS pixels, that capture can reach within the section ceiling.
 *
 * This is the *only* thing that bounds capture reach. Chrome's canvas limit used to bound it too,
 * which is why every export — PDF included — was truncated at 65,535 output pixels even though
 * assembly and PDF are tiled. Output is now a stack of tiles that no single canvas has to hold, so
 * the limit applies where it is real (single-image export) rather than to the capture itself.
 *
 * Pages deeper than this are still captured up to the ceiling and reported as truncated rather than
 * failed: a partial screenshot of an enormous page is far more useful than an error.
 */
export function sectionLimitCssHeight(
  startOffset: number,
  captureHeight: number,
  maxSegments: number = CAPTURE_LIMITS.maxSegments,
): number {
  if (captureHeight <= 0 || maxSegments <= 0) {
    throw new PageShotterError('INVALID_PAGE_SIZE', `${BROWSER.name} reported an invalid page size.`)
  }
  return Math.max(0, startOffset) + captureHeight * maxSegments
}

/**
 * What bounds a single exported image, and who imposes it.
 *
 * There are two such bounds and they are not the same shape. Chrome's canvas bounds every raster
 * export because every raster export is drawn on a canvas first. WebP then adds its own, stricter
 * per-axis bound on top. `imposedBy` exists so the message can name the right culprit: telling
 * someone Chrome cannot hold their image when it is WebP's file format that cannot is a sentence
 * that sends them to the wrong remedy.
 */
export interface SingleImageLimits {
  maxDimension: number
  maxPixels: number
  imposedBy: 'canvas' | 'webp'
}

/** PNG and JPEG: bounded only by the canvas they are drawn on. */
export const CANVAS_IMAGE_LIMITS: SingleImageLimits = {
  maxDimension: CAPTURE_LIMITS.maxCanvasDimension,
  maxPixels: CAPTURE_LIMITS.maxCanvasPixels,
  imposedBy: 'canvas',
}

/** WebP: the canvas area limit still applies, but the per-axis limit is the format's own. */
export const WEBP_IMAGE_LIMITS: SingleImageLimits = {
  maxDimension: CAPTURE_LIMITS.maxWebpDimension,
  maxPixels: CAPTURE_LIMITS.maxCanvasPixels,
  imposedBy: 'webp',
}

export function fitsSingleImage(
  width: number,
  height: number,
  limits: SingleImageLimits = CANVAS_IMAGE_LIMITS,
): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= limits.maxDimension &&
    height <= limits.maxDimension &&
    width * height <= limits.maxPixels
  )
}

/** Whether an image of this size can exist as one Chrome canvas, and therefore as one PNG or JPEG. */
export function fitsOneCanvas(width: number, height: number): boolean {
  return fitsSingleImage(width, height, CANVAS_IMAGE_LIMITS)
}

/**
 * The widest assembled image a tile of `tileHeight` can hold. Assembly draws one tile at a time, so
 * the canvas limit constrains the *tile*, not the whole image — and because the area limit divides
 * by the tile height rather than the full height, it binds far sooner than the per-axis limit does.
 */
export function maxTiledImageWidth(tileHeight: number): number {
  if (tileHeight <= 0) {
    throw new PageShotterError('INVALID_PAGE_SIZE', `${BROWSER.name} reported an invalid page size.`)
  }
  return Math.min(
    CAPTURE_LIMITS.maxCanvasDimension,
    Math.floor(CAPTURE_LIMITS.maxCanvasPixels / tileHeight),
  )
}

/**
 * Explains, in one sentence the user can act on, why an image this size cannot be saved in
 * `limits` -- or `null` when it can. The result page shows this before the user clicks anything and
 * the encoders throw it, so the warning and the failure cannot drift apart. That coupling is the
 * whole point of this function, and it is why adding a format means adding its limits here rather
 * than checking a size at the call site.
 *
 * The remedy differs by culprit, which is why `imposedBy` is carried this far. A capture too big for
 * any canvas has to become a PDF or a crop. A capture too big only for *WebP* is a capture that PNG
 * would take happily -- so that is what it says, because sending someone to PDF when PNG would have
 * worked is a worse answer than no answer.
 */
export function singleImageLimitParts(
  width: number,
  height: number,
  limits: SingleImageLimits = CANVAS_IMAGE_LIMITS,
): NoticePart[] | null {
  if (fitsSingleImage(width, height, limits)) return null
  const size = noticeValue(`${width.toLocaleString()} × ${height.toLocaleString()} px`)
  const overAxis = width > limits.maxDimension || height > limits.maxDimension

  if (limits.imposedBy === 'webp' && overAxis) {
    return [
      noticeText('This capture is '),
      size,
      noticeText(', and the WebP format cannot store more than '),
      noticeNumber(limits.maxDimension),
      noticeText(
        ' pixels on a side. Save it as a PNG or JPEG, which have no such limit at this size, or ' +
          'scale the export down until it fits.',
      ),
    ]
  }

  return [
    noticeText('This capture is '),
    size,
    noticeText(`, and ${BROWSER.name} cannot hold more than `),
    noticeNumber(overAxis ? limits.maxDimension : limits.maxPixels),
    noticeText(overAxis ? ' pixels on a side' : ' pixels in total'),
    noticeText(
      ' in a single image. Export it as a PDF, which is written one page at a time, or use Crop ' +
        'to select a region and export that.',
    ),
  ]
}

/** The same warning as one string, derived from the parts so the two cannot word it differently. */
export function singleImageLimitMessage(
  width: number,
  height: number,
  limits: SingleImageLimits = CANVAS_IMAGE_LIMITS,
): string | null {
  const parts = singleImageLimitParts(width, height, limits)
  return parts === null ? null : flattenParts(parts)
}
