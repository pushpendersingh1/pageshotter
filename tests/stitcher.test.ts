import { describe, expect, it } from 'vitest'
import type { StoredSegment } from '../src/shared/messages'
import { createStitchPlan, planTiles } from '../src/result/stitcher'

function segment(index: number, scrollY: number): StoredSegment {
  return {
    id: `job:${index}`,
    jobId: 'job',
    index,
    blob: new Blob(),
    imageWidth: 2_000,
    imageHeight: 1_600,
    scrollX: 0,
    scrollY,
    viewportWidth: 1_000,
    viewportHeight: 800,
    captureX: 0,
    captureY: 0,
    captureWidth: 1_000,
    captureHeight: 800,
    documentWidth: 1_000,
    documentHeight: 2_050,
    overlayIds: [],
  }
}

/** A scroller inset below a 100px header and beside a 200px rail, as in an app-shell layout. */
function containerSegment(index: number, scrollY: number): StoredSegment {
  return {
    ...segment(index, scrollY),
    captureX: 200,
    captureY: 100,
    captureWidth: 800,
    captureHeight: 700,
    documentHeight: 1_500,
  }
}

function resizedSegment(index: number, scrollY: number): StoredSegment {
  return {
    ...segment(index, scrollY),
    imageWidth: 1_800,
    viewportWidth: 900,
  }
}

describe('createStitchPlan', () => {
  it('derives scale from actual image and viewport dimensions', () => {
    const plan = createStitchPlan([segment(0, 0)], 800)
    expect(plan.scaleX).toBe(2)
    expect(plan.scaleY).toBe(2)
    expect(plan.width).toBe(2_000)
    expect(plan.height).toBe(1_600)
  })

  it('places an overlapping final segment at its actual scroll offset', () => {
    const plan = createStitchPlan([segment(0, 0), segment(1, 800), segment(2, 1_250)], 2_050)
    expect(plan.height).toBe(4_100)
    expect(plan.placements.map((placement) => placement.destinationY)).toEqual([0, 1_600, 3_200])
    expect(plan.placements[2]?.sourceY).toBe(700)
  })

  it('assembles a very long page that the previous 32,767 px ceiling rejected', () => {
    const plan = createStitchPlan([segment(0, 0)], 20_000)
    expect(plan.height).toBe(40_000)
  })

  it('assembles past the single-canvas height limit, because no canvas holds the full height', () => {
    // 100,000 CSS px at scale 2 is 200,000 output px — over three times Chrome's 65,535 per-axis
    // limit, and the exact case that used to be refused here after being truncated at capture time.
    const plan = createStitchPlan([segment(0, 0)], 100_000)
    expect(plan.height).toBe(200_000)
    expect(planTiles(plan.height)).toHaveLength(25)
  })

  it('still rejects a result too wide for one tile', () => {
    // The width limit is the tile's: 2^28 / 8,192 = 32,768, not the 65,535 per-axis limit.
    const wide = { ...segment(0, 0), imageWidth: 40_000, captureWidth: 20_000, viewportWidth: 20_000 }
    expect(() => createStitchPlan([wide], 800)).toThrow(/wider/i)
  })

  it('rejects viewport resizing even when image scale is unchanged', () => {
    expect(() => createStitchPlan([segment(0, 0), resizedSegment(1, 800)], 1_600)).toThrow(
      /viewport changed/i,
    )
  })

  it('crops every segment to a nested scroll container instead of the whole viewport', () => {
    const plan = createStitchPlan([containerSegment(0, 0), containerSegment(1, 700)], 1_400)
    expect(plan.width).toBe(1_600)
    expect(plan.height).toBe(2_800)
    expect(plan.placements.map((placement) => placement.sourceX)).toEqual([400, 400])
    expect(plan.placements.map((placement) => placement.sourceWidth)).toEqual([1_600, 1_600])
    expect(plan.placements.map((placement) => placement.sourceY)).toEqual([200, 200])
    expect(plan.placements.map((placement) => placement.destinationY)).toEqual([0, 1_400])
    expect(plan.placements.map((placement) => placement.destinationHeight)).toEqual([1_400, 1_400])
  })

  it('steps a container by its visible height and crops the overlapping final segment', () => {
    const plan = createStitchPlan(
      [containerSegment(0, 0), containerSegment(1, 700), containerSegment(2, 1_100)],
      1_800,
    )
    expect(plan.placements[2]?.sourceY).toBe(800)
    expect(plan.placements[2]?.destinationY).toBe(2_800)
    expect(plan.placements[2]?.destinationHeight).toBe(800)
  })

  it('rejects a scroll container that moves horizontally between segments', () => {
    const shifted = { ...containerSegment(1, 700), captureX: 240 }
    expect(() => createStitchPlan([containerSegment(0, 0), shifted], 1_400)).toThrow(/viewport changed/i)
  })

  it('uses equivalent source and destination crop heights', () => {
    const plan = createStitchPlan([segment(0, 0), segment(1, 800), segment(2, 1_250)], 1_900)
    const finalPlacement = plan.placements[2]
    expect(finalPlacement?.sourceHeight).toBe(finalPlacement?.destinationHeight)
    expect(finalPlacement?.destinationY).toBe(3_200)
    expect(finalPlacement?.destinationHeight).toBe(600)
  })
})

describe('planTiles', () => {
  it('splits a tall image into bands that tile the full height without gaps or overlap', () => {
    const bands = planTiles(20_000, 8_192)
    expect(bands).toHaveLength(3)
    expect(bands[0]).toEqual({ offsetY: 0, height: 8_192 })
    expect(bands[1]).toEqual({ offsetY: 8_192, height: 8_192 })
    expect(bands[2]).toEqual({ offsetY: 16_384, height: 3_616 })

    let covered = 0
    for (const band of bands) {
      expect(band.offsetY).toBe(covered)
      covered += band.height
    }
    expect(covered).toBe(20_000)
  })

  it('returns a single band when the image is shorter than one tile', () => {
    expect(planTiles(1_200, 8_192)).toEqual([{ offsetY: 0, height: 1_200 }])
  })

  it('does not emit a zero-height band when the height divides exactly', () => {
    const bands = planTiles(16_384, 8_192)
    expect(bands).toHaveLength(2)
    expect(bands.every((band) => band.height > 0)).toBe(true)
  })

  it('rejects an empty image', () => {
    expect(() => planTiles(0)).toThrow(/empty/i)
  })
})
