/**
 * The export choice, as numbers and strings with no DOM in sight.
 *
 * The result page used to carry one button per format. They are now one button and a menu, which
 * means a *stored* choice, a label that has to say what the button will actually do, and a quality
 * value arriving from a range input that can hold anything. All three are pure, so they are tested
 * in plain Node rather than discovered in a browser the development machine does not have.
 */

import {
  CANVAS_IMAGE_LIMITS,
  fitsSingleImage,
  singleImageLimitParts,
  WEBP_IMAGE_LIMITS,
  type SingleImageLimits,
} from '../shared/capture-plan'
import {
  flattenParts,
  noticeText,
  noticeValue,
  type NoticePart,
} from '../shared/notice-parts'

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'pdf'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp', 'pdf']

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'png'

/**
 * PNG and JPEG are drawn onto a single canvas and so are subject to the single-image ceiling; a PDF
 * is written one page at a time and never is. That difference is why the size warning has to know
 * which format is selected -- shown against a PDF it would simply be false.
 */
export function isSingleImageFormat(format: ExportFormat): boolean {
  return format !== 'pdf'
}

/** Formats whose encoder takes a quality fraction. PNG is lossless and ignores one. */
export function isLossyFormat(format: ExportFormat): boolean {
  return format === 'jpeg' || format === 'webp'
}

/**
 * The size bound for this format, or `null` for PDF, which has none worth stating -- it is written
 * one page at a time and never held whole.
 *
 * WebP is the reason this function exists. Its 16,383px per-axis ceiling is a quarter of the
 * canvas limit and **below the height of an ordinary full-page capture**, so a size check that did
 * not vary by format would pass every WebP export and then fail at encode time.
 */
export function limitsForFormat(format: ExportFormat): SingleImageLimits | null {
  if (format === 'pdf') return null
  return format === 'webp' ? WEBP_IMAGE_LIMITS : CANVAS_IMAGE_LIMITS
}

/**
 * How each format is spelled to a person. Not `toUpperCase()`: WebP is a proper noun with a small
 * `P`, and "WEBP" on a button is the tell that a string was derived rather than written.
 */
const FORMAT_NAMES: Record<ExportFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  pdf: 'PDF',
}

export function formatName(format: ExportFormat): string {
  return FORMAT_NAMES[format]
}

/** The primary button's own words. A button that does not say what it does is a button people fear. */
export function exportActionLabel(format: ExportFormat): string {
  return format === 'pdf' ? 'Save PDF' : `Download ${formatName(format)}`
}

/** What it says while it works. */
export function exportBusyLabel(format: ExportFormat): string {
  return format === 'pdf' ? 'Creating PDF...' : `Preparing ${formatName(format)}...`
}

export function exportFileExtension(format: ExportFormat): 'png' | 'jpg' | 'webp' | 'pdf' {
  if (format === 'png') return 'png'
  if (format === 'jpeg') return 'jpg'
  return format === 'webp' ? 'webp' : 'pdf'
}

/** A stored value is whatever was in IndexedDB last time, which is not necessarily a format. */
export function readExportFormat(stored: unknown): ExportFormat {
  return EXPORT_FORMATS.includes(stored as ExportFormat) ? (stored as ExportFormat) : DEFAULT_EXPORT_FORMAT
}

export const JPEG_QUALITY_MIN = 50
export const JPEG_QUALITY_MAX = 100
export const JPEG_QUALITY_STEP = 5

/**
 * Quality as a whole percentage, clamped and snapped to the step.
 *
 * `encodeJpeg` takes a 0-1 fraction and hands it straight to `convertToBlob`, which silently ignores
 * a value outside that range and encodes at the browser default instead -- so a bad number here does
 * not fail, it quietly produces a file that is not the one the slider promised.
 */
export function clampJpegQuality(value: unknown, fallback: number): number {
  // Deliberately not `Number(value)` on anything: `Number(null)` and `Number('')` are both 0, which
  // is finite, so a missing stored value would clamp to the minimum and quietly become a real
  // setting the user never chose.
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return fallback
  const snapped = Math.round(number / JPEG_QUALITY_STEP) * JPEG_QUALITY_STEP
  return Math.min(JPEG_QUALITY_MAX, Math.max(JPEG_QUALITY_MIN, snapped))
}

/** The 0-1 fraction `encodeJpeg` expects. */
export function jpegQualityFraction(percent: number): number {
  return clampJpegQuality(percent, JPEG_QUALITY_MAX) / 100
}

