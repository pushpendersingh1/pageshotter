import { describe, expect, it } from 'vitest'
import browsers from '../src/shared/browsers.json'
import {
  estimatedSegmentCount,
  fitsOneCanvas,
  fitsSingleImage,
  maxTiledImageWidth,
  nextScrollY,
  sectionLimitCssHeight,
  singleImageLimitMessage,
} from '../src/shared/capture-plan'

describe('nextScrollY', () => {
  it('advances by one viewport for ordinary sections', () => {
    expect(nextScrollY(0, 800, 2_400)).toBe(800)
    expect(nextScrollY(800, 800, 2_400)).toBe(1_600)
  })

  it('aligns the final viewport to the document bottom', () => {
    expect(nextScrollY(800, 800, 2_050)).toBe(1_250)
    expect(nextScrollY(1_250, 800, 2_050)).toBeNull()
  })

  it('finishes immediately when the page is shorter than the viewport', () => {
    expect(nextScrollY(0, 900, 500)).toBeNull()
  })

  it('uses newly reported height when a lazy page grows', () => {
    expect(nextScrollY(1_200, 600, 1_800)).toBeNull()
    expect(nextScrollY(1_200, 600, 2_400)).toBe(1_800)
  })
})

describe('estimatedSegmentCount', () => {
  it('reports a useful progress estimate', () => {
    expect(estimatedSegmentCount(2_001, 1_000)).toBe(3)
    expect(estimatedSegmentCount(400, 1_000)).toBe(1)
  })
})

describe('sectionLimitCssHeight', () => {
  it('reaches far past the single-canvas limit that used to cap capture', () => {
    // The case this exists for: at DPR 2 the old canvas-derived limit stopped capture at 32,767 CSS
    // px, which truncated the 60,576 px reference ChatGPT thread to 54%. The section ceiling clears
    // it by a wide margin, so the whole thread is now reachable.
    expect(sectionLimitCssHeight(0, 800)).toBe(160_000)
    expect(sectionLimitCssHeight(0, 800)).toBeGreaterThan(60_576)
  })

  it('measures the ceiling from where capture actually started', () => {
    // A nested scroller clipped above the viewport starts past offset 0, and the ceiling is a budget
    // of sections rather than an absolute depth.
    expect(sectionLimitCssHeight(1_000, 500, 10)).toBe(6_000)
  })

  it('rejects an invalid page size', () => {
    expect(() => sectionLimitCssHeight(0, 0)).toThrow(/invalid page size/i)
    expect(() => sectionLimitCssHeight(0, 800, 0)).toThrow(/invalid page size/i)
  })
})

describe('fitsOneCanvas', () => {
  it('accepts an image inside both the per-axis and area limits', () => {
    expect(fitsOneCanvas(1_600, 40_000)).toBe(true)
  })

  it('rejects a capture taller than one canvas — the case tiled capture now creates', () => {
    expect(fitsOneCanvas(1_600, 65_536)).toBe(false)
    expect(fitsOneCanvas(1_600, 320_000)).toBe(false)
  })

  it('rejects on area even when both axes are individually legal', () => {
    // 2^28 / 8_000 = 33,554, so 40,000 is over the area limit with neither side near 65,535.
    expect(fitsOneCanvas(8_000, 40_000)).toBe(false)
  })

  it('rejects an empty image', () => {
    expect(fitsOneCanvas(0, 500)).toBe(false)
  })
})

describe('maxTiledImageWidth', () => {
  it('binds on area at the tile height, well before the per-axis limit', () => {
    // 2^28 / 8_192 = 32,768 — half the per-axis limit, which is why assembly checks this and not
    // maxCanvasDimension.
    expect(maxTiledImageWidth(8_192)).toBe(32_768)
  })

  it('falls back to the per-axis limit for a short tile', () => {
    expect(maxTiledImageWidth(1_000)).toBe(65_535)
  })

  it('rejects an invalid tile height', () => {
    expect(() => maxTiledImageWidth(0)).toThrow(/invalid page size/i)
  })
})

describe('singleImageLimitMessage', () => {
  it('says nothing about an image that fits', () => {
    expect(singleImageLimitMessage(1_600, 40_000)).toBeNull()
  })

  it('names both escape routes when the capture is too tall for one image', () => {
    const message = singleImageLimitMessage(1_600, 320_000)
    expect(message).toContain('PDF')
    expect(message).toContain('Crop')
    expect(message).toMatch(/65,535 pixels on a side/)
  })

  it('names the area limit when neither side is over the per-axis limit', () => {
    expect(singleImageLimitMessage(8_000, 40_000)).toMatch(/pixels in total/)
  })
})

/*
 * Every browser's measured canvas runs through the same planning, so a profile whose limits were
 * mistyped -- or a planner that quietly went back to Chrome's constants -- shows up here.
 */
describe.each(Object.entries(browsers))('canvas limits for %s', (_, profile) => {
  const { maxDimension, maxPixels } = profile.canvas
  const limits = { maxDimension, maxPixels, imposedBy: 'canvas' as const }

  it('sizes a tile to the area budget, and a short one to the axis', () => {
    expect(maxTiledImageWidth(8_192, profile.canvas)).toBe(Math.min(maxDimension, Math.floor(maxPixels / 8_192)))
    expect(maxTiledImageWidth(1_000, profile.canvas)).toBe(maxDimension)
    expect(maxTiledImageWidth(8_192, profile.canvas) * 8_192).toBeLessThanOrEqual(maxPixels)
  })

  it('takes an image exactly at the limits and refuses one pixel past them', () => {
    const height = Math.floor(maxPixels / maxDimension)
    expect(fitsSingleImage(maxDimension, height, limits)).toBe(true)
    expect(fitsSingleImage(maxDimension, height + 1, limits)).toBe(false)
    expect(fitsSingleImage(maxDimension + 1, 1, limits)).toBe(false)
  })
})

describe('the measured limits', () => {
  it('give Firefox nearly twice the area Chrome and Edge have, on the same axis', () => {
    expect(browsers.chrome.canvas).toEqual({ maxDimension: 65_535, maxPixels: 2 ** 28 })
    expect(browsers.edge.canvas).toEqual(browsers.chrome.canvas)
    expect(browsers.firefox.canvas).toEqual({ maxDimension: 65_535, maxPixels: 2 ** 29 - 2 ** 18 })
  })
})
