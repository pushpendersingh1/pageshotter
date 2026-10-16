import { BROWSER } from '../shared/browser'
import {
  BUNDLED_FONTS,
  textBubblePath,
  textInset,
  applyMatrix,
  arrowPath,
  magnifierConnector,
  matrixOf,
  localBounds,
  transformedBounds,
  type ShapeNode,
  squirclePoints,
  framePower,
  magnifierWorld,
  type MagnifierNode,
  blurWindow,
  emptyDoc,
  flatten,
  hasStroke,
  planBands,
  rectsIntersect,
  textBaselineY,
  textLineX,
  usesOpacityBuffer,
  wrapTextLines,
  SCENE_FONT,
  counterFontSize,
  counterPath,
  textFontFamily,
  textFontStyle,
  renderRect,
  type DrawOp,
  type Matrix,
  type Rect,
  type ResolvedShape,
  type SceneDoc,
} from './scene'
import { stackBlurRegion } from './stackblur'
import { chromeDensityFor } from '../result/chrome-template'
import { loadChromePieces, renderChromeBand, type ChromePieceSet } from '../result/present'
import { PRESENT_GRADIENTS } from '../result/presentation-options'
import type { Tile, TiledImage } from '../result/stitcher'

export interface SceneRenderDetails {
  address: string
  stamp: string | null
}

/** The one face every renderer writes text with, so measurements and pixels cannot disagree. */
export { SCENE_FONT }

/** The minimal canvas surface `roundedRectPath` needs, shared by DOM and Offscreen contexts. */
export interface PathContext {
  beginPath(): void
  moveTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  closePath(): void
}

/** A rounded-rectangle path on `context`, used for the Present card clip in both renderers. */
export function roundedRectPath(context: PathContext, rect: Rect, radius: number): void {
  const r = Math.min(radius, rect.width / 2, rect.height / 2)
  context.beginPath()
  context.moveTo(rect.x + r, rect.y)
  context.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height, r)
  context.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x, rect.y + rect.height, r)
  context.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y, r)
  context.arcTo(rect.x, rect.y, rect.x + rect.width, rect.y, r)
  context.closePath()
}

interface PaintWindow {
  rect: Rect
  ops?: readonly DrawOp[]
}

/**
 * Waits for the packaged fonts. A canvas draws with whatever the font is *now*: one not loaded yet
 * draws, and Konva measures, in the fallback, and nothing redraws when it arrives. `@font-face` only
 * loads on demand, so a page that draws text has to ask first.
 */
export async function loadBundledFonts(): Promise<void> {
  await Promise.all(BUNDLED_FONTS.map((name) => document.fonts.load(`16px "${name}"`).catch(() => [])))
}

const decoding = new Map<string, Promise<ImageBitmap | null>>()
const decoded = new Map<string, ImageBitmap | null>()

/**
 * An image node's pixels, decoded once per picture and shared by the preview and every export. The
 * source is a `data:` URL `isImageSource` has already vetted, turned into bytes here rather than
 * fetched, so no network rule can get in the way. A picture that will not decode draws nothing.
 * ponytail: never evicted; an editor tab holds a handful of pictures, add eviction if that changes.
 */
export function decodeImage(src: string): Promise<ImageBitmap | null> {
  let pending = decoding.get(src)
  if (!pending) {
    pending = (async () => {
      const comma = src.indexOf(',')
      const bytes = Uint8Array.from(atob(src.slice(comma + 1)), (char) => char.charCodeAt(0))
      return createImageBitmap(new Blob([bytes], { type: src.slice(5, src.indexOf(';')) }))
    })()
      .catch(() => null)
      .then((bitmap) => {
        decoded.set(src, bitmap)
        return bitmap
      })
    decoding.set(src, pending)
  }
  return pending
}

/** The picture if `decodeImage` has finished with it, for the synchronous draws. */
export function decodedImage(src: string): ImageBitmap | null | undefined {
  return decoded.get(src)
}

/**
 * Full-density scene export. Each band renders the wider window `planBands` owns, then writes only
 * its owned rows. That crop is what makes blur support cross an 8,192px boundary without duplicating
 * output rows.
 */
