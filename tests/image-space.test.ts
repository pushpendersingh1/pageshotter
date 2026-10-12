import { describe, expect, it } from 'vitest'
import {
  containerCaptureGeometry,
  documentCaptureGeometry,
} from '../src/shared/scroll-geometry'
import { contentScrollOffset, imageOriginFor, viewportToImage } from '../src/shared/page-content'

/**
 * The PDF text layer is placed at `harvestedRect - imageOrigin`. These tests pin the identity that
 * has to hold for that to land on the picture: harvesting with `contentScrollOffset` and subtracting
 * `imageOriginFor` must reproduce `viewportToImage` exactly, for both kinds of capture target.
 */
function placed(point: { x: number; y: number }, geometry: Parameters<typeof viewportToImage>[1]) {
  const scroll = contentScrollOffset(geometry)
  const origin = imageOriginFor(geometry)
  // What the content script stores, then what the PDF writer subtracts.
  return { x: point.x + scroll.x - origin.x, y: point.y + scroll.y - origin.y }
}

describe('a document that scrolls', () => {
  const geometry = documentCaptureGeometry(0, 900, 1280, 800, 1280, 12_000)

  it('places a viewport point at its document coordinate', () => {
    expect(viewportToImage({ x: 100, y: 50 }, geometry)).toEqual({ x: 100, y: 950 })
  })

  it('is unchanged by the fix: the offsets are still the window scroll and the origin is still zero', () => {
    expect(contentScrollOffset(geometry)).toEqual({ x: 0, y: 900 })
    expect(imageOriginFor(geometry)).toEqual({ x: 0, y: 0 })
  })

  it('round-trips', () => {
    expect(placed({ x: 100, y: 50 }, geometry)).toEqual(viewportToImage({ x: 100, y: 50 }, geometry))
  })
})

describe('a nested scroller, which is what was broken', () => {
  // A chat-style app shell: the scroller starts 64px down the viewport and is scrolled a long way.
  const geometry = containerCaptureGeometry({
    paddingLeft: 0,
    paddingTop: 64,
    clientWidth: 1280,
    clientHeight: 700,
    scrollLeft: 0,
    scrollTop: 5_000,
    scrollWidth: 1280,
    scrollHeight: 30_000,
    viewportWidth: 1280,
    viewportHeight: 800,
  })

  it('places a point by the container, not by the window', () => {
    // 64px down the viewport is the very top of the scroller, which is 5,000px into the capture.
    expect(viewportToImage({ x: 0, y: 64 }, geometry)).toEqual({ x: 0, y: 5_000 })
    expect(viewportToImage({ x: 0, y: 364 }, geometry)).toEqual({ x: 0, y: 5_300 })
  })

  it('reports the container offset, which window.scrollY never knew', () => {
    // The old harvest used window.scrollY, which on a page like this is 0 -- a 5,000px error.
    expect(contentScrollOffset(geometry)).toEqual({ x: 0, y: 5_000 })
    expect(imageOriginFor(geometry)).toEqual({ x: 0, y: 64 })
  })

  it('round-trips', () => {
    for (const point of [{ x: 0, y: 64 }, { x: 640, y: 400 }, { x: 1279, y: 763 }]) {
      expect(placed(point, geometry)).toEqual(viewportToImage(point, geometry))
    }
  })
})

describe('a nested scroller partly above the viewport', () => {
  const geometry = containerCaptureGeometry({
    paddingLeft: 0,
    // Negative: the container's own top has been scrolled off the top of the window.
    paddingTop: -120,
    clientWidth: 1280,
    clientHeight: 1000,
    scrollLeft: 0,
    scrollTop: 2_000,
    scrollWidth: 1280,
    scrollHeight: 20_000,
    viewportWidth: 1280,
    viewportHeight: 800,
  })

  it('accounts for the clipped part, so the first visible row is not off by it', () => {
    expect(geometry.clippedTop).toBe(120)
    // The top of the window shows content 2,120px into the container.
    expect(viewportToImage({ x: 0, y: 0 }, geometry)).toEqual({ x: 0, y: 2_120 })
    expect(imageOriginFor(geometry)).toEqual({ x: 0, y: 0 })
  })

  it('round-trips', () => {
    expect(placed({ x: 10, y: 300 }, geometry)).toEqual(viewportToImage({ x: 10, y: 300 }, geometry))
  })
})
