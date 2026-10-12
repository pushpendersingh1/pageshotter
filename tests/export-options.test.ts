import { describe, expect, it } from 'vitest'
import {
  clampJpegQuality,
  downscalePasses,
  EXPORT_FORMATS,
  exportActionLabel,
  exportAdvice,
  formatBytes,
  exportBusyLabel,
  exportFileExtension,
  exportLimitMessage,
  exportLimitParts,
  exportOutcome,
  exportOutcomeLabel,
  exportScaleLabel,
  isSingleImageFormat,
  JPEG_QUALITY_MAX,
  JPEG_QUALITY_MIN,
  jpegQualityFraction,
  readExportFormat,
  readExportScale,
  SCALED_BAND_OVERLAP,
  scaledCropBands,
  scaledDimension,
  scaleToFitSingleImage,
  smallestScaleThatFits,
  suggestedExportScale,
} from '../src/result/export-options'
import { fitsSingleImage, WEBP_IMAGE_LIMITS } from '../src/shared/capture-plan'
import { flattenParts } from '../src/shared/notice-parts'

describe('export format', () => {
  it('names every format on the button', () => {
    expect(EXPORT_FORMATS.map(exportActionLabel)).toEqual(['Download PNG', 'Download JPEG', 'Download WebP', 'Save PDF'])
  })

  it('says what it is doing while it works', () => {
    expect(EXPORT_FORMATS.map(exportBusyLabel)).toEqual([
      'Preparing PNG...',
      'Preparing JPEG...',
      'Preparing WebP...',
      'Creating PDF...',
    ])
  })

  it('uses the conventional jpg extension rather than the format name', () => {
    expect(EXPORT_FORMATS.map(exportFileExtension)).toEqual(['png', 'jpg', 'webp', 'pdf'])
  })

  it('treats only the canvas formats as subject to the single-image ceiling', () => {
    expect(EXPORT_FORMATS.filter(isSingleImageFormat)).toEqual(['png', 'jpeg', 'webp'])
  })

  it('accepts a stored format and falls back for anything else', () => {
    for (const format of EXPORT_FORMATS) expect(readExportFormat(format)).toBe(format)
    for (const junk of [undefined, null, '', 'gif', 'PNG', 0, true, {}]) {
      expect(readExportFormat(junk)).toBe('png')
    }
  })
})

describe('jpeg quality', () => {
  it('holds the slider inside the range it offers', () => {
    expect(clampJpegQuality(10, 90)).toBe(JPEG_QUALITY_MIN)
    expect(clampJpegQuality(400, 90)).toBe(JPEG_QUALITY_MAX)
  })

  it('snaps to the step, so the readout matches the value encoded', () => {
    expect(clampJpegQuality(83, 90)).toBe(85)
    expect(clampJpegQuality(82, 90)).toBe(80)
  })

  it('falls back rather than passing a non-number to the encoder', () => {
    // `null` and `''` matter most here: `Number()` turns both into 0, which is a finite number and
    // would clamp to the minimum instead of falling back.
    for (const junk of [undefined, null, '', 'high', NaN, {}, true]) {
      expect(clampJpegQuality(junk, 90)).toBe(90)
    }
    // A numeric string is what a range input actually hands over, and it must still work.
    expect(clampJpegQuality('85', 90)).toBe(85)
  })

  it('hands the encoder a 0-1 fraction, never a percentage', () => {
    expect(jpegQualityFraction(85)).toBeCloseTo(0.85)
    // convertToBlob ignores an out-of-range quality silently, so the clamp has to happen here.
    expect(jpegQualityFraction(400)).toBe(1)
  })
})

/**
 * WebP's ceiling is the whole reason this format was not "one more MIME string", so it is asserted
 * against real capture dimensions rather than against round numbers. A 1,600 x 20,000 px page is an
 * ordinary long article; it fits a canvas comfortably and does not fit WebP at all.
 */
