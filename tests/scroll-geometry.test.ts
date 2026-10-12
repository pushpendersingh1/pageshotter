import { describe, expect, it } from 'vitest'
import {
  classifyOverlay,
  containerCaptureGeometry,
  containerScrollTopFor,
  documentCaptureGeometry,
  scrollSettleOutcome,
  overlapsCaptureRect,
  overlayHiddenInSegment,
  OVERLAY_ANCHOR_TOLERANCE_PX,
  type ContainerBox,
} from '../src/shared/scroll-geometry'
import { nextScrollY } from '../src/shared/capture-plan'

/** A scroller filling the viewport below a 100px app header. */
function box(overrides: Partial<ContainerBox> = {}): ContainerBox {
  return {
    paddingLeft: 0,
    paddingTop: 100,
    clientWidth: 1_000,
    clientHeight: 700,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 1_000,
    scrollHeight: 3_000,
    viewportWidth: 1_000,
    viewportHeight: 800,
    ...overrides,
  }
}

describe('documentCaptureGeometry', () => {
  it('captures the whole viewport and reports the document offset', () => {
    const geometry = documentCaptureGeometry(0, 640, 1_000, 800, 1_000, 2_400)
    expect(geometry).toMatchObject({
      offset: 640,
      captureX: 0,
      captureY: 0,
      captureWidth: 1_000,
      captureHeight: 800,
      contentHeight: 2_400,
      clippedTop: 0,
    })
  })
})

describe('classifyOverlay', () => {
  // The capture area of an app shell: full width, starting 100px down under a header.
  const capture = { captureY: 100, captureWidth: 1_000, captureHeight: 700 }

  it('treats a bar pinned to the top of the capture area as a header', () => {
    expect(classifyOverlay({ top: 100, bottom: 156, width: 1_000, height: 56 }, capture)).toBe('top')
  })

  it('treats a header that starts above the capture area as a header', () => {
    expect(classifyOverlay({ top: 0, bottom: 56, width: 1_000, height: 56 }, capture)).toBe('top')
  })

  it('treats a ChatGPT-style composer pinned to the bottom as content-covering chrome', () => {
    expect(classifyOverlay({ top: 660, bottom: 790, width: 760, height: 130 }, capture)).toBe('other')
  })

  it('treats a floating chat button as content-covering chrome', () => {
    expect(classifyOverlay({ top: 726, bottom: 780, width: 54, height: 54 }, capture)).toBe('other')
  })

  it('treats a full-height fixed rail as content-covering chrome', () => {
    expect(classifyOverlay({ top: 100, bottom: 800, width: 260, height: 700 }, capture)).toBe('other')
  })

  it('never suppresses an element the size of the capture area itself', () => {
    expect(classifyOverlay({ top: 100, bottom: 800, width: 1_000, height: 700 }, capture)).toBe('shell')
  })
})

describe('containerCaptureGeometry', () => {
  it('crops to the container and reports its scroll offset as the content offset', () => {
    const geometry = containerCaptureGeometry(box({ scrollTop: 1_400 }))
    expect(geometry).toMatchObject({
      offset: 1_400,
      captureX: 0,
      captureY: 100,
      captureWidth: 1_000,
      captureHeight: 700,
      contentHeight: 3_000,
      clippedTop: 0,
    })
  })

  it('shifts the content offset when the container is clipped above the viewport', () => {
    const geometry = containerCaptureGeometry(box({ paddingTop: -60, scrollTop: 500 }))
    expect(geometry.clippedTop).toBe(60)
    expect(geometry.offset).toBe(560)
    expect(geometry.captureY).toBe(0)
    expect(geometry.captureHeight).toBe(640)
    expect(containerScrollTopFor(geometry.offset, geometry.clippedTop)).toBe(500)
  })

  it('limits the content height to what scrolling can actually expose', () => {
    // The container is 700 tall but only 400 of it is on screen, so 300px never becomes visible.
    const geometry = containerCaptureGeometry(box({ paddingTop: 400 }))
    expect(geometry.captureHeight).toBe(400)
    expect(geometry.contentHeight).toBe(2_700)
  })

  it('reports nothing capturable when the container is off screen', () => {
    const geometry = containerCaptureGeometry(box({ paddingTop: 900 }))
    expect(geometry.captureWidth).toBe(1_000)
    expect(geometry.captureHeight).toBe(0)
  })

  it('walks a container to its last segment without overrunning the content', () => {
    const offsets: number[] = []
    let geometry = containerCaptureGeometry(box())
    let offset: number | null = geometry.offset
    while (offset !== null) {
      offsets.push(offset)
      offset = nextScrollY(offset, geometry.captureHeight, geometry.contentHeight)
      if (offset === null) break
      geometry = containerCaptureGeometry(
        box({ scrollTop: containerScrollTopFor(offset, geometry.clippedTop) }),
      )
      offset = geometry.offset
    }
    expect(offsets).toEqual([0, 700, 1_400, 2_100, 2_300])
    expect(offsets.at(-1)! + geometry.captureHeight).toBe(geometry.contentHeight)
  })
})

