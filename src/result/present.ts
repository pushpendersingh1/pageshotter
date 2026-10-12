/**
 * The "Present" browser chrome: loads the strip artwork and draws the band the editor renderers'
 * `chrome` operation places above a capture. Backdrop, card, shadow and corners are scene operations
 * drawn by those renderers, so this module owns only the chrome itself.
 *
 * The chrome is a template layer: three strip bitmaps -- left, tiling centre, right -- drawn at the
 * geometry `chrome-template.ts` fixes, with the page URL and the date stamp drawn as canvas text
 * over them at render time. Everything is laid out in design units (one CSS pixel of the captured
 * page) scaled by `unit`, the capture density. A 2x render still picks the 2x strips so nothing is
 * resampled, and preview and export draw the band through the same function.
 *
 * The strip bitmaps are ours, shot from Chrome and refined in Figma. Until
 * they are added to `public/assets/chrome/`, the loader falls back to procedural placeholders drawn
 * at exactly the same geometry, so the render path is complete and honest before the artwork lands.
 *
 * Every colour here is hard-coded and never follows the theme. That is the design language's own
 * rule (section 5): the six annotation colours are baked into the exported image, and a presented
 * screenshot is the same kind of thing -- user content, produced once, meant to be pasted elsewhere.
 *
 * The canvas API is the one thing in this codebase tests cannot run in plain Node, which is why the
 * geometry lives in `chrome-template.ts` (pure) and only drawing and loading live here.
 */

import { PageShotterError } from '../shared/errors'
import type { ChromeDensity, ChromeTemplate } from './chrome-template'
import {
  chromeDensityFor,
  chromeInk,
  chromeTemplateFor,
  dateRightEdge,
  piecePlan,
  urlMaxWidth,
  urlSegments,
} from './chrome-template'
import type { PresentOptions } from './presentation-options'

const URL_FONT = '300 14px system-ui, -apple-system, "Segoe UI", sans-serif'
const DATE_FONT = '400 13px system-ui, -apple-system, "Segoe UI", sans-serif'
const ELLIPSIS = '…'

/*
 * Placeholder-strip palette. It imitates Chrome's light window chrome closely enough to stand in
 * for the bitmaps; the real strips replace it wholesale when they land, loader first.
 */
const PLACEHOLDER_TABSTRIP = '#DEE1E6'
const PLACEHOLDER_TOOLBAR = '#F6F5F3'
const PLACEHOLDER_TOOLBAR_LINE = '#DADCE0'
const PLACEHOLDER_INK = '#5F6368'
/** The design language's own red, amber and green, in place of another traffic-light set. */
const LIGHT_RED = '#E11900'
const LIGHT_AMBER = '#F5A524'
const LIGHT_GREEN = '#12A150'

/** One strip image, drawn at `density` asset pixels per design unit. */
interface ChromePiece {
  bitmap: CanvasImageSource
  /** The bitmap's own pixel size, for whole-bitmap draws. */
  srcW: number
  srcH: number
  /** Design units the piece spans; the bitmap carries `density` asset pixels per unit. */
  width: number
  height: number
}

export interface ChromePieceSet {
  left: ChromePiece
  center: ChromePiece
  right: ChromePiece
}

function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height)
}

function context(canvas: OffscreenCanvas, alpha = false): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha })
  if (!ctx) throw new PageShotterError('CANVAS_UNAVAILABLE', 'Chrome could not create the presentation canvas.')
  return ctx
}

// --- strip loading -----------------------------------------------------------

const assetCache = new Map<string, Promise<ChromePiece>>()

function assetUrl(name: string): string {
  return chrome.runtime.getURL(`assets/chrome/${name}.png`)
}

/**
 * The strip's file name, minus the extension: `mac-header-left`, `windows2x-dark-header-right`, ...
 * The 1x set carries no density tag; the 2x set tags itself.
 */
function pieceName(
  kind: PresentOptions['frame'],
  density: ChromeDensity,
  dark: boolean,
  part: ChromePiecePart,
): string {
  return `${kind}${density === 2 ? '2x' : ''}${dark ? '-dark' : ''}-header-${part}`
}

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new PageShotterError('ASSET_MISSING', `${url} is not there.`)
  return createImageBitmap(await response.blob())
}

