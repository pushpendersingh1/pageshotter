import { describe, expect, it } from 'vitest'

import {
  CLIP_HIDDEN_PX,
  MIN_CONTENT_PX,
  captureRectFor,
  cssClipSize,
  intersectRect,
  searchableText,
  toContentRects,
  wordSpans,
  type ClientRectLike,
  type PageContent,
} from '../src/shared/page-content'

/**
 * A `DOMRectList` stand-in: array-like, indexable, and deliberately **not** iterable — which is what
 * Chrome actually hands back from `getClientRects()`. `for...of` over one throws, and that is how
 * link and text collection silently produced nothing for every capture: the throw was swallowed by
 * the best-effort catch and read as "this page has no content".
 */
function rectList(...rects: ClientRectLike[]): ArrayLike<ClientRectLike> {
  const list: Record<number, ClientRectLike> & { length: number } = { length: rects.length }
  rects.forEach((rect, index) => {
    list[index] = rect
  })
  return list
}

const rect = (over: Partial<ClientRectLike> = {}): ClientRectLike => ({
  left: 10,
  top: 20,
  width: 100,
  height: 16,
  ...over,
})

describe('toContentRects', () => {
  it('reads an array-like that has no iterator, which is what the DOM returns', () => {
    const list = rectList(rect())
    expect(Symbol.iterator in list).toBe(false)
    expect(toContentRects(list, 0, 0)).toEqual([{ x: 10, y: 20, width: 100, height: 16 }])
  })

  it('adds the scroll offset, putting rects in document space', () => {
    expect(toContentRects(rectList(rect()), 5, 1_000)).toEqual([{ x: 15, y: 1_020, width: 100, height: 16 }])
  })

  it('keeps every line of a wrapped element, because one box would put the words in the wrong place', () => {
    const wrapped = rectList(rect({ top: 20 }), rect({ top: 40 }), rect({ top: 60 }))
    expect(toContentRects(wrapped, 0, 0)).toHaveLength(3)
  })

  it('drops spacers and rounding artefacts', () => {
    const noisy = rectList(rect(), rect({ width: MIN_CONTENT_PX - 1 }), rect({ height: 0 }))
    expect(toContentRects(noisy, 0, 0)).toHaveLength(1)
  })

  it('returns nothing for an element that occupies nothing', () => {
    expect(toContentRects(rectList(), 0, 0)).toEqual([])
  })
})

describe('wordSpans', () => {
  const words = (text: string): string[] => wordSpans(text).map((span) => text.slice(span.from, span.to))

  it('splits on whitespace and reports offsets into the original string', () => {
    expect(words('the quick brown fox')).toEqual(['the', 'quick', 'brown', 'fox'])
    expect(wordSpans('ab cd')).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ])
  })

  it('does not invent empty words around runs of whitespace', () => {
    expect(words('  a \n\t b  ')).toEqual(['a', 'b'])
    expect(words('   ')).toEqual([])
    expect(words('')).toEqual([])
  })

  it('keeps punctuation attached, because a PDF reader selects by box, not by grammar', () => {
    expect(words('Addresses that must be skipped.')).toEqual(['Addresses', 'that', 'must', 'be', 'skipped.'])
  })

  it('treats a non-breaking space as a space, which is how the browser lays it out', () => {
    expect(words('a b')).toEqual(['a', 'b'])
  })
})

