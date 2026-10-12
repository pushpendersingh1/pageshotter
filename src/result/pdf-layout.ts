/**
 * How a capture is laid out on paper, as pure functions over numbers.
 *
 * Everything the PDF options change is arithmetic — which pixels land on which page, how big that
 * page is, and where a link or a word ends up once it has been through both — so all of it lives
 * here where vitest can reach it. The writer takes the plan and only serialises it.
 *
 * Three coordinate spaces meet in this file, and confusing them is the whole risk:
 *
 *  - **document CSS pixels**, which is where links and text are measured on the live page;
 *  - **image pixels**, which is what the capture is, at the capture scale (DPR × browser zoom);
 *  - **PDF points**, y-up from the bottom-left of each page, which is where they have to end up.
 */

import type { CropRect } from './crop-geometry'

export type PdfPageSizeName = 'fit' | 'a4' | 'letter' | 'legal'

export interface PdfPaper {
  width: number
  height: number
}

/** Named papers, in points at 72dpi. `fit` has no fixed size, so it is not in here. */
export const PDF_PAPERS: Record<Exclude<PdfPageSizeName, 'fit'>, PdfPaper> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
}

/**
 * The width a fitted page is rendered at.
 *
 * A capture has no inherent physical size, so something has to decide how many points wide it is.
 * A4's width keeps a fitted PDF the same width as a paper one, which means switching the option
 * changes the pagination and nothing else — the picture does not also jump in scale.
 */
export const FIT_PAGE_WIDTH = PDF_PAPERS.a4.width

/**
 * The largest page any PDF reader is required to handle: 200 inches, from the PDF specification's
 * user-space limit. A single unsplit page for a very long capture can exceed it, and a reader's
 * response to that is silent misbehaviour, so it is checked rather than risked.
 */
export const PDF_MAX_PAGE_POINTS = 14_400

export interface PdfOptions {
  /** False puts the whole capture on one page. */
  splitToPages: boolean
  pageSize: PdfPageSizeName
  directLinks: boolean
  /** An invisible text layer, so the PDF can be searched and its text selected. */
  textSearchable: boolean
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  splitToPages: true,
  pageSize: 'fit',
  directLinks: false,
  textSearchable: false,
}

/**
 * What a PDF of a presented capture is written with, whatever the stored options say: one page exactly
 * the shape of the framed picture, and no text or link layers, which describe the source page rather
 * than a browser frame drawn around it: one fit-to-content page, no text layer.
 */
export function presentedPdfOptions(options: PdfOptions): PdfOptions {
  return { ...options, pageSize: 'fit', splitToPages: false, directLinks: false, textSearchable: false }
}

export interface PdfPagePlan {
  /** The slice of the image this page shows, in image pixels. */
  source: CropRect
  /** The page's own size, in points. */
  pageWidth: number
  pageHeight: number
  /** Where the slice is drawn on the page, in points, y-up from the page's bottom-left. */
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
}

/**
 * Cuts a cropped capture into pages.
 *
 * The two options are deliberately orthogonal, because they answer different questions. **Page
 * size** asks what the paper is: `fit` means the page is the picture and nothing is padded, a named
 * paper means real sheets, which necessarily means the last one has blank space at the bottom — that
 * is what paper is, and choosing it is choosing that. **Split** asks whether there is more than one
 * page at all.
 *
 * So an unsplit fitted export is one page exactly the shape of the capture, and an unsplit named
 * export is one page of that paper's width and whatever height the picture needs.
 */
