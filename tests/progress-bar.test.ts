import { describe, expect, it } from 'vitest'
import { filledSegments, MAX_SEGMENTS, segmentCount } from '../src/popup/progress-bar'

describe('segmentCount', () => {
  it('draws one segment per section while they fit', () => {
    expect(segmentCount(1)).toBe(1)
    expect(segmentCount(12)).toBe(12)
    expect(segmentCount(MAX_SEGMENTS)).toBe(MAX_SEGMENTS)
  })

  it('caps the bar, which is what stopped it widening the popup window', () => {
    // The reported case: 124 sections drew 123 gaps of 3px, an unshrinkable 369px in a 360px popup.
    expect(segmentCount(124)).toBe(MAX_SEGMENTS)
    expect(segmentCount(200)).toBe(MAX_SEGMENTS)
  })

  it('draws nothing rather than something meaningless when there is no count', () => {
    expect(segmentCount(0)).toBe(0)
    expect(segmentCount(-3)).toBe(0)
    expect(segmentCount(Number.NaN)).toBe(0)
    expect(segmentCount(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('filledSegments', () => {
  it('fills in proportion once a segment stands for several sections', () => {
    const segments = segmentCount(124)
    expect(filledSegments(62, 124, segments)).toBe(20)
    expect(filledSegments(124, 124, segments)).toBe(segments)
  })

  it('lights the first segment on the first section, so the bar never looks stalled', () => {
    // A bar that has visibly not started while sections are visibly being taken reads as broken.
    expect(filledSegments(1, 124, segmentCount(124))).toBe(1)
    expect(filledSegments(1, 200, segmentCount(200))).toBe(1)
  })

  it('is exact when every section has its own segment', () => {
    for (let current = 0; current <= 12; current += 1) {
      expect(filledSegments(current, 12, 12)).toBe(current)
    }
  })

  it('cannot ask for a segment that is not drawn when a page outgrows its estimate', () => {
    // A growing page overshoots its own denominator; the bar must clamp rather than index past end.
    expect(filledSegments(300, 124, segmentCount(124))).toBe(MAX_SEGMENTS)
  })

  it('is empty before anything has been taken', () => {
    expect(filledSegments(0, 124, 40)).toBe(0)
    expect(filledSegments(Number.NaN, 124, 40)).toBe(0)
    expect(filledSegments(5, 0, 40)).toBe(0)
    expect(filledSegments(5, 124, 0)).toBe(0)
  })
})