export async function renderEditedImage(
  doc: SceneDoc,
  image: TiledImage,
  bandHeight: number,
  details: SceneRenderDetails,
): Promise<TiledImage> {
  await loadBundledFonts()
  const output = renderRect(doc, bandHeight)
  const ops = flatten(doc, bandHeight)
  const tiles: Tile[] = []

  for (const band of planBands(doc, bandHeight)) {
    const rendered = await paintSceneWindow(
      doc,
      image,
      bandHeight,
      details,
      {
        x: output.x,
        y: output.y + band.renderOffsetY,
        width: output.width,
        height: band.renderHeight,
      },
      ops,
    )
    const owned = new OffscreenCanvas(output.width, band.height)
    const context = canvasContext(owned)
    context.drawImage(rendered, 0, band.offsetY - band.renderOffsetY, output.width, band.height, 0, 0, output.width, band.height)
    tiles.push({
      offsetY: band.offsetY,
      width: output.width,
      height: band.height,
      blob: await owned.convertToBlob({ type: 'image/png' }),
    })
    rendered.width = 0
    rendered.height = 0
    owned.width = 0
    owned.height = 0
  }

  return {
    width: output.width,
    height: output.height,
    scaleX: image.scaleX,
    scaleY: image.scaleY,
    tiles,
  }
}

/** Rebases a source-region capture so its selected rectangle becomes scene-space `(0, 0)`. */
export async function cropTiledImage(image: TiledImage, crop: Rect, density: number): Promise<TiledImage> {
  const doc = emptyDoc(image.width, image.height, density)
  doc.canvas.background = 'none'
  doc.canvas.margin = 0
  doc.present.on = false
  doc.crop = { ...crop }
  return renderEditedImage(doc, image, 0, { address: '', stamp: null })
}

/** Renders an arbitrary scene-space window, used by the Konva preview to materialise blur ops. */
export async function renderSceneWindow(
  doc: SceneDoc,
  image: TiledImage,
  bandHeight: number,
  details: SceneRenderDetails,
  window: PaintWindow,
): Promise<OffscreenCanvas> {
  return paintSceneWindow(doc, image, bandHeight, details, window.rect, window.ops ?? flatten(doc, bandHeight))
}

async function paintSceneWindow(
  _doc: SceneDoc,
  image: TiledImage,
  _bandHeight: number,
  details: SceneRenderDetails,
  window: Rect,
  ops: readonly DrawOp[],
): Promise<OffscreenCanvas> {
  const canvas = new OffscreenCanvas(Math.ceil(window.width), Math.ceil(window.height))
  const context = canvasContext(canvas)
  context.translate(-window.x, -window.y)
  const chromePieces = new Map<string, Promise<ChromePieceSet | null>>()

  for (const op of ops) {
    switch (op.kind) {
      case 'backdrop':
        drawBackdrop(context, op)
        break
      case 'chrome': {
        drawFrameBase(context, op)
        const density = chromeDensityFor(op.unit)
        const key = `${op.present.frame}:${op.present.chrome}:${density}`
        let pieces = chromePieces.get(key)
        if (!pieces) {
          pieces = loadChromePieces(op.present.frame, density, op.present.chrome === 'dark')
          chromePieces.set(key, pieces)
        }
        const band = renderChromeBand(op.rect.width, op.present, details.address, details.stamp, op.unit, await pieces)
        // The band clips to the card's corners like the capture beneath it; the card and its shadow
        // above stay unclipped, matching `composePresented`'s order.
        context.save()
        if (op.clip) {
          roundedRectPath(context, op.clip.rect, op.clip.radius)
          context.clip()
        }
        context.drawImage(band, op.rect.x, op.rect.y)
        context.restore()
        band.width = 0
        band.height = 0
        break
      }
      case 'capture':
        await drawCapture(context, image, op, window)
        break
      case 'shape':
        if (op.shape.node.type === 'image') await decodeImage(op.shape.node.src)
        if (op.shape.node.type === 'magnifier') {
          await paintMagnifier(context, _doc, { ...op.shape, node: op.shape.node }, image, details, ops)
          break
        }
        drawShape(context, op.shape, window)
        break
      case 'blur':
        drawBlur(context, canvas, op, window)
        break
    }
  }
  return canvas
}

/**
 * A magnifier in the export. Its lens is filled from the **capture** itself, painted fresh for the
 * source rectangle, not from this band's canvas: the source can sit in another band entirely, which
 * makes this tool blur-class. Annotations under the source are
 * not magnified; the capture is.
 */
async function paintMagnifier(
  context: OffscreenCanvasRenderingContext2D,
  doc: SceneDoc,
  shape: ResolvedShape & { node: MagnifierNode },
  image: TiledImage,
  details: SceneRenderDetails,
  ops: readonly DrawOp[],
): Promise<void> {
  const { source, lens } = magnifierWorld(shape)
  const pixels =
    source.width >= 1 && source.height >= 1
      ? await paintSceneWindow(doc, image, 0, details, source, ops.filter((op) => op.kind === 'capture'))
      : undefined
  context.save()
  context.globalAlpha = shape.opacity
  drawMagnifier(context, shape.node, source, lens, pixels && ((target, into) => target.drawImage(pixels, into.x, into.y, into.width, into.height)))
  context.restore()
  if (pixels) {
    pixels.width = 0
    pixels.height = 0
  }
}

