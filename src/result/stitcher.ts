import { BROWSER } from '../shared/browser'
import {
  CANVAS_IMAGE_LIMITS,
  fitsOneCanvas,
  maxTiledImageWidth,
  singleImageLimitMessage,
  WEBP_IMAGE_LIMITS,
  type SingleImageLimits,
} from '../shared/capture-plan'
import { PageShotterError } from '../shared/errors'
import type { StoredSegment } from '../shared/messages'
import { fullImageCrop, type CropRect } from './crop-geometry'
import { downscalePasses, scaledCropBands, scaledDimension } from './export-options'

export interface StitchPlacement {
  segment: StoredSegment
  sourceX: number
  sourceWidth: number
  sourceY: number
  sourceHeight: number
  destinationY: number
  destinationHeight: number
}

export interface StitchPlan {
  width: number
  height: number
  scaleX: number
  scaleY: number
  placements: StitchPlacement[]
}

export function createStitchPlan(segments: StoredSegment[], finalDocumentHeight: number): StitchPlan {
  const first = segments[0]
  if (!first) throw new PageShotterError('NO_SEGMENTS', 'No screenshot sections were saved.')
  const scaleX = first.imageWidth / first.viewportWidth
  const scaleY = first.imageHeight / first.viewportHeight
  const sourceX = Math.round(first.captureX * scaleX)
  const width = Math.max(0, Math.min(first.imageWidth - sourceX, Math.round(first.captureWidth * scaleX)))
  const height = Math.round(finalDocumentHeight * scaleY)

  for (const segment of segments) {
    const segmentScaleX = segment.imageWidth / segment.viewportWidth
    const segmentScaleY = segment.imageHeight / segment.viewportHeight
    if (
      Math.abs(segmentScaleX - scaleX) > 0.01 ||
      Math.abs(segmentScaleY - scaleY) > 0.01 ||
      segment.viewportWidth !== first.viewportWidth ||
      segment.viewportHeight !== first.viewportHeight ||
      segment.imageWidth !== first.imageWidth ||
      segment.imageHeight !== first.imageHeight ||
      // The horizontal crop is fixed for the whole image; a moving or resizing scroller cannot be
      // stitched into one column. Vertical geometry is allowed to shift and is applied per segment.
      Math.abs(segment.captureX - first.captureX) > 0.5 ||
      Math.abs(segment.captureWidth - first.captureWidth) > 0.5
    ) {
      throw new PageShotterError(
        'VIEWPORT_CHANGED',
        'The browser zoom or viewport changed during capture. Restore it and retry.',
      )
    }
  }

  if (width <= 0 || height <= 0) {
    throw new PageShotterError('EMPTY_CAPTURE', 'The captured area was empty, so there is nothing to assemble.')
  }

  // Only the width is limited. Assembly draws one tile at a time, so no canvas ever has to hold the
  // full height — that is precisely what makes capture beyond 65,535 output pixels possible. The
  // width limit is the tile's, and because the area limit divides by the tile height rather than the
  // full height it binds well before the per-axis limit does.
  if (width > maxTiledImageWidth(TILE_HEIGHT)) {
    throw new PageShotterError(
      'OUTPUT_TOO_WIDE',
      `This page is wider than ${BROWSER.name} can save in one image. Try reducing browser zoom.`,
    )
  }

  let coveredUntilCss = 0
  const placements = segments.map((segment) => {
    const overlapCss = Math.max(0, coveredUntilCss - segment.scrollY)
    const captureTop = Math.round(segment.captureY * scaleY)
    const captureBottom = Math.min(
      segment.imageHeight,
      Math.round((segment.captureY + segment.captureHeight) * scaleY),
    )
    const sourceY = Math.min(captureBottom, captureTop + Math.round(overlapCss * scaleY))
    const availableSourceHeight = Math.max(0, captureBottom - sourceY)
    const destinationY = Math.round((segment.scrollY + overlapCss) * scaleY)
    const destinationHeight = Math.max(0, Math.min(availableSourceHeight, height - destinationY))
    const sourceHeight = destinationHeight
    coveredUntilCss = Math.max(coveredUntilCss, segment.scrollY + segment.captureHeight)
    return { segment, sourceX, sourceWidth: width, sourceY, sourceHeight, destinationY, destinationHeight }
  })

  return {
    width,
    height,
    scaleX,
    scaleY,
    placements,
  }
}

