import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PDF_OPTIONS,
  FIT_PAGE_WIDTH,
  PDF_MAX_PAGE_POINTS,
  PDF_PAPERS,
  documentRectToPdf,
  planPdfPages,
  presentedPdfOptions,
  unsplitPageProblem,
  type PdfOptions,
} from '../src/result/pdf-layout'
import { contentScale } from '../src/result/pdf-export'

const options = (overrides: Partial<PdfOptions> = {}): PdfOptions => ({ ...DEFAULT_PDF_OPTIONS, ...overrides })
const crop = (width: number, height: number, x = 0, y = 0) => ({ x, y, width, height })

describe('a presented PDF (one fit-to-content page, no text layer)', () => {
  it('is one page of the framed picture’s shape, whatever the stored options say', () => {
    const stored = options({ splitToPages: true, pageSize: 'letter', directLinks: true, textSearchable: true })
    const presented = presentedPdfOptions(stored)
    expect(presented).toMatchObject({ pageSize: 'fit', splitToPages: false, directLinks: false, textSearchable: false })
    const pages = planPdfPages(crop(1328, 928), presented)
    expect(pages).toHaveLength(1)
    const [page] = pages
    expect(page?.pageWidth).toBe(FIT_PAGE_WIDTH)
    expect((page?.pageHeight ?? 0) / (page?.pageWidth ?? 1)).toBeCloseTo(928 / 1328)
    expect(page).toMatchObject({ drawX: 0, drawY: 0, drawWidth: page?.pageWidth, drawHeight: page?.pageHeight })
    expect(page?.source).toEqual(crop(1328, 928))
  })

  it('is refused rather than drawn when the framed picture is taller than a PDF page allows', () => {
    const presented = presentedPdfOptions(DEFAULT_PDF_OPTIONS)
    expect(unsplitPageProblem(crop(1328, 928), presented)).toBeUndefined()
    const tooTall = Math.ceil((PDF_MAX_PAGE_POINTS / FIT_PAGE_WIDTH) * 1000) + 1000
    expect(unsplitPageProblem(crop(1000, tooTall), presented)).toBeDefined()
  })
})

describe('planPdfPages', () => {
  it('fits a short capture to one page with no blank paper', () => {
    const [page, ...rest] = planPdfPages(crop(840, 520), options())
    expect(rest).toHaveLength(0)
    expect(page?.pageWidth).toBe(FIT_PAGE_WIDTH)
    // 520/840 of the page width, and the page is exactly that tall.
    expect(page?.pageHeight).toBeCloseTo((520 / 840) * FIT_PAGE_WIDTH, 3)
    expect(page?.pageHeight).toBeCloseTo(page?.drawHeight ?? 0, 6)
    expect(page?.drawY).toBeCloseTo(0, 6)
  })

  it('cuts a long capture into pages whose last one ends with the picture', () => {
    const pages = planPdfPages(crop(1_000, 3_000), options())
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.pageHeight).toBeCloseTo(page.drawHeight, 6)
    const last = pages.at(-1)
    expect(last?.source.height).toBeLessThan(pages[0]?.source.height ?? 0)
    expect(last?.drawY).toBeCloseTo(0, 6)
  })

  it('covers every row of the capture exactly once', () => {
    const pages = planPdfPages(crop(1_000, 3_000, 0, 500), options())
    expect(pages[0]?.source.y).toBe(500)
    for (let index = 1; index < pages.length; index += 1) {
      const previous = pages[index - 1]
      expect(pages[index]?.source.y).toBe((previous?.source.y ?? 0) + (previous?.source.height ?? 0))
    }
    const last = pages.at(-1)
    expect((last?.source.y ?? 0) + (last?.source.height ?? 0)).toBe(3_500)
  })

  it('puts the whole capture on one page when splitting is off', () => {
    const pages = planPdfPages(crop(1_000, 9_000), options({ splitToPages: false }))
    expect(pages).toHaveLength(1)
    expect(pages[0]?.source.height).toBe(9_000)
    expect(pages[0]?.pageHeight).toBeCloseTo(9 * FIT_PAGE_WIDTH, 3)
  })

  it('keeps real paper at its real size and lets the last sheet run short of picture', () => {
    const pages = planPdfPages(crop(1_000, 3_000), options({ pageSize: 'letter' }))
    for (const page of pages) {
      expect(page.pageWidth).toBe(PDF_PAPERS.letter.width)
      expect(page.pageHeight).toBe(PDF_PAPERS.letter.height)
    }
    // Every sheet is full height; the short final slice sits at the top, so its drawY is positive.
    expect(pages.at(-1)?.drawY).toBeGreaterThan(1)
    // A full sheet is not *exactly* full: the slice height is floored to whole image pixels, so it
    // falls short by well under a tenth of a point — a thousandth of an inch, below any printer's
    // resolution. Stretching the slice to close it would distort the picture to hide a gap nobody
    // can see, so the gap is asserted as small rather than absent.
    expect(pages[0]?.drawY).toBeLessThan(0.1)
  })

  it('honours a named paper width even unsplit, without inventing a sheet height', () => {
    const [page] = planPdfPages(crop(1_000, 2_000), options({ splitToPages: false, pageSize: 'legal' }))
    expect(page?.pageWidth).toBe(PDF_PAPERS.legal.width)
    expect(page?.pageHeight).toBeCloseTo(2 * PDF_PAPERS.legal.width, 3)
  })

  it('never draws a slice taller than the page holding it', () => {
    for (const size of ['fit', 'a4', 'letter', 'legal'] as const) {
      for (const page of planPdfPages(crop(1_234, 7_777), options({ pageSize: size }))) {
        expect(page.drawHeight).toBeLessThanOrEqual(page.pageHeight + 1e-6)
        expect(page.drawY).toBeGreaterThanOrEqual(-1e-6)
      }
    }
  })

  it('produces one page for a capture shorter than a single sheet', () => {
    expect(planPdfPages(crop(1_000, 10), options({ pageSize: 'a4' }))).toHaveLength(1)
  })
})