describe('documentCaptureGeometry scrollbar gutters', () => {
  it('captures the whole viewport when scrollbars are hidden', () => {
    const geometry = documentCaptureGeometry(0, 0, 1_280, 800, 1_280, 4_000)
    expect(geometry.captureWidth).toBe(1_280)
    expect(geometry.captureHeight).toBe(800)
  })

  it('crops a reserved vertical scrollbar gutter out of every segment', () => {
    const geometry = documentCaptureGeometry(0, 400, 1_280, 800, 1_265, 4_000, 15, 0)
    expect(geometry.captureWidth).toBe(1_265)
    expect(geometry.captureHeight).toBe(800)
    // The crop must not disturb the offset the stitcher places the segment at.
    expect(geometry.offset).toBe(400)
    expect(geometry.captureX).toBe(0)
  })

  it('crops a horizontal scrollbar gutter off the bottom of the capture rect', () => {
    const geometry = documentCaptureGeometry(0, 0, 1_280, 800, 2_000, 4_000, 0, 15)
    expect(geometry.captureHeight).toBe(785)
  })

  it('ignores a negative or absent gutter', () => {
    const geometry = documentCaptureGeometry(0, 0, 1_280, 800, 1_280, 4_000, -20, -5)
    expect(geometry.captureWidth).toBe(1_280)
    expect(geometry.captureHeight).toBe(800)
  })
})

describe('classifyOverlay height boundary', () => {
  const capture = { captureY: 100, captureWidth: 1_000, captureHeight: 700 }

  it('classifies a top-anchored header just under half the capture height as a header', () => {
    expect(classifyOverlay({ top: 100, bottom: 445, width: 1_000, height: 345 }, capture)).toBe('top')
  })

  /** Regression for the `tall-fixed-header` fixture, which is 55% of the viewport. */
  it('classifies a top-anchored header taller than half the capture height as a header', () => {
    expect(classifyOverlay({ top: 100, bottom: 485, width: 1_000, height: 385 }, capture)).toBe('top')
  })

  it('classifies a header just under the rail threshold as a header', () => {
    expect(classifyOverlay({ top: 100, bottom: 693, width: 1_000, height: 593 }, capture)).toBe('top')
  })

  it('still classifies a full-height rail as content-covering chrome', () => {
    expect(classifyOverlay({ top: 100, bottom: 800, width: 260, height: 700 }, capture)).toBe('other')
  })

  it('classifies a nearly full-height rail as content-covering chrome', () => {
    expect(classifyOverlay({ top: 100, bottom: 730, width: 260, height: 630 }, capture)).toBe('other')
  })
})