/**
 * Assembled output is held as a vertical stack of tiles rather than one canvas.
 *
 * A full-length capture can reach ~2,360 x 65,535 px, which is a ~620MB contiguous canvas
 * allocation — enough to make the result page unresponsive or fail outright, on exactly the long
 * captures the product exists to handle. Tiles cap peak memory at one band, let the preview render
 * as independent images the browser can decode and discard on demand, and let PDF export read
 * page-sized slices without ever materialising the whole image.
 */
export const TILE_HEIGHT = 8_192

export interface TileBand {
  offsetY: number
  height: number
}

export interface Tile extends TileBand {
  blob: Blob
  width: number
}

export interface TiledImage {
  width: number
  height: number
  scaleX: number
  scaleY: number
  tiles: Tile[]
}

export function planTiles(totalHeight: number, tileHeight = TILE_HEIGHT): TileBand[] {
  if (totalHeight <= 0) throw new PageShotterError('EMPTY_CAPTURE', 'The captured area was empty.')
  const bands: TileBand[] = []
  for (let offsetY = 0; offsetY < totalHeight; offsetY += tileHeight) {
    bands.push({ offsetY, height: Math.min(tileHeight, totalHeight - offsetY) })
  }
  return bands
}

function createCanvas(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new PageShotterError('CANVAS_UNAVAILABLE', `${BROWSER.name} could not create the screenshot canvas.`)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  return canvas
}

function canvasContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new PageShotterError('CANVAS_UNAVAILABLE', `${BROWSER.name} could not create the screenshot canvas.`)
  return context
}

export async function buildTiledImage(
  segments: StoredSegment[],
  finalDocumentHeight: number,
): Promise<TiledImage> {
  const plan = createStitchPlan(segments, finalDocumentHeight)
  const tiles: Tile[] = []

  for (const band of planTiles(plan.height)) {
    const canvas = createCanvas(plan.width, band.height)
    const context = canvasContext(canvas)
    const bandBottom = band.offsetY + band.height

    for (const placement of plan.placements) {
      if (placement.destinationHeight <= 0) continue
      const top = Math.max(band.offsetY, placement.destinationY)
      const bottom = Math.min(bandBottom, placement.destinationY + placement.destinationHeight)
      if (bottom <= top) continue

      // Source and destination share a scale, so the band clip applies to both unchanged.
      const image = await createImageBitmap(placement.segment.blob)
      context.drawImage(
        image,
        placement.sourceX,
        placement.sourceY + (top - placement.destinationY),
        placement.sourceWidth,
        bottom - top,
        0,
        top - band.offsetY,
        plan.width,
        bottom - top,
      )
      image.close()
    }

    tiles.push({
      blob: await canvas.convertToBlob({ type: 'image/png' }),
      width: plan.width,
      height: band.height,
      offsetY: band.offsetY,
    })
  }

  return { width: plan.width, height: plan.height, scaleX: plan.scaleX, scaleY: plan.scaleY, tiles }
}

/**
 * Draws an arbitrary rectangle of the assembled image, reading only the tiles that rectangle
 * touches. Cropped exports use it to avoid ever building the uncropped image, which matters most on
 * the long captures where a crop is the only way to get a usable file at all.
 */
export async function renderCrop(image: TiledImage, crop: CropRect): Promise<OffscreenCanvas> {
  const canvas = createCanvas(crop.width, crop.height)
  const context = canvasContext(canvas)
  const regionBottom = crop.y + crop.height

  for (const tile of image.tiles) {
    const top = Math.max(crop.y, tile.offsetY)
    const bottom = Math.min(regionBottom, tile.offsetY + tile.height)
    if (bottom <= top) continue
    const bitmap = await createImageBitmap(tile.blob)
    context.drawImage(
      bitmap,
      crop.x,
      top - tile.offsetY,
      crop.width,
      bottom - top,
      0,
      top - crop.y,
      crop.width,
      bottom - top,
    )
    bitmap.close()
  }
  return canvas
}