export function planPdfPages(crop: CropRect, options: PdfOptions): PdfPagePlan[] {
  const paper = options.pageSize === 'fit' ? undefined : PDF_PAPERS[options.pageSize]
  const pageWidth = paper?.width ?? FIT_PAGE_WIDTH
  const scale = pageWidth / crop.width
  const wholeHeight = crop.height * scale

  if (!options.splitToPages) {
    return [
      {
        source: { ...crop },
        pageWidth,
        pageHeight: wholeHeight,
        drawX: 0,
        drawY: 0,
        drawWidth: pageWidth,
        drawHeight: wholeHeight,
      },
    ]
  }

  // How many image pixels fit on one page, worked out from the paper's proportions. Floor, so a
  // rounded-up slice can never be drawn taller than the page that holds it.
  const paperHeight = paper?.height ?? (FIT_PAGE_WIDTH * PDF_PAPERS.a4.height) / PDF_PAPERS.a4.width
  const sourcePageHeight = Math.max(1, Math.floor(crop.width * (paperHeight / pageWidth)))

  const pages: PdfPagePlan[] = []
  const cropBottom = crop.y + crop.height
  for (let sourceY = crop.y; sourceY < cropBottom; sourceY += sourcePageHeight) {
    const sliceHeight = Math.min(sourcePageHeight, cropBottom - sourceY)
    const drawHeight = sliceHeight * scale
    // On real paper the sheet keeps its height and a short final slice sits at the top, leaving the
    // remainder blank. On a fitted page the sheet shrinks to the slice instead, so there is no
    // remainder to leave blank.
    const pageHeight = paper ? paper.height : drawHeight
    pages.push({
      source: { x: crop.x, y: sourceY, width: crop.width, height: sliceHeight },
      pageWidth,
      pageHeight,
      drawX: 0,
      drawY: pageHeight - drawHeight,
      drawWidth: pageWidth,
      drawHeight,
    })
  }
  return pages
}

/**
 * Why an unsplit export cannot be produced, or `undefined` if it can.
 *
 * A single page for a long capture can exceed what the PDF specification allows, and readers do not
 * agree on what to do about it — some clip, some refuse, some render at the wrong scale. Saying so
 * beats producing a file that opens wrong on the user's machine and not ours.
 */
export function unsplitPageProblem(crop: CropRect, options: PdfOptions): string | undefined {
  if (options.splitToPages) return undefined
  const [page] = planPdfPages(crop, { ...options, splitToPages: false })
  if (!page || page.pageHeight <= PDF_MAX_PAGE_POINTS) return undefined
  return (
    'This capture is too long to put on a single page — PDF pages stop at 200 inches, and readers ' +
    'disagree about what to do beyond that. Turn "Split to pages" back on to export it.'
  )
}

export interface DocumentRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Places a rectangle measured on the live page onto one PDF page, in points.
 *
 * Returns `undefined` when it does not appear on this page at all, which is the common case: a link
 * belongs to one page out of many. A rectangle straddling a page break is clipped to each page it
 * touches and therefore emitted on both, which is what makes a link that spans a break clickable on
 * either side of it rather than on neither.
 *
 * `imageOrigin` is the document position of image pixel (0, 0). It is zero for a full-page capture
 * and the band's first scroll offset for a region, which is the same quantity `regionToImageCrop`
 * already calls `captureY`.
 */
export function documentRectToPdf(
  rect: DocumentRect,
  page: PdfPagePlan,
  scaleX: number,
  scaleY: number,
  imageOrigin: { x: number; y: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined

  // Document CSS pixels -> image pixels.
  const imageLeft = (rect.x - imageOrigin.x) * scaleX
  const imageTop = (rect.y - imageOrigin.y) * scaleY
  const imageRight = imageLeft + rect.width * scaleX
  const imageBottom = imageTop + rect.height * scaleY

  // Clip to the slice of the image this page shows.
  const sourceRight = page.source.x + page.source.width
  const sourceBottom = page.source.y + page.source.height
  const left = Math.max(imageLeft, page.source.x)
  const right = Math.min(imageRight, sourceRight)
  const top = Math.max(imageTop, page.source.y)
  const bottom = Math.min(imageBottom, sourceBottom)
  if (right <= left || bottom <= top) return undefined

  // Image pixels -> points on this page, flipping to PDF's y-up origin.
  const pointsPerPixelX = page.drawWidth / page.source.width
  const pointsPerPixelY = page.drawHeight / page.source.height
  const x = page.drawX + (left - page.source.x) * pointsPerPixelX
  const width = (right - left) * pointsPerPixelX
  const height = (bottom - top) * pointsPerPixelY
  const y = page.drawY + page.drawHeight - (bottom - page.source.y) * pointsPerPixelY

  return { x, y, width, height }
}