/**
 * Export scale.
 *
 * Discrete steps rather than a slider, deliberately. A screenshot is evidence, and a reader who
 * cannot tell whether they are looking at 100% or 97% of the original has lost something a slider
 * gave them nothing for. Four steps also make the WebP interaction legible: when a capture is too
 * tall for WebP, `smallestScaleThatFits` can name the exact step that would work.
 */
export const EXPORT_SCALES: readonly number[] = [1, 0.75, 0.5, 0.25]

export const DEFAULT_EXPORT_SCALE = 1

/** A stored value is whatever was in IndexedDB last time, which is not necessarily a scale. */
export function readExportScale(stored: unknown): number {
  return EXPORT_SCALES.includes(stored as number) ? (stored as number) : DEFAULT_EXPORT_SCALE
}

/**
 * A scaled axis, in whole pixels and never zero.
 *
 * Rounding down is correct -- a scaled image must not exceed the bound that made it necessary --
 * but rounding a 3px sliver down to 0 produces a canvas Chrome refuses to create, so the floor is 1.
 */
export function scaledDimension(value: number, scale: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(1, Math.floor(value * scale))
}

export function exportScaleLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/**
 * The largest scale in `EXPORT_SCALES` at which this image fits, or `null` if even the smallest does
 * not. Used to turn "too big" into "too big, but 50% fits", which is the difference between an
 * explanation and an instruction.
 */
export function smallestScaleThatFits(
  width: number,
  height: number,
  limits: SingleImageLimits,
): number | null {
  for (const scale of EXPORT_SCALES) {
    if (fitsSingleImage(scaledDimension(width, scale), scaledDimension(height, scale), limits)) {
      return scale
    }
  }
  return null
}

/**
 * The largest scale at or below 1 at which this image fits, as a continuous value.
 *
 * `smallestScaleThatFits` answers the same question from the four scales the *menu* offers, which is
 * right for a download: the user picked a scale and the remedy has to be one they could have picked
 * themselves. Copy has no menu and no user choice to respect -- the only question is how much has to
 * come off for the clipboard to take it at all -- so rounding down to 25% when 31% would have fitted
 * throws away detail for nothing.
 *
 * Both ceilings are applied, because they bind differently: a long thin capture hits the per-axis
 * limit first, and a large squarish one hits the area limit first. Area scales with the square of a
 * linear scale, hence the square root.
 */
export function scaleToFitSingleImage(
  width: number,
  height: number,
  limits: SingleImageLimits = CANVAS_IMAGE_LIMITS,
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  const longestSide = Math.max(width, height)
  const byAxis = limits.maxDimension / longestSide
  const byArea = Math.sqrt(limits.maxPixels / (width * height))
  return Math.min(1, byAxis, byArea)
}

/**
 * The scale worth offering as a one-click remedy, or `null` when there is nothing useful to offer.
 *
 * This is what WebP made necessary rather than merely nice. Its ceiling is 16,383px on a side --
 * roughly a quarter of the canvas limit, and **below an ordinary full-page capture** -- so for that
 * format the refusal is not an edge case, it is the common path. Naming a scale in prose and then
 * making the reader go and find the control is a poor trade for the one format where nearly every
 * capture hits it.
 *
 * Only a scale the user is not already on, and only one that actually helps: `null` when the export
 * already works, when even the smallest scale does not fit, and when the fitting scale is the one
 * already selected.
 */
export function suggestedExportScale(
  format: ExportFormat,
  width: number,
  height: number,
  scale: number = DEFAULT_EXPORT_SCALE,
): number | null {
  const limits = limitsForFormat(format)
  if (!limits) return null
  if (fitsSingleImage(scaledDimension(width, scale), scaledDimension(height, scale), limits)) {
    return null
  }
  const fitting = smallestScaleThatFits(width, height, limits)
  return fitting !== null && fitting < scale ? fitting : null
}

/**
 * What the result page shows about the selected format and scale, or `null` when the export will
 * simply work. One function so the warning cannot disagree with the encoder, which throws from the
 * same limits.
 */
export function exportLimitParts(
  format: ExportFormat,
  width: number,
  height: number,
  scale: number = DEFAULT_EXPORT_SCALE,
): NoticePart[] | null {
  const limits = limitsForFormat(format)
  if (!limits) return null

  const scaledWidth = scaledDimension(width, scale)
  const scaledHeight = scaledDimension(height, scale)
  const parts = singleImageLimitParts(scaledWidth, scaledHeight, limits)
  if (!parts) return null

  const fitting = suggestedExportScale(format, width, height, scale)
  if (fitting !== null) {
    return [
      ...parts,
      noticeText(' At '),
      noticeValue(exportScaleLabel(fitting)),
      noticeText(' it fits.'),
    ]
  }
  return parts
}

