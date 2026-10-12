import { describe, expect, it } from 'vitest'
import { stackBlurRegion } from '../src/editor/stackblur'

/** A solid RGBA image, every pixel `value`. */
function solid(width: number, height: number, value: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = value
    pixels[i + 1] = value
    pixels[i + 2] = value
    pixels[i + 3] = 255
  }
  return pixels
}

describe('stackBlurRegion', () => {
  it('leaves a uniform region unchanged at any radius', () => {
    const pixels = solid(20, 20, 100)
    stackBlurRegion(pixels, 20, 20, { x: 2, y: 2, w: 16, h: 16 }, 5)
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(100)
      expect(pixels[i + 3]).toBe(255)
    }
  })

  it('is a no-op at radius 0', () => {
    const pixels = solid(10, 10, 7)
    const before = Uint8ClampedArray.from(pixels)
    stackBlurRegion(pixels, 10, 10, { x: 0, y: 0, w: 10, h: 10 }, 0)
    expect(Array.from(pixels)).toEqual(Array.from(before))
  })

  it('averages a sharp edge symmetrically in the region middle', () => {
    const width = 40
    const height = 20
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = x < 20 ? 0 : 200
        const p = (y * width + x) * 4
        pixels[p] = value
        pixels[p + 1] = value
        pixels[p + 2] = value
        pixels[p + 3] = 255
      }
    }
    stackBlurRegion(pixels, width, height, { x: 0, y: 0, w: width, h: height }, 5)
    // Far from the edge each side keeps its own value; at the edge the window averages both.
    const sample = (x: number) => pixels[(10 * width + x) * 4]
    expect(sample(2)).toBeLessThan(10)
    expect(sample(38)).toBeGreaterThan(190)
    const edge = sample(20)
    expect(edge).toBeGreaterThan(60)
    expect(edge).toBeLessThan(140)
  })

  it('never touches pixels outside the region', () => {
    const width = 30
    const height = 30
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = (x * 7 + y * 3) % 256
        const p = (y * width + x) * 4
        pixels[p] = value
        pixels[p + 1] = value
        pixels[p + 2] = value
        pixels[p + 3] = 255
      }
    }
    const before = Uint8ClampedArray.from(pixels)
    stackBlurRegion(pixels, width, height, { x: 5, y: 5, w: 10, h: 10 }, 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inside = x >= 5 && x < 15 && y >= 5 && y < 15
        if (!inside) {
          const p = (y * width + x) * 4
          expect(pixels[p]).toBe(before[p])
          expect(pixels[p + 3]).toBe(before[p + 3])
        }
      }
    }
  })

  it('keeps channel values within the region range', () => {
    const width = 20
    const height = 20
    const pixels = new Uint8ClampedArray(width * height * 4)
    let min = 255
    let max = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (i * 13) % 256
      pixels[i] = value
      pixels[i + 1] = value
      pixels[i + 2] = value
      pixels[i + 3] = 255
      if (value < min) min = value
      if (value > max) max = value
    }
    stackBlurRegion(pixels, width, height, { x: 0, y: 0, w: width, h: height }, 3)
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i]).toBeGreaterThanOrEqual(min)
      expect(pixels[i]).toBeLessThanOrEqual(max)
    }
  })

  it('clamps a region larger than the image instead of throwing', () => {
    const pixels = solid(8, 8, 50)
    expect(() => stackBlurRegion(pixels, 8, 8, { x: -10, y: -10, w: 100, h: 100 }, 6)).not.toThrow()
  })
})