describe('WebP is bounded by its own format, not by the canvas', () => {
  it('accepts a capture that fits both', () => {
    expect(exportLimitMessage('webp', 1_600, 9_000)).toBeNull()
    expect(exportLimitMessage('png', 1_600, 9_000)).toBeNull()
  })

  it('refuses an ordinary long page that PNG takes happily', () => {
    expect(exportLimitMessage('png', 1_600, 20_000)).toBeNull()
    expect(exportLimitMessage('webp', 1_600, 20_000)).toMatch(/16,383 pixels on a side/)
  })

  it('sends the user to PNG rather than to PDF, because PNG would work', () => {
    const message = exportLimitMessage('webp', 1_600, 20_000) ?? ''
    expect(message).toMatch(/Save it as a PNG or JPEG/)
    expect(message).not.toMatch(/Export it as a PDF/)
  })

  it('still sends a genuinely oversized capture to PDF', () => {
    expect(exportLimitMessage('png', 1_600, 70_000)).toMatch(/Export it as a PDF/)
  })

  it('never warns about a PDF, which is written one page at a time', () => {
    expect(exportLimitMessage('pdf', 1_600, 200_000)).toBeNull()
  })
})

describe('export scale', () => {
  it('keeps only a scale it actually offers', () => {
    expect(readExportScale(0.5)).toBe(0.5)
    expect(readExportScale(0.9)).toBe(1)
    expect(readExportScale('half')).toBe(1)
    expect(readExportScale(undefined)).toBe(1)
  })

  it('floors to whole pixels but never to nothing', () => {
    expect(scaledDimension(1_600, 0.5)).toBe(800)
    expect(scaledDimension(1_601, 0.5)).toBe(800)
    // A 3px sliver at 25% is 0.75px; a zero-width canvas is one Chrome refuses to create.
    expect(scaledDimension(3, 0.25)).toBe(1)
    expect(scaledDimension(0, 0.5)).toBe(0)
  })

  it('measures the limit against the scaled size, so scaling down clears the warning', () => {
    expect(exportLimitMessage('webp', 1_600, 20_000, 1)).not.toBeNull()
    expect(exportLimitMessage('webp', 1_600, 20_000, 0.75)).toBeNull()
  })

  it('names the scale that would fit, rather than only saying no', () => {
    expect(exportLimitMessage('webp', 1_600, 20_000, 1)).toMatch(/At 75% it fits\./)
    expect(exportLimitMessage('webp', 1_600, 60_000, 1)).toMatch(/At 25% it fits\./)
  })

  // The base WebP message already ends "...until it fits", so these match the *suggestion* shape
  // rather than the word, which is the mistake that made this test pass against a wrong answer.
  it('does not suggest a scale when none of them helps', () => {
    expect(exportLimitMessage('webp', 1_600, 200_000, 1)).not.toMatch(/At \d+% it fits/)
  })

  // Scaling down only ever helps, so a suggestion can never be one the user has already passed:
  // if a scale fits, the message at that scale is null and there is nothing to append to.
  it('says nothing at all once the chosen scale fits', () => {
    expect(exportLimitMessage('webp', 400, 50_000, 0.25)).toBeNull()
    expect(exportLimitMessage('webp', 1_600, 20_000, 0.5)).toBeNull()
  })

  it('finds the largest scale that works, not merely any', () => {
    expect(smallestScaleThatFits(1_600, 20_000, WEBP_IMAGE_LIMITS)).toBe(0.75)
    expect(smallestScaleThatFits(1_600, 9_000, WEBP_IMAGE_LIMITS)).toBe(1)
    expect(smallestScaleThatFits(1_600, 200_000, WEBP_IMAGE_LIMITS)).toBeNull()
  })
})

describe('what the export will produce', () => {
  it('states the scaled size and what it costs', () => {
    expect(exportOutcomeLabel(exportOutcome(1_600, 20_000, 1))).toMatch(/full resolution$/)
    expect(exportOutcomeLabel(exportOutcome(1_600, 20_000, 0.5))).toBe('800 × 10,000 px · 25% of the pixels')
  })

  it('reports area, not the linear scale — 50% is a quarter of the picture', () => {
    expect(exportOutcome(1_600, 20_000, 0.5).pixelRatio).toBeCloseTo(0.25, 3)
    expect(exportOutcome(1_600, 20_000, 0.25).pixelRatio).toBeCloseTo(0.0625, 3)
  })
})