/**
 * Draws a full-width horizontal slice. PDF export uses it one page at a time; PNG export asks for
 * the whole height, which is the only place a full-size canvas is built and it happens on demand
 * rather than on page load.
 */
export async function renderRegion(
  image: TiledImage,
  sourceY: number,
  height: number,
): Promise<OffscreenCanvas> {
  return renderCrop(image, { x: 0, y: sourceY, width: image.width, height })
}

/**
 * JPEG quality for standalone export. The PDF writer uses the same trade-off internally: high enough
 * that page text stays crisp, low enough that a long capture is a fraction of the PNG's size, which
 * is the only reason to choose JPEG here at all.
 */
export const JPEG_QUALITY = 0.9

/**
 * A capture can now be taller than any single canvas, so a full-size PNG or JPEG of it cannot exist.
 * That is checked before any drawing rather than discovered when the canvas allocation fails, so a
 * long capture reports the limit instantly instead of after minutes of work — and it reports it in
 * the same words the result page already showed before the button was pressed.
 */
function assertSingleImage(crop: CropRect, limits: SingleImageLimits, scale: number): void {
  const message = singleImageLimitMessage(
    scaledDimension(crop.width, scale),
    scaledDimension(crop.height, scale),
    limits,
  )
  if (message) throw new PageShotterError('IMAGE_TOO_LARGE', message)
}

/**
 * Draws the crop, resampled if the export is scaled.
 *
 * At 100% this returns `renderCrop` untouched, so the ordinary path gains no copy. Below it the
 * reduction is done in repeated halvings rather than one draw -- see `downscalePasses` for the
 * measurement that forced this, and for why `imageSmoothingQuality` is not the answer. The setting
 * is still requested because it costs nothing and other engines may honour it.
 */
function halveDown(
  source: OffscreenCanvas,
  targetWidth: number,
  targetHeight: number,
): OffscreenCanvas {
  let current = source
  for (const pass of downscalePasses(source.width, source.height, targetWidth, targetHeight)) {
    const target = createCanvas(pass.width, pass.height)
    const context = canvasContext(target)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(current, 0, 0, current.width, current.height, 0, 0, pass.width, pass.height)
    // Each intermediate is up to four times the size of the next; release it rather than hold the
    // whole chain alive until the export finishes.
    current.width = 0
    current.height = 0
    current = target
  }
  return current
}

export async function renderExportCanvas(
  image: TiledImage,
  crop: CropRect,
  scale: number,
): Promise<OffscreenCanvas> {
  if (scale >= 1) return renderCrop(image, crop)

  const targetWidth = scaledDimension(crop.width, scale)
  const targetHeight = scaledDimension(crop.height, scale)

  /*
   * The ordinary path is left exactly as it was, and is still the one every capture that fits today
   * takes: whole crop, then the halving chain, which is the arrangement the aliasing measurement was
   * made against. Banding engages only where the alternative is not a worse picture but no picture
   * at all -- a source canvas Chrome will not allocate.
   */
  if (fitsOneCanvas(crop.width, crop.height)) {
    return halveDown(await renderCrop(image, crop), targetWidth, targetHeight)
  }

  const maxSourceRows = Math.min(
    CANVAS_IMAGE_LIMITS.maxDimension,
    Math.floor(CANVAS_IMAGE_LIMITS.maxPixels / Math.max(1, crop.width)),
  )
  const bands = scaledCropBands(crop.width, crop.height, targetWidth, targetHeight, maxSourceRows)
  const canvas = createCanvas(targetWidth, targetHeight)
  const context = canvasContext(canvas)
  for (const band of bands) {
    const source = await renderCrop(image, {
      x: crop.x,
      y: crop.y + band.sourceY,
      width: crop.width,
      height: band.sourceHeight,
    })
    const scaled = halveDown(source, targetWidth, band.scaledHeight)
    // Only the interior is kept. The rows above and below it existed so the kept pixels were
    // averaged with the neighbours they have in the whole image rather than with a band edge.
    context.drawImage(
      scaled,
      0,
      band.keepOffset,
      targetWidth,
      band.keepHeight,
      0,
      band.destY,
      targetWidth,
      band.keepHeight,
    )
    scaled.width = 0
    scaled.height = 0
  }
  return canvas
}

