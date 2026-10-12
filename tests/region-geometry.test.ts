import { describe, expect, it } from 'vitest'

import { MIN_REGION_PX, REGION_SCROLL_MAX_STEP, elementRectToRegion, regionFitsViewport, regionFromDrag, regionScrollStep, regionToImageCrop, regionToViewport, sameRect, type SelectedRegion } from '../src/shared/region-geometry'

describe('regionFromDrag', () => {
  it('reads the same region from a drag in any direction', () => {
    const expected = { x: 100, y: 200, width: 300, height: 400 }
    expect(regionFromDrag({ x: 100, y: 200 }, { x: 400, y: 600 })).toEqual(expected)
    expect(regionFromDrag({ x: 400, y: 600 }, { x: 100, y: 200 })).toEqual(expected)
    expect(regionFromDrag({ x: 400, y: 200 }, { x: 100, y: 600 })).toEqual(expected)
    expect(regionFromDrag({ x: 100, y: 600 }, { x: 400, y: 200 })).toEqual(expected)
  })

  it('rejects a plain click and a twitch, so a stray click cannot export a sliver', () => {
    expect(regionFromDrag({ x: 100, y: 100 }, { x: 100, y: 100 })).toBeUndefined()
    expect(
      regionFromDrag({ x: 100, y: 100 }, { x: 100 + MIN_REGION_PX - 1, y: 100 + 400 }),
    ).toBeUndefined()
    expect(
      regionFromDrag({ x: 100, y: 100 }, { x: 100 + 400, y: 100 + MIN_REGION_PX - 1 }),
    ).toBeUndefined()
  })

  it('accepts a drag exactly at the minimum', () => {
    expect(
      regionFromDrag({ x: 0, y: 0 }, { x: MIN_REGION_PX, y: MIN_REGION_PX }),
    ).toEqual({ x: 0, y: 0, width: MIN_REGION_PX, height: MIN_REGION_PX })
  })
})

describe('regionToImageCrop', () => {
  const region: SelectedRegion = { x: 100, y: 50, width: 200, height: 120 }

  it('maps a region onto a 1:1 capture unchanged', () => {
    expect(regionToImageCrop(region, 1, 1, 0, 0, 1_200, 800)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 120,
    })
  })

  it('applies the capture scale, so a DPR 2 screen doubles every coordinate', () => {
    // The whole point of measuring the scale: at DPR 2 a 1,200 CSS px viewport is a 2,400 px image,
    // and a region read as CSS pixels would otherwise land on the wrong half of the screenshot.
    expect(regionToImageCrop(region, 2, 2, 0, 0, 2_400, 1_600)).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 240,
    })
  })

  it('measures from the capture rect, not the window', () => {
    // A capture that skips viewport chrome starts at a non-zero origin; ignoring it would shift the
    // region by exactly that offset.
    expect(regionToImageCrop(region, 1, 1, 40, 30, 1_200, 800)).toEqual({
      x: 60,
      y: 20,
      width: 200,
      height: 120,
    })
  })

  it('clamps a region dragged past the edge to the pixels that exist', () => {
    const overhang: SelectedRegion = { x: 900, y: 700, width: 600, height: 400 }
    expect(regionToImageCrop(overhang, 1, 1, 0, 0, 1_200, 800)).toEqual({
      x: 900,
      y: 700,
      width: 300,
      height: 100,
    })
  })

  it('returns undefined when the region lies entirely outside the captured image', () => {
    const outside: SelectedRegion = { x: 2_000, y: 50, width: 100, height: 100 }
    expect(regionToImageCrop(outside, 1, 1, 0, 0, 1_200, 800)).toBeUndefined()
  })

  it('returns undefined rather than a bad crop for an unusable scale or image', () => {
    expect(regionToImageCrop(region, 0, 1, 0, 0, 1_200, 800)).toBeUndefined()
    expect(regionToImageCrop(region, 1, Number.NaN, 0, 0, 1_200, 800)).toBeUndefined()
    expect(regionToImageCrop(region, 1, 1, 0, 0, 0, 800)).toBeUndefined()
  })
})

describe('regionScrollStep', () => {
  it('does not scroll until the pointer is past the edge', () => {
    expect(regionScrollStep(0)).toBe(0)
    expect(regionScrollStep(-10)).toBe(0)
  })

  it('scales with the overshoot so a long page can be pulled through', () => {
    expect(regionScrollStep(4)).toBeLessThan(regionScrollStep(40))
  })

  it('caps the step so content cannot be skipped faster than the box is seen to move', () => {
    expect(regionScrollStep(10_000)).toBe(REGION_SCROLL_MAX_STEP)
  })

  it('always moves at least a little once past the edge', () => {
    expect(regionScrollStep(1)).toBeGreaterThan(0)
  })
})