describe('unsplitPageProblem', () => {
  it('says nothing while splitting is on, however long the capture', () => {
    expect(unsplitPageProblem(crop(1_000, 500_000), options())).toBeUndefined()
  })

  it('says nothing for an unsplit capture that fits inside the format limit', () => {
    expect(unsplitPageProblem(crop(1_000, 9_000), options({ splitToPages: false }))).toBeUndefined()
  })

  it('refuses an unsplit capture past 200 inches rather than writing a file readers disagree about', () => {
    const tooTall = Math.ceil((PDF_MAX_PAGE_POINTS / FIT_PAGE_WIDTH) * 1_000) + 1_000
    const problem = unsplitPageProblem(crop(1_000, tooTall), options({ splitToPages: false }))
    expect(problem).toContain('Split to pages')
  })
})

describe('documentRectToPdf', () => {
  // One fitted page of a 1000x2000 capture taken at scale 2, so the document is 500x1000 CSS px.
  const singlePage = planPdfPages(crop(1_000, 2_000), options({ splitToPages: false }))[0]!
  const origin = { x: 0, y: 0 }

  it('flips the y axis, so a rect at the top of the page is at the top of the page', () => {
    const placed = documentRectToPdf({ x: 0, y: 0, width: 500, height: 10 }, singlePage, 2, 2, origin)
    expect(placed?.y).toBeCloseTo(singlePage.pageHeight - placed!.height, 6)
  })

  it('scales document CSS pixels through the capture scale', () => {
    const placed = documentRectToPdf({ x: 250, y: 0, width: 250, height: 10 }, singlePage, 2, 2, origin)
    // Half way across the document is half way across the page.
    expect(placed?.x).toBeCloseTo(singlePage.pageWidth / 2, 6)
    expect(placed?.width).toBeCloseTo(singlePage.pageWidth / 2, 6)
  })

  it('subtracts the image origin, so a band capture places its links correctly', () => {
    const banded = planPdfPages(crop(1_000, 2_000, 0, 0), options({ splitToPages: false }))[0]!
    const placed = documentRectToPdf({ x: 0, y: 400, width: 500, height: 10 }, banded, 2, 2, { x: 0, y: 400 })
    expect(placed?.y).toBeCloseTo(banded.pageHeight - placed!.height, 6)
  })

  it('returns nothing for a rect that is not on this page', () => {
    const pages = planPdfPages(crop(1_000, 4_000), options())
    const firstPageOnly = { x: 0, y: 0, width: 100, height: 10 }
    expect(documentRectToPdf(firstPageOnly, pages[0]!, 2, 2, origin)).toBeDefined()
    expect(documentRectToPdf(firstPageOnly, pages[1]!, 2, 2, origin)).toBeUndefined()
  })

  it('clips a rect straddling a break so it is clickable on both pages, not neither', () => {
    const pages = planPdfPages(crop(1_000, 4_000), options())
    const breakPx = pages[0]!.source.height
    // A link 40 image px tall, centred on the break between page one and page two.
    const straddling = { x: 0, y: (breakPx - 20) / 2, width: 100, height: 20 }
    const onFirst = documentRectToPdf(straddling, pages[0]!, 2, 2, origin)
    const onSecond = documentRectToPdf(straddling, pages[1]!, 2, 2, origin)
    expect(onFirst).toBeDefined()
    expect(onSecond).toBeDefined()
    expect((onFirst?.height ?? 0) + (onSecond?.height ?? 0)).toBeCloseTo(
      (40 * pages[0]!.drawHeight) / pages[0]!.source.height,
      4,
    )
  })

  it('ignores a degenerate rect rather than emitting a zero-size annotation', () => {
    expect(documentRectToPdf({ x: 0, y: 0, width: 0, height: 10 }, singlePage, 2, 2, origin)).toBeUndefined()
    expect(documentRectToPdf({ x: 0, y: 0, width: 10, height: 0 }, singlePage, 2, 2, origin)).toBeUndefined()
  })
})