describe('advice, which is silent unless it has something specific to say', () => {
  const base = {
    format: 'png' as const,
    quality: 90,
    scale: 1,
    hasText: true,
    transparent: false,
    width: 1_600,
    height: 4_000,
  }

  it('says nothing about an ordinary capture at sensible settings', () => {
    expect(exportAdvice(base)).toBeNull()
    expect(exportAdvice({ ...base, format: 'jpeg', quality: 90 })).toBeNull()
  })

  it('warns about soft text only where it actually bites', () => {
    const soft = { ...base, format: 'jpeg' as const, quality: 60 }
    expect(exportAdvice(soft)).toMatch(/softens text/)
    // Already scaling down, which is the advice's own recommendation.
    expect(exportAdvice({ ...soft, scale: 0.5 })).toBeNull()
    // No text on the page means nothing to protect.
    expect(exportAdvice({ ...soft, hasText: false })).toBeNull()
    // PNG is lossless, so quality is not a lever at all.
    expect(exportAdvice({ ...soft, format: 'png' })).toBeNull()
  })

  it('warns that JPEG flattens a transparent background, and only JPEG', () => {
    // Measured, not assumed: Chrome composites a canvas with alpha onto black when it encodes JPEG.
    expect(exportAdvice({ ...base, format: 'jpeg', transparent: true })).toMatch(/flattened onto black/)
    expect(exportAdvice({ ...base, format: 'png', transparent: true })).toBeNull()
    expect(exportAdvice({ ...base, format: 'webp', transparent: true })).toBeNull()
    // It outranks the softening tip: losing transparency is a surprise, soft text is a preference.
    expect(exportAdvice({ ...base, format: 'jpeg', quality: 60, transparent: true })).toMatch(/flattened onto black/)
  })

  it('suggests WebP only on a PNG big enough for it to matter', () => {
    expect(exportAdvice({ ...base, height: 4_000 })).toBeNull()
    expect(exportAdvice({ ...base, height: 20_000 })).toMatch(/WebP is usually far smaller/)
  })

  it('never advises about a PDF, which neither knob applies to', () => {
    expect(exportAdvice({ ...base, format: 'pdf', quality: 60 })).toBeNull()
  })

  it('says only one thing at a time when more than one rule could fire', () => {
    // A large PNG whose page has text: the WebP suggestion is about this format, the quality lesson
    // is not -- and either way the menu shows one line.
    const advice = exportAdvice({ ...base, height: 20_000 })
    expect(advice).toMatch(/WebP is usually far smaller/)
    expect(advice?.split('. ').length).toBeLessThanOrEqual(2)
  })
})

describe('downscalePasses', () => {
  it('reaches the target in one pass when the reduction is under 2x', () => {
    expect(downscalePasses(1_600, 1_200, 1_200, 900)).toEqual([{ width: 1_200, height: 900 }])
  })

  it('halves repeatedly on the way to a quarter size', () => {
    // A single draw to 25% aliases; the halving step is the whole point of the function.
    expect(downscalePasses(1_600, 1_200, 400, 300)).toEqual([
      { width: 800, height: 600 },
      { width: 400, height: 300 },
    ])
  })

  it('always ends on the exact target, never on a halving remainder', () => {
    const passes = downscalePasses(1_601, 1_201, 400, 300)
    expect(passes[passes.length - 1]).toEqual({ width: 400, height: 300 })
  })

  it('stops halving as soon as either axis would undershoot', () => {
    // A wide, short crop must not have its height halved past the target to suit the width.
    expect(downscalePasses(4_000, 100, 1_000, 25)).toEqual([
      { width: 2_000, height: 50 },
      { width: 1_000, height: 25 },
    ])
  })

  it('does not halve a crop that is already at or below the target', () => {
    expect(downscalePasses(400, 300, 400, 300)).toEqual([{ width: 400, height: 300 }])
  })

  it('never emits a zero-sized canvas for an extreme reduction of a thin crop', () => {
    for (const pass of downscalePasses(20_000, 3, 1, 1)) {
      expect(pass.width).toBeGreaterThan(0)
      expect(pass.height).toBeGreaterThan(0)
    }
  })
})