describe('regionFitsViewport', () => {
  const viewport = { width: 1200, height: 800 }

  it('accepts a region entirely on screen at a non-zero scroll', () => {
    const region = { x: 100, y: 5_100, width: 300, height: 200 }
    expect(regionFitsViewport(region, { x: 0, y: 5_000 }, viewport)).toBe(true)
  })

  it('rejects a region taller than the viewport', () => {
    const region = { x: 0, y: 5_000, width: 300, height: 1_400 }
    expect(regionFitsViewport(region, { x: 0, y: 5_000 }, viewport)).toBe(false)
  })

  it('rejects a region that starts above what is on screen', () => {
    const region = { x: 0, y: 4_900, width: 300, height: 200 }
    expect(regionFitsViewport(region, { x: 0, y: 5_000 }, viewport)).toBe(false)
  })

  it('rejects a region running past the bottom of the viewport', () => {
    const region = { x: 0, y: 5_700, width: 300, height: 200 }
    expect(regionFitsViewport(region, { x: 0, y: 5_000 }, viewport)).toBe(false)
  })

  it('treats a degenerate viewport as not fitting rather than dividing by it', () => {
    const region = { x: 0, y: 0, width: 10, height: 10 }
    expect(regionFitsViewport(region, { x: 0, y: 0 }, { width: 0, height: 0 })).toBe(false)
  })
})

describe('regionToViewport', () => {
  it('cancels the document offset so the single-screenshot path sees a viewport region', () => {
    const region = { x: 140, y: 5_100, width: 300, height: 200 }
    expect(regionToViewport(region, { x: 40, y: 5_000 })).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 200,
    })
  })
})

describe('band placement', () => {
  // The band's image origin is the first segment's scroll offset, which near the bottom of a page is
  // above the requested one. Passing it as captureY is what keeps the crop aligned with the image.
  it('places a region against a band origin above the selection', () => {
    const region = { x: 0, y: 9_000, width: 400, height: 1_500 }
    const crop = regionToImageCrop(region, 2, 2, 0, 8_800, 2_400, 4_000)
    expect(crop).toEqual({ x: 0, y: 400, width: 800, height: 3_000 })
  })

  it('clamps a band crop to the assembled image rather than reading past it', () => {
    const region = { x: 0, y: 9_000, width: 400, height: 4_000 }
    const crop = regionToImageCrop(region, 2, 2, 0, 9_000, 2_400, 4_000)
    expect(crop).toEqual({ x: 0, y: 0, width: 800, height: 4_000 })
  })
})

describe('elementRectToRegion', () => {
  it('adds the scroll offset, so an element picked far down the page keeps its document position', () => {
    const region = elementRectToRegion({ left: 40, top: 120, width: 500, height: 300 }, { x: 0, y: 2_000 })
    expect(region).toEqual({ x: 40, y: 2_120, width: 500, height: 300 })
  })

  it('rounds outward, so a fractional layout never shaves the element own border off', () => {
    const region = elementRectToRegion({ left: 10.4, top: 20.6, width: 100.3, height: 50.1 }, { x: 0, y: 0 })
    // Left/top floor down to 10/20 and right/bottom ceil up to 111/71, so the element is enclosed.
    expect(region).toEqual({ x: 10, y: 20, width: 101, height: 51 })
  })

  it('clamps at the document origin for an element that starts off the left or top edge', () => {
    const region = elementRectToRegion({ left: -30, top: -20, width: 200, height: 100 }, { x: 0, y: 0 })
    expect(region).toEqual({ x: 0, y: 0, width: 170, height: 80 })
  })

  it('refuses anything below the same threshold a drag has to clear', () => {
    expect(elementRectToRegion({ left: 0, top: 0, width: MIN_REGION_PX - 1, height: 400 }, { x: 0, y: 0 })).toBeUndefined()
    expect(elementRectToRegion({ left: 0, top: 0, width: 400, height: MIN_REGION_PX - 1 }, { x: 0, y: 0 })).toBeUndefined()
    expect(elementRectToRegion({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBeUndefined()
  })

  it('accepts an element taller than any viewport, which the band path then captures', () => {
    const region = elementRectToRegion({ left: 100, top: -400, width: 520, height: 4_000 }, { x: 0, y: 900 })
    expect(region).toEqual({ x: 100, y: 500, width: 520, height: 4_000 })
  })
})

describe('sameRect', () => {
  const box = { left: 100, top: 200, width: 300, height: 400 }

  it('collapses a wrapper drawn in exactly the same place', () => {
    expect(sameRect(box, { ...box })).toBe(true)
  })

  it('tolerates a pixel of layout rounding', () => {
    expect(sameRect(box, { left: 100.4, top: 199.7, width: 300.2, height: 400 })).toBe(true)
  })

  it('stops the walk as soon as any edge would move', () => {
    expect(sameRect(box, { ...box, left: 90 })).toBe(false)
    expect(sameRect(box, { ...box, top: 190 })).toBe(false)
    expect(sameRect(box, { ...box, width: 320 })).toBe(false)
    expect(sameRect(box, { ...box, height: 420 })).toBe(false)
  })

  it('does not treat a parent with padding as the same box', () => {
    expect(sameRect(box, { left: 88, top: 188, width: 324, height: 424 })).toBe(false)
  })
})