describe('intersectRect', () => {
  const box = (left: number, top: number, width: number, height: number): ClientRectLike => ({
    left,
    top,
    width,
    height,
  })

  it('returns the overlap', () => {
    expect(intersectRect(box(0, 0, 100, 100), box(50, 50, 100, 100))).toEqual({
      left: 50,
      top: 50,
      width: 50,
      height: 50,
    })
  })

  it('returns nothing for boxes that miss, so clipped-away text is dropped rather than moved', () => {
    expect(intersectRect(box(0, 0, 10, 10), box(20, 0, 10, 10))).toBeUndefined()
    expect(intersectRect(box(0, 0, 10, 10), box(0, 20, 10, 10))).toBeUndefined()
  })

  it('treats a touching edge as no overlap, since a zero-area box is not visible text', () => {
    expect(intersectRect(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBeUndefined()
  })

  it('keeps a box wholly inside its clip unchanged', () => {
    expect(intersectRect(box(20, 20, 10, 10), box(0, 0, 100, 100))).toEqual(box(20, 20, 10, 10))
  })
})

describe('captureRectFor', () => {
  /**
   * The boundary of what the text layer may describe. Everything outside it is cropped out of every
   * screenshot, so a word there is in no segment of the picture -- and since it also sits outside
   * the scrolling target, it does not move with it, so each pass records it somewhere new and the
   * harvest's position-matched dedup cannot collapse the copies. That is how the fixture page's own
   * nav reached a PDF twelve times, once per segment, marching down a document it never appeared in.
   */
  it('is the scroller box for a nested capture, which is what excludes the page chrome around it', () => {
    const geometry = { captureX: 0, captureY: 305, captureWidth: 1200, captureHeight: 507, offsetX: 0, offset: 0 }
    expect(captureRectFor(geometry)).toEqual({ left: 0, top: 305, width: 1200, height: 507 })

    // The fixture's nav sat at viewport y 160-305, wholly above the scroller.
    expect(intersectRect({ left: 24, top: 205, width: 79, height: 24 }, captureRectFor(geometry)))
      .toBeUndefined()
  })

  it('keeps text inside the band, so clipping costs the capture nothing it photographed', () => {
    const geometry = { captureX: 0, captureY: 305, captureWidth: 1200, captureHeight: 507, offsetX: 0, offset: 0 }
    expect(intersectRect({ left: 59, top: 400, width: 120, height: 19 }, captureRectFor(geometry)))
      .toEqual({ left: 59, top: 400, width: 120, height: 19 })
  })

  it('is the whole viewport for a document capture, where captureX and captureY are 0', () => {
    const geometry = { captureX: 0, captureY: 0, captureWidth: 1280, captureHeight: 800, offsetX: 0, offset: 4_000 }
    expect(captureRectFor(geometry)).toEqual({ left: 0, top: 0, width: 1280, height: 800 })
  })

  it('is measured in viewport coordinates, not image space, so the scroll offset does not move it', () => {
    const top = { captureX: 40, captureY: 305, captureWidth: 600, captureHeight: 507, offsetX: 0, offset: 0 }
    const deep = { ...top, offset: 9_000 }
    expect(captureRectFor(deep)).toEqual(captureRectFor(top))
  })
})

describe('cssClipSize', () => {
  it('reads the screen-reader-only idiom in both spacings', () => {
    expect(cssClipSize('rect(0px, 0px, 0px, 0px)')).toEqual({ width: 0, height: 0 })
    expect(cssClipSize('rect(1px 1px 1px 1px)')).toEqual({ width: 0, height: 0 })
  })

  it('measures a clip that is trimming rather than hiding', () => {
    expect(cssClipSize('rect(0px, 200px, 100px, 0px)')).toEqual({ width: 200, height: 100 })
  })

  it('returns nothing for a value that is not a rect', () => {
    expect(cssClipSize('auto')).toBeUndefined()
    expect(cssClipSize('rect(0px, 0px)')).toBeUndefined()
    expect(cssClipSize('rect(a, b, c, d)')).toBeUndefined()
  })

  it('draws the hidden line where the sr-only idiom sits and ordinary trimming does not', () => {
    const hidden = cssClipSize('rect(0px, 0px, 0px, 0px)')!
    const trimming = cssClipSize('rect(0px, 200px, 100px, 0px)')!
    expect(hidden.width).toBeLessThan(CLIP_HIDDEN_PX)
    expect(trimming.width).toBeGreaterThanOrEqual(CLIP_HIDDEN_PX)
  })
})

describe('searchableText', () => {
  const content = (...texts: string[]): PageContent => ({
    links: [],
    runs: texts.map((text, index) => ({ x: 0, y: index * 20, width: 50, height: 16, text })),
  })

  it('folds the runs into one lowercase string history can search', () => {
    expect(searchableText(content('Quarterly', 'Revenue'))).toBe('quarterly revenue')
  })

  it('says each word once, because the index is for finding a capture, not reproducing it', () => {
    expect(searchableText(content('the', 'the', 'The'))).toBe('the')
  })

  it('splits runs that still hold several words', () => {
    expect(searchableText(content('alpha beta'))).toBe('alpha beta')
  })

  it('stops at the cap rather than letting one page of prose fill the budget', () => {
    const long = content(...Array.from({ length: 500 }, (_, index) => `word${index}`))
    const capped = searchableText(long, 40)
    expect(capped.length).toBeLessThanOrEqual(40)
    expect(capped.startsWith('word0 word1')).toBe(true)
  })

  it('has nothing to say about a capture with no text', () => {
    expect(searchableText({ links: [], runs: [] })).toBe('')
  })
})