export async function encodeJpeg(
  image: TiledImage,
  crop = fullImageCrop(image.width, image.height),
  quality = JPEG_QUALITY,
  scale = 1,
): Promise<Blob> {
  assertSingleImage(crop, CANVAS_IMAGE_LIMITS, scale)
  try {
    // Tiles are drawn onto an opaque white canvas, so JPEG's lack of an alpha channel loses nothing.
    const canvas = await renderExportCanvas(image, crop, scale)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } catch (error) {
    throw encodingFailure(error, 'JPEG')
  }
}

/**
 * WebP, which is not simply another MIME string.
 *
 * Two things make it different. Its per-axis ceiling is 16,383px -- below an ordinary full-page
 * capture -- so `WEBP_IMAGE_LIMITS` is what it is checked against, and the check has to happen
 * before the canvas is built rather than after `convertToBlob` returns something unusable. And
 * Chrome's `convertToBlob` **does not reject an unsupported type**: it falls back to PNG and returns
 * a blob whose `type` is `image/png`, so a caller that trusted the call would hand the user a file
 * named `.webp` that is not one. That is checked for explicitly below.
 */
export async function encodeWebp(
  image: TiledImage,
  crop = fullImageCrop(image.width, image.height),
  quality = JPEG_QUALITY,
  scale = 1,
): Promise<Blob> {
  assertSingleImage(crop, WEBP_IMAGE_LIMITS, scale)
  let blob: Blob
  try {
    const canvas = await renderExportCanvas(image, crop, scale)
    blob = await canvas.convertToBlob({ type: 'image/webp', quality })
  } catch (error) {
    throw encodingFailure(error, 'WebP')
  }
  if (blob.type !== 'image/webp') {
    throw new PageShotterError(
      'WEBP_UNSUPPORTED',
      'This browser did not produce a WebP file. Save the screenshot as a PNG or JPEG instead.',
    )
  }
  return blob
}

/** One raster format, so a surface names the format rather than repeating the three-way switch. */
export function encodeImage(
  format: 'png' | 'jpeg' | 'webp',
  image: TiledImage,
  crop: CropRect | undefined,
  quality: number,
  scale: number,
): Promise<Blob> {
  if (format === 'png') return encodePng(image, crop, scale)
  return format === 'jpeg' ? encodeJpeg(image, crop, quality, scale) : encodeWebp(image, crop, quality, scale)
}

export async function encodePng(
  image: TiledImage,
  crop = fullImageCrop(image.width, image.height),
  scale = 1,
): Promise<Blob> {
  assertSingleImage(crop, CANVAS_IMAGE_LIMITS, scale)
  try {
    const canvas = await renderExportCanvas(image, crop, scale)
    return await canvas.convertToBlob({ type: 'image/png' })
  } catch (error) {
    throw encodingFailure(error, 'PNG')
  }
}

/**
 * One message for every encoder, so a format added later cannot get a worse one -- and a
 * `PageShotterError` thrown by `assertSingleImage` inside the `try` passes through rather than being
 * relabelled as an out-of-memory failure it is not.
 */
function encodingFailure(error: unknown, label: string): PageShotterError {
  if (error instanceof PageShotterError) return error
  return new PageShotterError(
    'IMAGE_ENCODING_FAILED',
    `${BROWSER.name} ran out of memory saving this screenshot as a single ${label}. Export it as a PDF, use ` +
      `Crop to select a region, or scale the export down.`,
  )
}
