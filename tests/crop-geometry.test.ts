import { describe, expect, it } from 'vitest'

import { fullImageCrop } from '../src/result/crop-geometry'

describe('fullImageCrop', () => {
  it('is the whole image, so export paths take one code path with or without a crop', () => {
    expect(fullImageCrop(1_600, 40_000)).toEqual({ x: 0, y: 0, width: 1_600, height: 40_000 })
  })
})
