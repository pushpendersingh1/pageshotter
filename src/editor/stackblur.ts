/**
 * StackBlur over a region of RGBA pixels — the kernel behind the editor's Blur tool. The algorithm
 * is the classic sliding-window stack (three box passes composed into one Gaussian-like pass; the
 * approach is public domain in its original statement by Mario Klingemann, and this implementation
 * is ours, written against the sub-region contract below).
 *
 * **It blurs the render target, not the capture.** An earlier design sampled the pristine capture
 * specifically so overlapping blurs could not compound; the scene model makes that the
 * opposite of what is wanted — a blur blurs everything rendered beneath it, so two overlapping
 * blurs compound and that is the honest consequence. The kernel survived that change unaltered
 * because it never knew what it was reading: it takes whatever pixels it is handed. What changed is
 * who hands them over.
 *
 * Why not `ctx.filter = 'blur(...)'`: the filter blurs *past the region edge*, sampling nothing
 * outside the box but bleeding its interior over the surrounding pixels when composited back, and
 * it is untestable in plain Node. This function works on the raw `Uint8ClampedArray` the canvas
 * hands back from `getImageData`, in place, touching exactly the region given — so a blur box can
 * be re-edited, and everything outside the box is provably untouched.
 *
 * Edge pixels extend their neighbours (clamp), the way every image editor treats a border, rather
 * than sampling transparent black the canvas filter would pull in.
 */

/** Indexed reads go through this: `noUncheckedIndexedAccess` makes every direct read possibly undefined. */
function read(pixels: Uint8ClampedArray, index: number): number {
  return pixels[index] ?? 0
}

export interface BlurRegion {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Blurs `region` of `pixels` in place. `pixels` is the full image's RGBA data; the region is
 * clamped to the image. A radius below 1 leaves the region unchanged, and a region larger than the
 * image is simply clamped.
 */
export function stackBlurRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  region: BlurRegion,
  radius: number,
): void {
  if (radius < 1 || width <= 0 || height <= 0) return
  const x0 = Math.max(0, Math.floor(region.x))
  const y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(width, Math.ceil(region.x + region.w))
  const y1 = Math.min(height, Math.ceil(region.y + region.h))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return

  const effectiveRadius = Math.min(Math.floor(radius), Math.floor(Math.min(w, h) / 2))
  if (effectiveRadius < 1) return

  // Three stacked box passes; the sliding window makes each pass O(w) per row.
  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurH(pixels, width, x0, y0, w, h, effectiveRadius)
    boxBlurV(pixels, width, x0, y0, w, h, effectiveRadius)
  }
}

function boxBlurH(
  pixels: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  radius: number,
): void {
  const windowSize = radius * 2 + 1
  const row = new Float32Array(w * 4)
  for (let y = y0; y < y0 + h; y += 1) {
    const rowIndex = y * width
    // Sliding sums per channel, seeded from the clamped left edge.
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let i = -radius; i <= radius; i += 1) {
      const xi = x0 + Math.min(w - 1, Math.max(0, i))
      const p = (rowIndex + xi) * 4
      r += read(pixels, p)
      g += read(pixels, p + 1)
      b += read(pixels, p + 2)
      a += read(pixels, p + 3)
    }
    for (let x = 0; x < w; x += 1) {
      const o = x * 4
      row[o] = r / windowSize
      row[o + 1] = g / windowSize
      row[o + 2] = b / windowSize
      row[o + 3] = a / windowSize
      const outX = x0 + Math.max(0, x - radius)
      const inX = x0 + Math.min(w - 1, x + radius + 1)
      const pOut = (rowIndex + outX) * 4
      const pIn = (rowIndex + inX) * 4
      r += read(pixels, pIn) - read(pixels, pOut)
      g += read(pixels, pIn + 1) - read(pixels, pOut + 1)
      b += read(pixels, pIn + 2) - read(pixels, pOut + 2)
      a += read(pixels, pIn + 3) - read(pixels, pOut + 3)
    }
    for (let x = 0; x < w; x += 1) {
      const p = (rowIndex + x0 + x) * 4
      const o = x * 4
      pixels[p] = row[o] ?? 0
      pixels[p + 1] = row[o + 1] ?? 0
      pixels[p + 2] = row[o + 2] ?? 0
      pixels[p + 3] = row[o + 3] ?? 0
    }
  }
}

function boxBlurV(
  pixels: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  radius: number,
): void {
  const windowSize = radius * 2 + 1
  const col = new Float32Array(h * 4)
  for (let x = x0; x < x0 + w; x += 1) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let i = -radius; i <= radius; i += 1) {
      const yi = y0 + Math.min(h - 1, Math.max(0, i))
      const p = (yi * width + x) * 4
      r += read(pixels, p)
      g += read(pixels, p + 1)
      b += read(pixels, p + 2)
      a += read(pixels, p + 3)
    }
    for (let y = 0; y < h; y += 1) {
      const o = y * 4
      col[o] = r / windowSize
      col[o + 1] = g / windowSize
      col[o + 2] = b / windowSize
      col[o + 3] = a / windowSize
      const outY = y0 + Math.max(0, y - radius)
      const inY = y0 + Math.min(h - 1, y + radius + 1)
      const pOut = (outY * width + x) * 4
      const pIn = (inY * width + x) * 4
      r += read(pixels, pIn) - read(pixels, pOut)
      g += read(pixels, pIn + 1) - read(pixels, pOut + 1)
      b += read(pixels, pIn + 2) - read(pixels, pOut + 2)
      a += read(pixels, pIn + 3) - read(pixels, pOut + 3)
    }
    for (let y = 0; y < h; y += 1) {
      const p = ((y0 + y) * width + x) * 4
      const o = y * 4
      pixels[p] = col[o] ?? 0
      pixels[p + 1] = col[o + 1] ?? 0
      pixels[p + 2] = col[o + 2] ?? 0
      pixels[p + 3] = col[o + 3] ?? 0
    }
  }
}