describe('scaledCropBands', () => {
  /*
   * These bands exist so a scaled export never allocates the unscaled image. Two things have to hold
   * or the export is worse than the bug it replaces: the kept rows must be an exact partition of the
   * output -- one dropped row is a white line across the screenshot, one repeated row is a jump --
   * and every band must stay inside the canvas budget it was banded to fit.
   */
  const budgetFor = (cropWidth: number) => Math.floor(268_435_456 / cropWidth)

  it('covers the output exactly once, with no gap and no overlap', () => {
    const bands = scaledCropBands(1_400, 400_000, 350, 100_000, budgetFor(1_400))
    expect(bands.length).toBeGreaterThan(1)
    let next = 0
    for (const band of bands) {
      expect(band.destY).toBe(next)
      expect(band.keepHeight).toBeGreaterThan(0)
      next += band.keepHeight
    }
    expect(next).toBe(100_000)
  })

  it('keeps every band inside the canvas budget, margin included', () => {
    const budget = budgetFor(1_400)
    for (const band of scaledCropBands(1_400, 400_000, 350, 100_000, budget)) {
      expect(band.sourceHeight).toBeLessThanOrEqual(budget)
      expect(band.sourceHeight * 1_400).toBeLessThanOrEqual(268_435_456)
    }
  })

  it('never reads outside the crop', () => {
    for (const band of scaledCropBands(1_400, 400_000, 350, 100_000, budgetFor(1_400))) {
      expect(band.sourceY).toBeGreaterThanOrEqual(0)
      expect(band.sourceY + band.sourceHeight).toBeLessThanOrEqual(400_000)
    }
  })

  it('reads context around every interior edge and cannot invent rows past the ends', () => {
    const bands = scaledCropBands(1_400, 400_000, 350, 100_000, budgetFor(1_400))
    // The first band has nothing above it, so it keeps from row 0 and pads only below.
    const first = bands[0]!
    expect(first.keepOffset).toBe(0)
    expect(first.scaledHeight).toBe(first.keepHeight + SCALED_BAND_OVERLAP)
    for (const band of bands.slice(1)) {
      expect(band.keepOffset).toBe(SCALED_BAND_OVERLAP)
    }
    const last = bands[bands.length - 1]!
    expect(last.scaledHeight - last.keepOffset - last.keepHeight).toBe(0)
  })

  it('returns a single band when one already fits', () => {
    const bands = scaledCropBands(1_400, 4_000, 350, 1_000, budgetFor(1_400))
    expect(bands).toHaveLength(1)
    expect(bands[0]!).toMatchObject({ sourceY: 0, sourceHeight: 4_000, destY: 0, keepHeight: 1_000 })
  })

  it('has nothing to do for an empty crop', () => {
    expect(scaledCropBands(1_400, 0, 350, 0, 1_000)).toEqual([])
    expect(scaledCropBands(1_400, 4_000, 350, 1_000, 0)).toEqual([])
  })
})

describe('the export warning, marked up', () => {
  const HUGE = { width: 2_880, height: 200_816 }

  it('marks up the size and the limit rather than burying them in prose', () => {
    const parts = exportLimitParts('png', HUGE.width, HUGE.height)
    expect(parts).not.toBeNull()
    const values = (parts ?? []).filter((p) => p.kind === 'value').map((p) => p.text)
    expect(values).toContain(`${(2_880).toLocaleString()} × ${(200_816).toLocaleString()} px`)
    expect(values).toContain((65_535).toLocaleString())
  })

  it('marks up the scale it suggests, which is the part the reader has to act on', () => {
    const parts = exportLimitParts('png', HUGE.width, HUGE.height)
    const values = (parts ?? []).filter((p) => p.kind === 'value').map((p) => p.text)
    // The suggestion is the whole point of the sentence: it names the one setting that works.
    expect(values.some((v) => v.endsWith('%'))).toBe(true)
  })

  it('says the same thing whichever form is read', () => {
    // The string is derived from the parts, so a reworded sentence cannot come out different
    // depending on where it is shown -- the export menu reads one, the notice paints the other.
    const parts = exportLimitParts('png', HUGE.width, HUGE.height) ?? []
    expect(flattenParts(parts)).toBe(exportLimitMessage('png', HUGE.width, HUGE.height))
  })

  it('stays silent for a PDF and for an image that fits', () => {
    expect(exportLimitParts('pdf', HUGE.width, HUGE.height)).toBeNull()
    expect(exportLimitParts('png', 1_200, 4_000)).toBeNull()
  })
})