/**
 * The magnifier in scene space, both renderers' one drawing of it: the joining line, the lens filled
 * with the source's pixels -- unsmoothed, so a zoomed pixel stays a crisp square -- and
 * the two frames.
 */
export function drawMagnifier(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  node: Pick<MagnifierNode, 'shape' | 'roundness' | 'stroke' | 'strokeWidth'>,
  source: Rect,
  lens: Rect,
  /** Paints the source's pixels over the lens rectangle; the lens is already clipped and unsmoothed. */
  fill: ((context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, lens: Rect) => void) | undefined,
): void {
  const power = framePower(node)
  const frame = (rect: Rect): void => {
    context.beginPath()
    if (power === undefined) {
      context.rect(rect.x, rect.y, rect.width, rect.height)
      return
    }
    const [first, ...rest] = squirclePoints(rect, power)
    if (!first) return
    context.moveTo(first.x, first.y)
    for (const point of rest) context.lineTo(point.x, point.y)
    context.closePath()
  }
  context.save()
  context.strokeStyle = node.stroke
  context.lineWidth = node.strokeWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const join = magnifierConnector(source, lens, power)
  if (join && node.strokeWidth > 0) {
    context.beginPath()
    context.moveTo(join[0].x, join[0].y)
    context.lineTo(join[1].x, join[1].y)
    context.stroke()
  }
  if (fill) {
    context.save()
    frame(lens)
    context.clip()
    context.imageSmoothingEnabled = false
    fill(context, lens)
    context.restore()
  }
  if (node.strokeWidth > 0) {
    frame(lens)
    context.stroke()
    frame(source)
    context.stroke()
  }
  context.restore()
}

function canvasContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
  if (!context) throw new Error(`${BROWSER.name} could not create the editor export canvas.`)
  return context
}

function drawBackdrop(context: OffscreenCanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'backdrop' }>): void {
  if (op.background === 'none') return
  if (op.background === 'custom') {
    context.fillStyle = op.customColor
  } else {
    const gradient = context.createLinearGradient(op.rect.x, op.rect.y, op.rect.x + op.rect.width, op.rect.y + op.rect.height)
    for (const stop of PRESENT_GRADIENTS[op.background]) gradient.addColorStop(stop.at, stop.color)
    context.fillStyle = gradient
  }
  context.fillRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height)
}

function drawFrameBase(context: OffscreenCanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'chrome' }>): void {
  const radius = op.present.corners * op.unit
  context.save()
  if (op.present.shadow) {
    context.shadowColor = 'rgba(26,26,26,0.28)'
    context.shadowBlur = 28 * op.unit
    context.shadowOffsetY = 14 * op.unit
  }
  context.fillStyle = '#FFFFFF'
  roundedRectPath(context, op.rect, radius)
  context.fill()
  context.restore()
}

async function drawCapture(
  context: OffscreenCanvasRenderingContext2D,
  image: TiledImage,
  op: Extract<DrawOp, { kind: 'capture' }>,
  window: Rect,
): Promise<void> {
  context.save()
  if (op.clip) {
    roundedRectPath(context, op.clip.rect, op.clip.radius)
    context.clip()
  }
  for (const tile of image.tiles) {
    const tileRect = { x: op.rect.x, y: op.rect.y + tile.offsetY, width: tile.width, height: tile.height }
    if (!rectsIntersect(tileRect, window)) continue
    const bitmap = await createImageBitmap(tile.blob)
    context.drawImage(bitmap, tileRect.x, tileRect.y, tileRect.width, tileRect.height)
    bitmap.close()
  }
  context.restore()
}

function applyShapeTransform(context: OffscreenCanvasRenderingContext2D, matrix: Matrix): void {
  context.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5])
}

/**
 * One shape, drawn as the export draws it, for the Editor defaults sheet's sample. The sheet builds
 * most samples in CSS; the pen, marker and counter are drawn here so they cannot drift from the real
 * thing. Opacity is left to the caller's element.
 */
export function drawSampleShape(context: OffscreenCanvasRenderingContext2D, node: ShapeNode): void {
  const matrix = matrixOf(node.transform)
  drawShape(context, { node, matrix, bounds: transformedBounds(localBounds(node), matrix), opacity: 1, locked: false }, { x: -1e6, y: -1e6, width: 2e6, height: 2e6 })
}