describe('the scale the content layers are placed by', () => {
  // The defect this covers: a visible-area or on-screen-region capture stores the screenshot's own
  // pixel size as its segment's viewport, so the assembled image reports scaleX/scaleY of 1 whatever
  // the device pixel ratio is. Page content is measured in CSS pixels. Placing it by that 1 on a
  // Retina screen put every word at half position and half size, and clipped them out of a region
  // crop completely -- which is why the PDF had no selectable text at all for those two modes, and
  // was correct for a full-page capture, whose segments carry a real viewport.
  const retinaVisibleCapture = {
    image: { width: 2_000, height: 1_200, scaleX: 1, scaleY: 1, tiles: [] },
    imageScale: { x: 2, y: 2 },
  }

  it('prefers the scale measured against the live page', () => {
    expect(contentScale(retinaVisibleCapture as never)).toEqual({ x: 2, y: 2 })
  })

  it('falls back to the image scale, which is right wherever the segments carried a real viewport', () => {
    const fullPage = { image: { width: 2_000, height: 9_000, scaleX: 2, scaleY: 2, tiles: [] } }
    expect(contentScale(fullPage as never)).toEqual({ x: 2, y: 2 })
  })

  it('ignores a nonsense scale rather than placing everything at zero', () => {
    const broken = { image: { scaleX: 2, scaleY: 2 }, imageScale: { x: 0, y: 0 } }
    expect(contentScale(broken as never)).toEqual({ x: 2, y: 2 })
  })

  it('places a word on the picture at scale 2, and off it at scale 1', () => {
    // A 2000x1200 image of a 1000x600 CSS viewport. The word sits in the lower right of the page.
    const page = planPdfPages(crop(2_000, 1_200), options({ splitToPages: false }))[0]!
    const word = { x: 900, y: 550, width: 60, height: 14 }

    const correct = documentRectToPdf(word, page, 2, 2, { x: 0, y: 0 })
    expect(correct).toBeDefined()
    // Nine tenths across the page, near the bottom of it.
    expect(correct!.x / page.pageWidth).toBeCloseTo(0.9, 2)
    expect(correct!.y / page.pageHeight).toBeLessThan(0.15)

    // The bug: at scale 1 the same word lands in the upper-left quadrant, over different pixels.
    const wrong = documentRectToPdf(word, page, 1, 1, { x: 0, y: 0 })
    expect(wrong!.x / page.pageWidth).toBeCloseTo(0.45, 2)
    expect(wrong!.x).toBeLessThan(correct!.x)
  })

  it('drops a word out of a region crop entirely at the wrong scale, which reads as no text at all', () => {
    // A region crop covering the lower right of the same image.
    const page = planPdfPages(crop(1_000, 600, 1_000, 600), options({ splitToPages: false }))[0]!
    const word = { x: 900, y: 550, width: 60, height: 14 }

    expect(documentRectToPdf(word, page, 2, 2, { x: 0, y: 0 })).toBeDefined()
    expect(documentRectToPdf(word, page, 1, 1, { x: 0, y: 0 })).toBeUndefined()
  })
})