/** The three strip pieces a frame is built from. Modern Chrome's omnibox carries one config icon,
 * so there is no https-specific left piece to select. */
type ChromePiecePart = 'left' | 'center' | 'right'

/**
 * Draws a procedural stand-in for one strip, at the template's own geometry times `density`, so the
 * composition path -- the centre run, the right-piece degrade -- runs identically with or without
 * the real artwork.
 */
function placeholderPiece(
  kind: PresentOptions['frame'],
  density: ChromeDensity,
  template: ChromeTemplate,
  part: ChromePiecePart,
): ChromePiece {
  const width = part === 'left' ? template.leftW : part === 'center' ? template.centerW : template.rightW
  const canvas = createCanvas(width * density, template.band * density)
  const ctx = context(canvas)
  ctx.scale(density, density)
  const toolbarTop = template.band / 2

  ctx.fillStyle = PLACEHOLDER_TABSTRIP
  ctx.fillRect(0, 0, width, toolbarTop)
  ctx.fillStyle = PLACEHOLDER_TOOLBAR
  ctx.fillRect(0, toolbarTop, width, template.band - toolbarTop)
  ctx.fillStyle = PLACEHOLDER_TOOLBAR_LINE
  ctx.fillRect(0, template.band - 1, width, 1)

  if (kind === 'mac') {
    if (part === 'left') {
      const colors = [LIGHT_RED, LIGHT_AMBER, LIGHT_GREEN]
      let x = 20
      for (const color of colors) {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, 20, 6, 0, Math.PI * 2)
        ctx.fill()
        x += 20
      }
      // The active tab's outline, so the strip reads as a tab strip a URL can sit under.
      ctx.strokeStyle = PLACEHOLDER_TOOLBAR_LINE
      ctx.lineWidth = 1
      ctx.strokeRect(template.urlX - 40, 8, 180, toolbarTop - 8)
    }
    if (part === 'right') {
      ctx.fillStyle = PLACEHOLDER_INK
      for (const x of [24, 52, 80]) {
        ctx.beginPath()
        ctx.arc(x, toolbarTop + 20, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (part === 'right') {
    // Windows' controls ride the tab strip's far end: minimise, maximise, close.
    ctx.strokeStyle = PLACEHOLDER_INK
    ctx.lineWidth = 1.4
    const y = toolbarTop / 2
    ctx.beginPath()
    ctx.moveTo(width - 58, y + 4)
    ctx.lineTo(width - 46, y + 4)
    ctx.stroke()
    ctx.strokeRect(width - 36, y - 4, 9, 9)
    ctx.beginPath()
    ctx.moveTo(width - 22, y - 4)
    ctx.lineTo(width - 12, y + 4)
    ctx.moveTo(width - 12, y - 4)
    ctx.lineTo(width - 22, y + 4)
    ctx.stroke()
  }
  return { bitmap: canvas, srcW: canvas.width, srcH: canvas.height, width, height: template.band }
}

/**
 * The three strips for a frame, at a density and theme. Real bitmaps win whenever they are in the
 * extension; the procedural placeholders keep the frame whole if one is missing.
 */
export async function loadChromePieces(
  kind: PresentOptions['frame'],
  density: ChromeDensity,
  dark: boolean,
): Promise<ChromePieceSet> {
  const template = chromeTemplateFor(kind)

  const bitmapFor = (name: string): Promise<ChromePiece> => {
    const cached = assetCache.get(name)
    if (cached) return cached
    const pending = loadBitmap(assetUrl(name)).then(
      (bitmap) => ({ bitmap, srcW: bitmap.width, srcH: bitmap.height, width: bitmap.width / density, height: bitmap.height / density }),
    )
    assetCache.set(name, pending)
    // A piece that failed is retried on the next load: a missing file is fetched once per compose
    // call, but a real asset that later ships is picked up without a restart.
    pending.catch(() => assetCache.delete(name))
    return pending
  }

  const load = async (part: ChromePiecePart): Promise<ChromePiece> => {
    const name = pieceName(kind, density, dark, part)
    try {
      return await bitmapFor(name)
    } catch {
      return placeholderPiece(kind, density, template, part)
    }
  }

  const [left, center, right] = await Promise.all([load('left'), load('center'), load('right')])
  return { left, center, right }
}

/**
 * Draws the URL, omnibox-coloured, into the band. Segments run left to right and the address
 * ellipsises character by character at `limit`, so a long URL stops where the right piece begins
 * instead of spilling over the artwork. The ink follows the chrome theme: dark chrome's omnibox
 * writes near-white, and the light palette would be invisible on it.
 */
function drawUrl(
  ctx: OffscreenCanvasRenderingContext2D,
  address: string,
  theme: PresentOptions['chrome'],
  x: number,
  baseline: number,
  limit: number,
): void {
  ctx.font = URL_FONT
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  let pen = x
  for (const segment of urlSegments(address, theme)) {
    let text = segment.text
    let truncated = false
    while (pen + ctx.measureText(text).width > limit && text.length > 0) {
      truncated = true
      text = text.substring(0, text.length - 1)
    }
    if (text === '') break
    ctx.fillStyle = segment.color
    ctx.fillText(truncated ? text + ELLIPSIS : text, pen, baseline)
    pen += ctx.measureText(truncated ? text + ELLIPSIS : text).width
    if (truncated) break
  }
}

function drawStrips(
  ctx: OffscreenCanvasRenderingContext2D,
  pieces: ChromePieceSet | null,
  template: ChromeTemplate,
  kind: PresentOptions['frame'],
  density: ChromeDensity,
  cardW: number,
): void {
  const plan = piecePlan(cardW, template)

  // Without loaded pieces, procedural stand-ins drawn at the same geometry carry the frame.
  const left = pieces?.left ?? placeholderPiece(kind, density, template, 'left')
  const center = pieces?.center ?? placeholderPiece(kind, density, template, 'center')
  const right = pieces?.right ?? placeholderPiece(kind, density, template, 'right')

  // The centre run goes down first, as ONE draw stretched across the whole run and overlapped a
  // design pixel under both end pieces. A GPU rasteriser linear-filters every drawImage boundary,
  // which bleeds one blended column at each exact edge -- invisible on light artwork, a hairline
  // seam on dark. One continuous draw has no interior edges, the end pieces cover the two joins,
  // and a horizontally uniform tile stretches identically to tiling. This is why a seam seen in
  // Chrome never appeared in the software-rasterised harness.
  ctx.drawImage(
    center.bitmap,
    0,
    0,
    center.srcW,
    center.srcH,
    plan.centerStart - 1,
    0,
    plan.centerEnd - plan.centerStart + 2,
    center.height,
  )

  // Source rect times the density: one asset pixel per design unit at the piece's own density.
  ctx.drawImage(
    left.bitmap,
    0,
    0,
    Math.min(plan.leftW, plan.centerEnd) * density,
    left.height * density,
    0,
    0,
    Math.min(plan.leftW, plan.centerEnd),
    left.height,
  )

  if (plan.rightX !== null) {
    ctx.drawImage(right.bitmap, 0, 0, right.width * density, right.height * density, plan.rightX, 0, right.width, right.height)
  }
}

/** Draws only the browser band, for the editor renderers' `chrome` operation. */
export function renderChromeBand(
  width: number,
  options: PresentOptions,
  address: string,
  stamp: string | null,
  unit: number,
  pieces: ChromePieceSet | null,
): OffscreenCanvas {
  const template = chromeTemplateFor(options.frame)
  const band = Math.round(template.band * unit)
  const canvas = createCanvas(Math.ceil(width), band)
  const ctx = context(canvas, true)
  const designWidth = width / unit

  ctx.scale(unit, unit)
  ctx.fillStyle = PLACEHOLDER_TOOLBAR
  ctx.fillRect(0, 0, designWidth, template.band)
  drawStrips(ctx, pieces, template, options.frame, chromeDensityFor(unit), designWidth)

  let reserved = 0
  if (stamp) {
    ctx.font = DATE_FONT
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'right'
    const plan = piecePlan(designWidth, template)
    const dateX = dateRightEdge(designWidth, template)
    ctx.fillStyle = chromeInk(options.chrome)
    ctx.fillText(stamp, dateX, template.dateBaseline)
    reserved = ctx.measureText(stamp).width - (dateX - (plan.rightX ?? designWidth))
  }
  drawUrl(
    ctx,
    address,
    options.chrome,
    template.urlX,
    template.urlBaseline,
    urlMaxWidth(designWidth, template, reserved),
  )
  return canvas
}