function drawShape(context: OffscreenCanvasRenderingContext2D, shape: ResolvedShape, window: Rect, bubble = true): void {
  const node = shape.node
  // A filled text's box is its own piece, blended on its own and never inside the letters' buffer:
  // the preview draws it as a separate Konva shape in the group, which blends each child separately.
  if (bubble && node.type === 'text' && node.fill !== undefined) {
    context.save()
    applyShapeTransform(context, shape.matrix)
    context.globalAlpha = shape.opacity
    textBubblePath(context, node)
    context.fillStyle = node.fill
    context.fill()
    context.restore()
  }
  if (usesOpacityBuffer(node, shape.opacity)) {
    // Drawn opaque into a buffer the size of the shape, then blended once, as Konva's preview does, so
    // overlapping fill, stroke, shaft and head do not stack their transparency. The pad covers the
    // stroke and an arrowhead; the buffer is clipped to the band window and aligned to whole pixels.
    const pad = ('strokeWidth' in node ? node.strokeWidth : 0) + (node.type === 'arrow' ? node.headSize : 0)
    const region = blurWindow(shape.bounds, window, pad)
    if (!region) return
    const x = Math.floor(region.x)
    const y = Math.floor(region.y)
    const buffer = new OffscreenCanvas(Math.ceil(region.x + region.width) - x, Math.ceil(region.y + region.height) - y)
    const bufferContext = canvasContext(buffer)
    bufferContext.translate(-x, -y)
    drawShape(bufferContext, { ...shape, opacity: 1 }, window, false)
    context.save()
    context.globalAlpha = shape.opacity
    context.drawImage(buffer, x, y)
    context.restore()
    buffer.width = 0
    buffer.height = 0
    return
  }
  context.save()
  applyShapeTransform(context, shape.matrix)
  context.globalAlpha = shape.opacity
  context.lineCap = 'round'
  context.lineJoin = 'round'

  switch (node.type) {
    case 'rectangle':
      roundedRectPath(context, { x: 0, y: 0, width: node.width, height: node.height }, node.radius)
      if (node.fill !== 'none') {
        context.fillStyle = node.fill
        context.fill()
      }
      if (hasStroke(node)) {
        context.strokeStyle = node.stroke
        context.lineWidth = node.strokeWidth
        context.stroke()
      }
      break
    case 'ellipse':
      context.beginPath()
      context.ellipse(node.width / 2, node.height / 2, node.width / 2, node.height / 2, 0, 0, Math.PI * 2)
      if (node.fill !== 'none') {
        context.fillStyle = node.fill
        context.fill()
      }
      if (hasStroke(node)) {
        context.strokeStyle = node.stroke
        context.lineWidth = node.strokeWidth
        context.stroke()
      }
      break
    case 'arrow':
      arrowPath(context, node)
      if (node.style === 'solid') {
        context.fillStyle = node.stroke
        context.fill()
      } else {
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.strokeStyle = node.stroke
        context.lineWidth = node.strokeWidth
        context.stroke()
      }
      break
    case 'line':
      drawLine(context, node.points, node.stroke, node.strokeWidth)
      break
    case 'freehand':
      // A marker tints rather than paints, exactly as the rectangle highlight does. The composite is
      // per-pixel and local to the stroke, so a band drawing its own slice of it is still correct.
      if (node.marker) context.globalCompositeOperation = 'multiply'
      drawLine(context, node.points, node.stroke, node.strokeWidth)
      break
    case 'text':
      // A fixed box crops its text, as the preview's clip does.
      context.save()
      if (node.fixedHeight) {
        // Room for the outline at the sides and top; the bottom edge is the crop the user set.
        const pad = hasStroke(node) ? node.strokeWidth / 2 : 0
        context.beginPath()
        context.rect(-pad, -pad, node.width + pad * 2, node.height + pad)
        context.clip()
      }
      drawText(context, node)
      context.restore()
      break
    case 'highlight':
      context.globalCompositeOperation = 'multiply'
      context.fillStyle = node.color
      context.fillRect(0, 0, node.width, node.height)
      break
    case 'image': {
      const bitmap = decodedImage(node.src)
      if (bitmap) context.drawImage(bitmap, 0, 0, node.width, node.height)
      break
    }
    case 'emoji': {
      // Placed as Konva `Text` places it, like text: the alphabetic baseline from the font
      // box of 'M', at Konva's default line height of 1, because the preview sets none for an emoji.
      context.fillStyle = '#000000'
      context.font = `${node.fontSize}px ${SCENE_FONT}`
      context.textBaseline = 'alphabetic'
      const box = fontBox(context)
      context.fillText(node.char, 0, textBaselineY(0, node.fontSize, box.ascent, box.descent))
      break
    }
    case 'counter': {
      // The disc, then the digits placed exactly where the preview's unboxed Konva `Text` puts them
      // (Konva is the reference, the export reproduces it). One line of height
      // `fontSize`, centred in the badge both ways, drawn on the alphabetic baseline from the font
      // box of 'M' -- the same arithmetic the emoji case above uses.
      const label = String(node.count)
      const fontSize = counterFontSize(node.width, node.count)
      // The disc and its tail come from `counterPath`, the same function the preview's `sceneFunc`
      // calls -- so these two agree by construction rather than by being checked against each other.
      counterPath(context, node.width, node.tip)
      context.fillStyle = node.fill
      context.fill()
      context.fillStyle = node.color
      context.font = `bold ${fontSize}px ${SCENE_FONT}`
      context.textBaseline = 'alphabetic'
      const box = fontBox(context)
      const top = (node.height - fontSize) / 2
      context.fillText(label, (node.width - context.measureText(label).width) / 2, top + textBaselineY(0, fontSize, box.ascent, box.descent))
      break
    }
    case 'blur':
      break
  }
  context.restore()
}