describe('suggestedExportScale', () => {
  // A 1440x9000 CSS page on a retina display: 2,880 x 18,000 image px. Utterly ordinary, and past
  // WebP's 16,383px axis while nowhere near the 65,535px canvas limit.
  const ORDINARY_RETINA_PAGE = { width: 2_880, height: 18_000 }

  it('offers a scale for an ordinary capture WebP cannot hold', () => {
    const { width, height } = ORDINARY_RETINA_PAGE
    expect(suggestedExportScale('webp', width, height)).toBe(0.75)
  })

  it('offers nothing for the same capture as PNG, which holds it fine', () => {
    const { width, height } = ORDINARY_RETINA_PAGE
    expect(suggestedExportScale('png', width, height)).toBeNull()
  })

  it('offers nothing once the user is already on a scale that fits', () => {
    const { width, height } = ORDINARY_RETINA_PAGE
    expect(suggestedExportScale('webp', width, height, 0.75)).toBeNull()
    expect(suggestedExportScale('webp', width, height, 0.5)).toBeNull()
  })

  it('offers nothing for PDF, which is written a page at a time and has no such ceiling', () => {
    expect(suggestedExportScale('pdf', 2_880, 200_816)).toBeNull()
  })

  it('offers nothing when even the smallest scale cannot fit', () => {
    // 2,880 x 400,000 is still 100,000px tall at 25%, past the canvas limit.
    expect(suggestedExportScale('png', 2_880, 400_000, 1)).toBeNull()
  })

  it('agrees with the sentence shown beside it', () => {
    // The button and the prose come from one function; this is what pins them together.
    const { width, height } = ORDINARY_RETINA_PAGE
    const fitting = suggestedExportScale('webp', width, height)
    const message = exportLimitMessage('webp', width, height)
    expect(fitting).not.toBeNull()
    expect(message).toContain(`At ${exportScaleLabel(fitting as number)} it fits.`)
  })

  it('names the scale the oversize PNG case actually needs', () => {
    // A real case: 2,880 x 200,816 refuses at 100% and downloads at 25%.
    expect(suggestedExportScale('png', 2_880, 200_816, 1)).toBe(0.25)
  })
})


describe('shrinking a copy to fit the clipboard', () => {
  const limits = { maxDimension: 65_535, maxPixels: 268_435_456, imposedBy: 'canvas' as const }

  it('leaves an image that already fits completely alone', () => {
    expect(scaleToFitSingleImage(1_440, 3_087, limits)).toBe(1)
  })

  it('scales a long thin capture by its longest side', () => {
    // 120,000px tall against a 65,535px axis limit, and well under the area limit.
    const scale = scaleToFitSingleImage(800, 120_000, limits)
    expect(scale).toBeCloseTo(65_535 / 120_000, 6)
    expect(Math.floor(120_000 * scale)).toBeLessThanOrEqual(limits.maxDimension)
  })

  it('scales a large squarish capture by area, which binds before the axis does', () => {
    // 20,000 x 20,000 is 400M pixels: inside the axis limit, past the area limit.
    const scale = scaleToFitSingleImage(20_000, 20_000, limits)
    expect(scale).toBeLessThan(1)
    expect(20_000 * scale).toBeLessThanOrEqual(limits.maxDimension)
    expect(20_000 * scale * (20_000 * scale)).toBeLessThanOrEqual(limits.maxPixels + 1)
  })

  it('produces something that actually fits, for every shape tried', () => {
    const shapes: ReadonlyArray<readonly [number, number]> = [
      [900, 300_000],
      [40_000, 9_000],
      [70_000, 70_000],
      [1, 200_000],
    ]
    for (const [w, h] of shapes) {
      const scale = scaleToFitSingleImage(w, h, limits)
      expect(fitsSingleImage(scaledDimension(w, scale), scaledDimension(h, scale), limits)).toBe(true)
    }
  })

  it('never scales up, and refuses to answer nonsense with a nonsense scale', () => {
    expect(scaleToFitSingleImage(10, 10, limits)).toBe(1)
    expect(scaleToFitSingleImage(0, 500, limits)).toBe(1)
    expect(scaleToFitSingleImage(Number.NaN, 500, limits)).toBe(1)
  })
})

describe('formatBytes: the size the menu shows before the file exists', () => {
  it('reads at a glance rather than in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 840)).toBe('840 KB')
    expect(formatBytes(1024 * 1024 * 1.234)).toBe('1.2 MB')
    expect(formatBytes(1024 * 1024 * 12.6)).toBe('13 MB')
  })

  it('drops the decimal once the number is large enough not to need it', () => {
    // The point is a number that does not twitch under its last digit while a slider moves.
    expect(formatBytes(1024 * 9.94)).toBe('9.9 KB')
    expect(formatBytes(1024 * 10.4)).toBe('10 KB')
  })

  it('says nothing about a size it cannot state', () => {
    expect(formatBytes(Number.NaN)).toBe('')
    expect(formatBytes(-1)).toBe('')
  })
})
