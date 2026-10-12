import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  fitZoom,
  zoomIn,
  zoomOut,
  zoomedWidth,
  zoomPercentLabel,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../src/result/zoom-math'

describe('zoom', () => {
  it('stops at both ends instead of running away', () => {
    expect(clampZoom(50)).toBe(ZOOM_MAX)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('keeps steps on whole percentages', () => {
    // 0.2 + 0.1 is 0.30000000000000004 in binary floating point, which would render as 30% while
    // sizing the preview from a different number.
    expect(zoomIn(0.2)).toBe(0.3)
    expect(zoomOut(0.3)).toBe(0.2)
    expect(zoomPercentLabel(zoomIn(0.2))).toBe('30%')
  })

  it('cannot step past the ends', () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX)
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN)
  })

  it('fits a wide capture to the stage', () => {
    expect(fitZoom(1000, 48, 1440)).toBe(0.66)
  })

  it('never enlarges a narrow capture, because the preview must show real pixels', () => {
    expect(fitZoom(1400, 48, 400)).toBe(1)
  })

  it('survives a stage too narrow to show anything', () => {
    expect(fitZoom(20, 48, 1440)).toBe(ZOOM_MIN)
    expect(fitZoom(1000, 48, 0)).toBe(1)
  })

  it('renders at least one pixel, whatever the arithmetic says', () => {
    expect(zoomedWidth(1440, 0.5)).toBe(720)
    expect(zoomedWidth(0, 1)).toBe(1)
  })
})