function drawLine(
  context: OffscreenCanvasRenderingContext2D,
  points: readonly number[],
  stroke: string,
  strokeWidth: number,
): void {
  // The preview's Konva `Line` rounds its caps (A6).
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(points[0] ?? 0, points[1] ?? 0)
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index] ?? 0, points[index + 1] ?? 0)
  context.strokeStyle = stroke
  context.lineWidth = strokeWidth
  context.stroke()
}

function drawText(context: OffscreenCanvasRenderingContext2D, node: Extract<ResolvedShape['node'], { type: 'text' }>): void {
  context.font = `${textFontStyle(node)} ${node.fontSize}px ${textFontFamily(node)}`
  // Konva's default text path: alphabetic baseline, lines placed from the font box of 'M', and each line
  // offset for alignment rather than drawn with canvas `textAlign`.
  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'
  context.fillStyle = node.color
  const outline = hasStroke(node)
  if (outline) {
    context.strokeStyle = node.stroke
    context.lineWidth = node.strokeWidth
    context.lineJoin = 'round'
  }
  const box = fontBox(context)
  const lineHeight = node.fontSize * 1.2
  // A filled box's text is laid out in the box minus its inset, as the preview's Text is.
  const inset = textInset(node)
  const width = Math.max(1, node.width - inset.x * 2)
  wrapTextLines(node.text, width, (run) => context.measureText(run).width).forEach((line, index) => {
    const x = inset.x + textLineX(node.align, width, line.width)
    const y = inset.y + textBaselineY(index, lineHeight, box.ascent, box.descent)
    // Stroke first and fill over it, as the preview's `fillAfterStrokeEnabled`, so the outline sits
    // outside the glyphs instead of eating into them.
    if (outline) context.strokeText(line.text, x, y)
    context.fillText(line.text, x, y)
  })
}

/** The current font's box from 'M', as Konva `Text` measures it, falling back to the glyph's own box. */
function fontBox(context: OffscreenCanvasRenderingContext2D): { ascent: number; descent: number } {
  const metrics = context.measureText('M')
  return {
    ascent: metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent,
    descent: metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent,
  }
}

function drawBlur(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  op: Extract<DrawOp, { kind: 'blur' }>,
  window: Rect,
): void {
  if (!rectsIntersect(op.region, window) || op.radius < 1) return
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  stackBlurRegion(
    image.data,
    canvas.width,
    canvas.height,
    { x: op.region.x - window.x, y: op.region.y - window.y, w: op.region.width, h: op.region.height },
    op.radius,
  )
  const blurred = new OffscreenCanvas(canvas.width, canvas.height)
  canvasContext(blurred).putImageData(image, 0, 0)

  const node = op.shape.node
  if (node.type !== 'blur') return
  context.save()
  applyShapeTransform(context, op.shape.matrix)
  context.beginPath()
  context.rect(0, 0, node.width, node.height)
  context.clip()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = op.shape.opacity
  context.drawImage(blurred, 0, 0)
  context.restore()
  blurred.width = 0
  blurred.height = 0
}

export function shapeQuad(shape: ResolvedShape): readonly { x: number; y: number }[] {
  const node = shape.node
  if (!('width' in node) || !('height' in node)) return []
  return [
    applyMatrix(shape.matrix, 0, 0),
    applyMatrix(shape.matrix, node.width, 0),
    applyMatrix(shape.matrix, node.width, node.height),
    applyMatrix(shape.matrix, 0, node.height),
  ]
}
