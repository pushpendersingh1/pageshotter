import { describe, expect, it } from 'vitest'
import { buildPdf, type PdfPage } from '../src/result/pdf-export'

const A4_WIDTH = 595.28
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

function page(overrides: Partial<PdfPage> = {}): PdfPage {
  const pageHeight = overrides.pageHeight ?? 400
  return {
    jpeg,
    imageWidth: 100,
    imageHeight: 200,
    pageWidth: A4_WIDTH,
    pageHeight,
    drawX: 0,
    drawY: 0,
    drawWidth: A4_WIDTH,
    drawHeight: pageHeight,
    links: [],
    runs: [],
    ...overrides,
  }
}

function decode(pages: PdfPage[]): string {
  return new TextDecoder().decode(buildPdf(pages))
}

function mediaBoxHeights(text: string): number[] {
  return [...text.matchAll(/\/MediaBox \[0 0 [\d.]+ ([\d.]+)\]/g)].map((match) => Number(match[1]))
}

describe('buildPdf', () => {
  it('creates a self-contained PDF with one image object per page', () => {
    const text = decode([page(), page({ pageHeight: 100 })])
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/Count 2')
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2)
    expect(text.endsWith('%%EOF')).toBe(true)
  })

  it('numbers the xref for exactly the objects it wrote', () => {
    // 1 catalog + 1 page tree + 3 per page, and nothing else when there are no links or text.
    const text = decode([page(), page()])
    expect(text).toContain('xref\n0 9')
  })

  /*
   * The whitespace regression, made impossible to reintroduce silently.
   *
   * Pages were fixed at A4 with the image pinned to the top, so a short capture produced one page of
   * mostly blank paper and every multi-page capture ended in a part-blank sheet. The old test passed
   * throughout, because it never looked at the MediaBox.
   */
  it('writes each page at the size it was planned, not a fixed sheet', () => {
    expect(mediaBoxHeights(decode([page({ pageHeight: 841.89 }), page({ pageHeight: 212.5 })]))).toEqual([
      841.89, 212.5,
    ])
  })

  it('draws the image where the plan put it', () => {
    const text = decode([page({ pageHeight: 800, drawHeight: 300, drawY: 500 })])
    // Width is written with three decimals; the parts that matter here are the scale and translate.
    expect(text).toContain('0 0 300 0 500 cm\n/Im0 Do\nQ')
  })
})

describe('direct links', () => {
  const link = { href: 'https://example.com/a', x: 10, y: 20, width: 100, height: 12 }

  it('writes one URI action and a link annotation over the picture', () => {
    const text = decode([page({ links: [link] })])
    expect(text).toContain('/Type /Action /S /URI /URI (https://example.com/a)')
    expect(text).toContain('/Subtype /Link')
    // Rect is [x y x+w y+h] — the annotation must cover the words, not sit at the origin.
    expect(text).toContain('/Rect [10 20 110 32]')
    expect(text).toMatch(/\/Annots \[\d+ 0 R\]/)
  })

  it('shares one action between every occurrence of the same address', () => {
    const text = decode([page({ links: [link, { ...link, y: 60 }] }), page({ links: [{ ...link, y: 90 }] })])
    expect(text.match(/\/S \/URI/g)).toHaveLength(1)
    expect(text.match(/\/Subtype \/Link/g)).toHaveLength(3)
  })

  it('writes no annotation entry at all for a page without links', () => {
    expect(decode([page()])).not.toContain('/Annots')
  })

  it('escapes the characters that would otherwise end the PDF string early', () => {
    const text = decode([page({ links: [{ ...link, href: 'https://example.com/a(b)c\\d' }] })])
    expect(text).toContain('(https://example.com/a\\(b\\)c\\\\d)')
  })
})

describe('searchable text', () => {
  const run = { text: 'Hello world', x: 10, y: 20, width: 60, height: 10 }

  it('lays the text down invisibly, so it can never spoil the picture', () => {
    const text = decode([page({ runs: [run] })])
    // 3 Tr is "render neither fill nor stroke" — the whole searchable-PDF trick.
    expect(text).toContain('BT')
    expect(text).toContain('3 Tr')
    expect(text).toContain('(Hello world) Tj')
    expect(text).toContain('ET')
  })

  it('embeds nothing, using a base-14 font the reader already has', () => {
    const text = decode([page({ runs: [run] })])
    expect(text).toContain('/BaseFont /Helvetica')
    expect(text).toContain('/Font << /F0 3 0 R >>')
    expect(text).not.toContain('/FontFile')
  })

  it('declares no font at all when nothing asked for text', () => {
    const text = decode([page()])
    expect(text).not.toContain('/BaseFont')
    expect(text).not.toContain('/Font <<')
  })

  it('drops characters WinAnsi cannot represent instead of writing mojibake', () => {
    const text = decode([page({ runs: [{ ...run, text: 'price 12 € and é' }] })])
    // The euro sign is outside WinAnsi's Latin-1 range here and goes; the e-acute survives, octal-escaped.
    expect(text).toContain('(price 12  and \\351) Tj')
  })

  it('turns a newline inside a run into a space rather than breaking the stream', () => {
    const text = decode([page({ runs: [{ ...run, text: 'two\nlines' }] })])
    expect(text).toContain('(two lines) Tj')
  })

  it('stretches each run to the width it occupied, so selection lands on the right words', () => {
    const scaleOf = (text: string): number => Number(/([\d.]+) Tz/.exec(text)?.[1])
    // Both inside the clamp, so this measures the mapping rather than the guard.
    const wide = scaleOf(decode([page({ runs: [{ ...run, width: 60 }] })]))
    const narrow = scaleOf(decode([page({ runs: [{ ...run, width: 30 }] })]))
    expect(wide).toBeGreaterThan(narrow)
    // Measured against real metrics rather than estimated: doubling the box doubles the scale.
    expect(wide).toBeCloseTo(narrow * 2, 3)
  })

  it('skips a run whose text survives escaping as nothing, rather than writing an empty Tj', () => {
    const text = decode([page({ runs: [{ ...run, text: '\u4f60\u597d' }] })])
    expect(text).not.toContain('() Tj')
  })
})