/** The same warning as one string, derived from the parts. */
export function exportLimitMessage(
  format: ExportFormat,
  width: number,
  height: number,
  scale: number = DEFAULT_EXPORT_SCALE,
): string | null {
  const parts = exportLimitParts(format, width, height, scale)
  return parts === null ? null : flattenParts(parts)
}

/**
 * The sequence of canvas sizes a downscale should pass through, ending at the target.
 *
 * A single `drawImage` from full size to a quarter size measurably destroys the image. Chrome's
 * minification filter samples a small neighbourhood of the source per destination pixel, so once
 * the reduction passes about 2x it is reading roughly one source pixel in four and discarding the
 * rest -- which on a screenshot means body text breaking up and hairlines vanishing entirely, not
 * merely softening. Measured against text rendered directly at the target size, one pass at 25%
 * had 51% more error than halving repeatedly, and *more* edge energy than the truth, which is the
 * signature of aliasing rather than sharpness. `imageSmoothingQuality` does not help: 'low',
 * 'medium' and 'high' produced byte-comparable output at every scale tested.
 *
 * Halving is the standard remedy. Each step is a 2x reduction, which is the one ratio the built-in
 * filter handles exactly, and every source pixel contributes to the result.
 */
export function downscalePasses(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Array<{ width: number; height: number }> {
  const passes: Array<{ width: number; height: number }> = []
  let width = sourceWidth
  let height = sourceHeight
  // Stop halving once one more step would undershoot; the final pass covers the remainder, which is
  // always a reduction of less than 2x and so within what a single draw handles well.
  while (Math.floor(width / 2) > targetWidth && Math.floor(height / 2) > targetHeight) {
    width = Math.floor(width / 2)
    height = Math.floor(height / 2)
    passes.push({ width, height })
  }
  passes.push({ width: targetWidth, height: targetHeight })
  return passes
}

/**
 * What the button will actually produce, and one piece of advice about it.
 *
 * Two controls in this menu both make the file smaller and they do it by attacking different
 * things: scale removes pixels uniformly, quality keeps every pixel and describes each one less
 * precisely. For a screenshot -- flat colour and sharp type, which is the worst case for lossy
 * compression and the best case for downscaling -- that difference decides which knob to reach for,
 * and nothing in a menu of two sliders says so.
 *
 * Rather than explain it in prose nobody reads, the menu states the outcome and speaks up only when
 * there is a specific, actionable fact about *this* capture. Silence is the default: advice that
 * fires on every combination is a nag, and a nag is read once and then never again.
 */
export interface ExportOutcome {
  width: number
  height: number
  /** Scaled pixels as a fraction of the full capture, so 50% scale is 0.25 here. */
  pixelRatio: number
}

export function exportOutcome(width: number, height: number, scale: number): ExportOutcome {
  const scaled = { width: scaledDimension(width, scale), height: scaledDimension(height, scale) }
  const full = width * height
  return {
    ...scaled,
    pixelRatio: full > 0 ? (scaled.width * scaled.height) / full : 1,
  }
}

/**
 * The two halves of the outcome line: what you get, and what it cost.
 *
 * Two parts rather than one string because they are set on two lines. At 260px a mono line holds
 * about 30 characters, and "1,600 × 20,000 px · full resolution" is not one of them -- letting it
 * wrap put the ratio on a ragged second line and pulled the glyph out of alignment with both.
 */
export function exportOutcomeParts(outcome: ExportOutcome): { size: string; ratio: string } {
  return {
    size: `${outcome.width.toLocaleString()} × ${outcome.height.toLocaleString()} px`,
    ratio:
      outcome.pixelRatio >= 0.999
        ? 'full resolution'
        : `${Math.round(outcome.pixelRatio * 100)}% of the pixels`,
  }
}

/**
 * A file size a person reads at a glance, not a byte count.
 *
 * Three significant figures at most and one decimal only below ten, so the number in the menu stops
 * twitching under the last digit while a quality slider moves: `1.2 MB`, `840 KB`, `12 MB`. Binary
 * units, because that is what every file manager on the machine will show for the same file.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** The same thing on one line, for the accessible name the two-line layout would otherwise split. */
export function exportOutcomeLabel(outcome: ExportOutcome): string {
  const { size, ratio } = exportOutcomeParts(outcome)
  return `${size} · ${ratio}`
}

export interface ExportContext {
  format: ExportFormat
  /** Whole percent, as the slider shows it. */
  quality: number
  scale: number
  /** Whether the page had readable text, which is what lossy compression damages first. */
  hasText: boolean
  /** Whether the picture has a transparent background, which only JPEG cannot carry. */
  transparent: boolean
  width: number
  height: number
}

/**
 * The one thing worth saying about this combination, or `null` when the honest answer is nothing.
 *
 * Ordered by how much the user gains from hearing it, and only ever one at a time.
 */
export function exportAdvice(context: ExportContext): string | null {
  const { format, quality, scale, hasText, transparent, width, height } = context
  if (!isSingleImageFormat(format)) return null

  // First, because it is the only one of these that is a surprise rather than a tip: JPEG has no
  // alpha channel at all. Measured in Chrome rather than assumed -- a fully transparent pixel comes
  // back rgb(1,0,0) and a half-opaque red comes back rgb(129,0,1), so the picture is composited on
  // black, not on white. PNG and WebP both carry alpha, so this is JPEG's alone.
  if (format === 'jpeg' && transparent) {
    return 'JPEG has no transparency, so a transparent background is flattened onto black. PNG and WebP keep it.'
  }

  // The core confusion, stated only where it bites: full size, lossy, and text on the page.
  if (isLossyFormat(format) && hasText && quality < 80 && scale >= 0.999) {
    return 'Quality softens text before anything else. Below 80, scaling down usually looks better at the same file size.'
  }

  // Only worth raising on a capture big enough for the difference to matter.
  if (format === 'png' && width * height > 12_000_000) {
    return 'PNG keeps every pixel exactly, which is large here. WebP is usually far smaller with no visible loss.'
  }

  return null
}

/**
 * How many destination rows of context each band is resampled with beyond the rows it keeps.
 *
 * Resampling a band in isolation is not the same as resampling the whole image and cutting it up:
 * a pixel at a band's edge would average only the source rows on its own side, so the two sides of
 * a boundary land on different values and the join shows as a hairline. Reading a margin of extra
 * rows and then discarding them gives every kept pixel the neighbours it would have had. Eight is
 * specified in *destination* rows because that is the space the filter's reach is constant in --
 * one destination row draws from `1/scale` source rows, however small the scale gets.
 */
export const SCALED_BAND_OVERLAP = 8

export interface ScaledCropBand {
  /** Source rows to draw, already including the discarded context above and below. */
  sourceY: number
  sourceHeight: number
  /** Height the drawn band is resampled down to, context included. */
  scaledHeight: number
  /** Where the kept rows begin inside the resampled band. */
  keepOffset: number
  keepHeight: number
  /** Where the kept rows belong in the finished image. */
  destY: number
}

/**
 * Splits a scaled export into bands that can each be resampled on their own.
 *
 * `renderExportCanvas` used to build the crop at full size and shrink it afterwards, so the export
 * needed a canvas for the *unscaled* image even when the user had asked for a quarter of it. That
 * made `smallestScaleThatFits` a promise the export could not keep -- it would say "at 25% it fits"
 * about a capture whose full-size canvas cannot be allocated at all, which is reachable precisely
 * because tiled assembly is what allows captures that long.
 *
 * The banding is done in destination space and the source rows are derived from it, rather than the
 * other way round: the kept rows are an exact partition of the target height, so they cannot leave a
 * gap or overlap however the rounding falls.
 */
export function scaledCropBands(
  cropWidth: number,
  cropHeight: number,
  targetWidth: number,
  targetHeight: number,
  maxSourceRows: number,
  overlap = SCALED_BAND_OVERLAP,
): ScaledCropBand[] {
  if (targetHeight <= 0 || cropHeight <= 0 || maxSourceRows <= 0) return []
  const sourceRow = (destRow: number): number =>
    Math.min(cropHeight, Math.max(0, Math.round((destRow * cropHeight) / targetHeight)))

  /*
   * A band's cost is the padded source rows it draws, so the margin is subtracted from the budget
   * rather than added on top of it -- otherwise the very allocation this exists to avoid comes back,
   * smaller. One destination row is at most `cropHeight / targetHeight` source rows.
   */
  const sourceRowsPerDestRow = cropHeight / targetHeight
  const budget = Math.max(1, Math.floor(maxSourceRows / sourceRowsPerDestRow) - 2 * overlap)
  const bands: ScaledCropBand[] = []
  for (let destY = 0; destY < targetHeight; destY += budget) {
    const keepHeight = Math.min(budget, targetHeight - destY)
    const paddedTop = Math.max(0, destY - overlap)
    const paddedBottom = Math.min(targetHeight, destY + keepHeight + overlap)
    const sourceY = sourceRow(paddedTop)
    bands.push({
      sourceY,
      sourceHeight: sourceRow(paddedBottom) - sourceY,
      scaledHeight: paddedBottom - paddedTop,
      keepOffset: destY - paddedTop,
      keepHeight,
      destY,
    })
  }
  return bands
}
