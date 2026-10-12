import { fullImageCrop } from './crop-geometry'
import {
  DEFAULT_PDF_OPTIONS,
  documentRectToPdf,
  planPdfPages,
  type PdfOptions,
  type PdfPagePlan,
} from './pdf-layout'
import { horizontalScaleFor } from './helvetica-widths'
import { renderCrop, type TiledImage } from './stitcher'
import type { PageContent } from '../shared/page-content'

export interface PdfLink {
  href: string
  x: number
  y: number
  width: number
  height: number
}

export interface PdfTextRun {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface PdfPage {
  jpeg: Uint8Array
  imageWidth: number
  imageHeight: number
  pageWidth: number
  pageHeight: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
  links: PdfLink[]
  runs: PdfTextRun[]
}

export interface PdfSource {
  image: TiledImage
  content?: PageContent
  imageOrigin?: { x: number; y: number }
  /**
   * Image pixels per document CSS pixel, for placing the content layers.
   *
   * Falls back to the assembled image's own scale, which is right whenever the segments carried a
   * real viewport -- but wrong for a visible-area or on-screen-region capture, whose segment records
   * the screenshot's pixel size as its viewport and therefore reports a scale of 1 on a Retina
   * screen. See `CaptureJob.imageScale`.
   */
  imageScale?: { x: number; y: number }
}

/** The scale content rectangles are placed by: measured against the live page where we have it. */
export function contentScale(source: PdfSource): { x: number; y: number } {
  const scale = source.imageScale
  if (scale && scale.x > 0 && scale.y > 0) return scale
  return { x: source.image.scaleX, y: source.image.scaleY }
}

/**
 * Each page is rendered straight from the tiles, so a PDF of a very long capture never needs the
 * whole image in memory at once — only one page-sized slice.
 */
export async function createPdfBlob(
  source: PdfSource,
  crop = fullImageCrop(source.image.width, source.image.height),
  options: PdfOptions = DEFAULT_PDF_OPTIONS,
): Promise<Blob> {
  const plans = planPdfPages(crop, options)
  const pages: PdfPage[] = []

  for (const plan of plans) {
    const slice = await renderCrop(source.image, plan.source)
    const encoded = await slice.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    pages.push({
      jpeg: new Uint8Array(await encoded.arrayBuffer()),
      imageWidth: plan.source.width,
      imageHeight: plan.source.height,
      pageWidth: plan.pageWidth,
      pageHeight: plan.pageHeight,
      drawX: plan.drawX,
      drawY: plan.drawY,
      drawWidth: plan.drawWidth,
      drawHeight: plan.drawHeight,
      links: options.directLinks ? linksFor(plan, source) : [],
      runs: options.textSearchable ? runsFor(plan, source) : [],
    })
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }

  // The chunks are handed to Blob as-is. Joining them first would copy the entire PDF a second time,
  // and PDF is now the export for captures no single image can hold — exactly where a redundant
  // full-size copy is least affordable.
  return new Blob(buildPdfChunks(pages) as BlobPart[], { type: 'application/pdf' })
}

function linksFor(plan: PdfPagePlan, source: PdfSource): PdfLink[] {
  const origin = source.imageOrigin ?? { x: 0, y: 0 }
  const scale = contentScale(source)
  const links: PdfLink[] = []
  for (const link of source.content?.links ?? []) {
    for (const rect of link.rects) {
      const placed = documentRectToPdf(rect, plan, scale.x, scale.y, origin)
      if (placed) links.push({ href: link.href, ...placed })
    }
  }
  return links
}

function runsFor(plan: PdfPagePlan, source: PdfSource): PdfTextRun[] {
  const origin = source.imageOrigin ?? { x: 0, y: 0 }
  const scale = contentScale(source)
  const runs: PdfTextRun[] = []
  for (const run of source.content?.runs ?? []) {
    const placed = documentRectToPdf(run, plan, scale.x, scale.y, origin)
    if (placed) runs.push({ text: run.text, ...placed })
  }
  return runs
}

export function buildPdf(pages: PdfPage[]): Uint8Array {
  return joinBytes(...buildPdfChunks(pages))
}

/** Object numbers are allocated up front so every reference can be written before its target. */
function buildPdfChunks(pages: PdfPage[]): Uint8Array[] {
  const encoder = new TextEncoder()
  const objects = new Map<number, Uint8Array>()
  const pageReferences: string[] = []

  const wantsText = pages.some((page) => page.runs.length > 0)
  const hrefs = [...new Set(pages.flatMap((page) => page.links.map((link) => link.href)))]

  // 1 catalog, 2 pages tree, 3 font (only when there is text), then per page: page, image, content,
  // then one action per distinct href and one annotation per placed link.
  const fontObject = 3
  let next = wantsText ? 4 : 3
  const actionObjects = new Map<string, number>()
  for (const href of hrefs) actionObjects.set(href, next++)

  objects.set(1, encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'))
  if (wantsText) {
    // A base-14 font, so nothing has to be embedded. The text is invisible, so its shapes never
    // matter — only that a reader can search and select it.
    objects.set(
      fontObject,
      encoder.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    )
  }
  for (const [href, objectNumber] of actionObjects) {
    objects.set(objectNumber, encoder.encode(`<< /Type /Action /S /URI /URI (${escapePdfString(href)}) >>`))
  }

  for (const page of pages) {
    const pageObject = next++
    const imageObject = next++
    const contentObject = next++
    const annotationObjects: number[] = []
    for (const link of page.links) {
      const action = actionObjects.get(link.href)
      if (action === undefined) continue
      const objectNumber = next++
      annotationObjects.push(objectNumber)
      objects.set(
        objectNumber,
        encoder.encode(
          `<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${number(link.x)} ${number(link.y)} ` +
            `${number(link.x + link.width)} ${number(link.y + link.height)}] /A ${action} 0 R >>`,
        ),
      )
    }

    pageReferences.push(`${pageObject} 0 R`)
    const resources =
      `<< /XObject << /Im0 ${imageObject} 0 R >>` + (page.runs.length > 0 ? ` /Font << /F0 ${fontObject} 0 R >>` : '') + ' >>'
    const annotations = annotationObjects.length > 0 ? ` /Annots [${annotationObjects.map((id) => `${id} 0 R`).join(' ')}]` : ''
    objects.set(
      pageObject,
      encoder.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(page.pageWidth)} ${number(page.pageHeight)}]` +
          ` /Resources ${resources} /Contents ${contentObject} 0 R${annotations} >>`,
      ),
    )
    objects.set(
      imageObject,
      streamObject(
        encoder,
        `/Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        page.jpeg,
      ),
    )
    objects.set(contentObject, streamObject(encoder, '', encoder.encode(contentStream(page))))
  }
  objects.set(2, encoder.encode(`<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pages.length} >>`))

  const objectCount = next - 1
  const chunks: Uint8Array[] = [encoder.encode('%PDF-1.4\n%PageShotter\n')]
  const offsets = new Array<number>(objectCount + 1).fill(0)
  let byteOffset = chunks[0]?.length ?? 0
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    const body = objects.get(objectNumber)
    if (!body) throw new Error('PDF object assembly failed.')
    offsets[objectNumber] = byteOffset
    const chunk = joinBytes(encoder.encode(`${objectNumber} 0 obj\n`), body, encoder.encode('\nendobj\n'))
    chunks.push(chunk)
    byteOffset += chunk.length
  }

  const xrefOffset = byteOffset
  const xref = [
    `xref\n0 ${objectCount + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  ].join('')
  chunks.push(encoder.encode(xref))
  return chunks
}

/**
 * The picture, then the invisible text over it.
 *
 * `3 Tr` is PDF's "render neither fill nor stroke": the glyphs are laid down, contribute to search
 * and selection, and paint nothing. That is the whole searchable-PDF trick, and it is why the text
 * layer cannot spoil the screenshot however wrong its metrics are.
 */
function contentStream(page: PdfPage): string {
  const commands = [
    `q\n${number(page.drawWidth)} 0 0 ${number(page.drawHeight)} ${number(page.drawX)} ${number(page.drawY)} cm\n/Im0 Do\nQ`,
  ]
  if (page.runs.length === 0) return commands.join('\n')

  commands.push('BT', '3 Tr')
  for (const run of page.runs) {
    const written = escapePdfString(run.text)
    if (written === '') continue
    // The box is a line box, so it is taller than the glyphs in it. Cap height is around 0.72 em for
    // Helvetica, and the baseline sits about a fifth of the box up from its bottom.
    const size = Math.max(1, run.height * 0.72)
    // Measured against real Helvetica metrics, so the invisible run spans exactly the box the
    // visible words occupied. Estimating this is what made a selection stop short of the last
    // character: the glyphs ran past the words, so a drag across them missed the final one.
    const stretch = horizontalScaleFor(run.text, size, run.width)
    commands.push(
      `/F0 ${number(size)} Tf ${number(stretch)} Tz 1 0 0 1 ${number(run.x)} ${number(run.y + run.height * 0.22)} Tm (${written}) Tj`,
    )
  }
  commands.push('ET')
  return commands.join('\n')
}

/**
 * PDF strings escape backslash and both parentheses; anything outside WinAnsi cannot be written in
 * this encoding at all, and is dropped rather than mojibaked.
 *
 * That is a real limit: a page in a non-Latin script gets a PDF whose text layer is mostly empty.
 * Fixing it properly means embedding a font subset with a CID encoding, which is a great deal of
 * machinery for a layer nobody can see. The picture is unaffected either way.
 */
function escapePdfString(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\\' || character === '(' || character === ')') out += `\\${character}`
    else if (code >= 32 && code <= 126) out += character
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`
    else if (code === 9 || code === 10 || code === 13) out += ' '
  }
  return out
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

function streamObject(encoder: TextEncoder, dictionary: string, bytes: Uint8Array): Uint8Array {
  return joinBytes(
    encoder.encode(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    encoder.encode('\nendstream'),
  )
}

function joinBytes(...chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}
