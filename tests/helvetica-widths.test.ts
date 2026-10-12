import { describe, expect, it } from 'vitest'

import { helveticaWidth, horizontalScaleFor } from '../src/result/helvetica-widths'

describe('helveticaWidth', () => {
  it('matches the published AFM metrics for a known string', () => {
    // H 722 + i 222 + space 278 = 1222 thousandths of an em.
    expect(helveticaWidth('Hi ', 1_000)).toBeCloseTo(1_222, 6)
  })

  it('scales linearly with the point size', () => {
    expect(helveticaWidth('Hello', 24)).toBeCloseTo(helveticaWidth('Hello', 12) * 2, 6)
  })

  it('gives narrow characters less room than wide ones, which is the whole point', () => {
    expect(helveticaWidth('lllll', 12)).toBeLessThan(helveticaWidth('mmmmm', 12))
  })

  it('measures an empty string as nothing', () => {
    expect(helveticaWidth('', 12)).toBe(0)
  })

  it('falls back for characters outside the table rather than measuring them as zero', () => {
    expect(helveticaWidth('é', 12)).toBeGreaterThan(0)
  })
})

describe('horizontalScaleFor', () => {
  /*
   * The regression this exists for: the natural width used to be estimated as half the point size
   * per character, so a run's invisible glyphs did not span the words on screen and a selection
   * dragged across the visible text came back a character short.
   */
  it('returns exactly 100 when the text already spans its box', () => {
    const text = 'Addresses that must be skipped'
    expect(horizontalScaleFor(text, 12, helveticaWidth(text, 12))).toBeCloseTo(100, 6)
  })

  it('stretches to a wider box and squeezes into a narrower one', () => {
    const natural = helveticaWidth('Hello', 12)
    expect(horizontalScaleFor('Hello', 12, natural * 2)).toBeCloseTo(200, 6)
    expect(horizontalScaleFor('Hello', 12, natural / 2)).toBeCloseTo(50, 6)
  })

  it('clamps a nonsensical box rather than emitting a scale readers refuse', () => {
    expect(horizontalScaleFor('x', 12, 100_000)).toBe(400)
    expect(horizontalScaleFor('a very long run of text indeed', 12, 0.01)).toBe(10)
  })

  it('leaves the scale alone when there is nothing to measure against', () => {
    expect(horizontalScaleFor('', 12, 50)).toBe(100)
    expect(horizontalScaleFor('Hello', 12, 0)).toBe(100)
  })
})