describe('overlapsCaptureRect', () => {
  // A nested scroller inset below a 48px header, as an app shell lays one out.
  const capture = { captureX: 296, captureY: 48, captureWidth: 1144, captureHeight: 764 }

  it('catches a header backdrop that reaches past the header into the scroll area', () => {
    // The real shape of the bug: 72px tall, so its bottom 24px sit over the capture.
    expect(overlapsCaptureRect({ top: 0, bottom: 72, left: 0, right: 1428 }, capture)).toBe(true)
  })

  it('does not count a header that stops exactly where the capture begins', () => {
    // Touching is not overlapping, or every app shell's header would be treated as painted over it.
    expect(overlapsCaptureRect({ top: 0, bottom: 48, left: 0, right: 1428 }, capture)).toBe(false)
  })

  it('leaves a sidebar beside the scroller alone', () => {
    expect(overlapsCaptureRect({ top: 0, bottom: 812, left: 0, right: 296 }, capture)).toBe(false)
  })

  it('catches a bottom bar overlapping the foot of the scroll area', () => {
    expect(overlapsCaptureRect({ top: 780, bottom: 900, left: 296, right: 1440 }, capture)).toBe(true)
  })

  it('ignores anything entirely below or above the capture', () => {
    expect(overlapsCaptureRect({ top: 812, bottom: 900, left: 296, right: 1440 }, capture)).toBe(false)
    expect(overlapsCaptureRect({ top: -100, bottom: 0, left: 296, right: 1440 }, capture)).toBe(false)
  })
})

describe('overlayHiddenInSegment', () => {
  it('shows a top overlay in the segment that starts the capture', () => {
    expect(overlayHiddenInSegment('top', false, 0)).toBe(false)
  })

  it('suppresses a top overlay discovered after the first segment', () => {
    // The Google Search shape: the header is static flow content at offset 0, photographed once,
    // and only becomes fixed once scrolling starts -- discovered at segment two. Showing it there
    // stamped a second copy right below a seam.
    expect(overlayHiddenInSegment('top', false, 800)).toBe(true)
  })

  it('suppresses a top overlay again even if it was never marked seen', () => {
    expect(overlayHiddenInSegment('top', false, 1_600)).toBe(true)
  })

  it('still suppresses a top overlay that was already drawn at the top', () => {
    expect(overlayHiddenInSegment('top', true, 0)).toBe(true)
    expect(overlayHiddenInSegment('top', true, 800)).toBe(true)
  })

  it('always suppresses an other-anchored overlay, wherever it was discovered', () => {
    expect(overlayHiddenInSegment('other', false, 0)).toBe(true)
    expect(overlayHiddenInSegment('other', true, 800)).toBe(true)
  })

  it('counts the first segment as the top for a page parked just off zero', () => {
    expect(overlayHiddenInSegment('top', false, OVERLAY_ANCHOR_TOLERANCE_PX)).toBe(false)
    expect(overlayHiddenInSegment('top', false, OVERLAY_ANCHOR_TOLERANCE_PX + 1)).toBe(true)
  })
})

describe('scrollSettleOutcome', () => {
  /*
   * This is what separates a person from a page. Before it, a nudge of the wheel during a segment's
   * settle either aborted the capture with a scroll-gap error blaming the page, or -- scrolling
   * backward -- silently produced a wrong segment.
   */
  it('accepts a position that landed where it was asked to', () => {
    expect(scrollSettleOutcome(4_000, 4_000, 20_000, 800)).toBe('settled')
    expect(scrollSettleOutcome(4_000, 4_001, 20_000, 800)).toBe('settled')
  })

  it('reports drift in either direction, because backward drift is the silent one', () => {
    expect(scrollSettleOutcome(4_000, 5_200, 20_000, 800)).toBe('drifted')
    expect(scrollSettleOutcome(4_000, 2_800, 20_000, 800)).toBe('drifted')
  })

  it('does not call the bottom of a shortened page drift', () => {
    // The plan asked for 19,200 but content collapsed during the capture, so the scroller stops at
    // 9,200. That position is correct, and retrying it would spend every attempt on it.
    expect(scrollSettleOutcome(19_200, 9_200, 10_000, 800)).toBe('settled')
  })

  it('still reports drift near the bottom when the target was reachable', () => {
    expect(scrollSettleOutcome(9_200, 8_000, 10_000, 800)).toBe('drifted')
  })

  it('handles a page shorter than the viewport without inventing a negative floor', () => {
    expect(scrollSettleOutcome(0, 0, 400, 800)).toBe('settled')
    expect(scrollSettleOutcome(600, 0, 400, 800)).toBe('settled')
  })
})
