/**
 * The editor's scene model: the stored document, and every number derived from it.
 *
 * This is the editor's whole geometry contract, and it is deliberately the only place that owns it.
 * The rule this file exists to enforce:
 *
 *   > A pure `scene` module owns every number. Neither renderer computes geometry.
 *
 * There are two renderers — an interactive Konva preview at display scale, and a banded export
 * writer at full density — and they cannot be the same code, because a 65,535px-tall composition
 * cannot exist as one canvas. Two renderers that each compute their own geometry is exactly how a
 * preview once omitted a blur the exported file contained. So both consume
 * this module's output and neither is allowed to derive anything locally.
 *
 * Everything here is plain TypeScript over numbers: no DOM, no canvas, no Konva. That is what lets
 * it be tested under the repo's Node-only test setup, and the tests assert the
 * emitted draw-operation list directly rather than rendering anything.
 *
 * ## Scene space
 *
 * One authoritative coordinate space, its unit one capture device pixel, its origin the top-left of
 * the capture — so the capture always occupies exactly `(0, 0, captureWidth, captureHeight)` by
 * definition. Coordinates may be negative: a shape dragged above the screenshot has a negative `y`,
 * and the Present chrome band sits at a negative `y` because it is drawn above the capture.
 *
 * The origin is the capture's rather than the output's because the output's own bounds are derived
 * from content the user is still moving. An output-anchored origin would rewrite every stored
 * coordinate in the document on every drag.
 */

import {
  DEFAULT_PRESENT_OPTIONS,
  PRESENT_BACKGROUNDS,
  PRESENT_CHROME_THEMES,
  PRESENT_FRAME_STYLES,
  PRESENT_STAMP_MODES,
  type PresentOptions,
} from '../result/presentation-options'
import { planTiles, TILE_HEIGHT } from '../result/stitcher'

/**
 * The stored document's version, which is not the database's. `capture-db` is at v5 because it has
 * had five schema generations; this number counts the editor document's own shape, and starts at 1
 * because nothing has ever stored one.
 */
export const SCENE_DOC_VERSION = 1

/** The editor's own type, and every text node's font until one is picked. */
export const SCENE_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/**
 * The font dropdown's candidates: system fonts only. Common on macOS and Windows; the
 * editor lists only the ones this machine has, and the extension never downloads a font.
 */
export const TEXT_FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact', 'Comic Sans MS'] as const

/**
 * Fonts packaged with the extension (`public/fonts/`, declared in `tokens.css`). Always offered,
 * because they are always there, and loaded by `loadBundledFonts` before anything measures or draws.
 */
export const BUNDLED_FONTS = ['Handlee'] as const

/** A new text box's font. Empty `fontFamily` still means the system font. */
export const DEFAULT_TEXT_FONT = 'Handlee'

/** The CSS font-family a text node draws with: its picked family first, the system font behind it. */
export function textFontFamily(node: { fontFamily?: string }): string {
  return node.fontFamily ? `"${node.fontFamily.replace(/"/g, '')}", ${SCENE_FONT}` : SCENE_FONT
}

/** The style-and-weight half of a text node's CSS font, such as `italic 700`. */
export function textFontStyle(node: { fontWeight: number; italic?: true }): string {
  return `${node.italic ? 'italic ' : ''}${node.fontWeight}`
}

/** Four scene units of drift is a twitch, not a shape; drags smaller than this do not commit. */
export const MIN_SHAPE_SIZE = 4

/**
 * The default ink every markup tool starts with: the palette's Blue, which is also `--select`.
 *
 * It was `--accent`, the brand red, until seeing every default in red at once on the defaults sheet
 * made the point the design language already makes about the interface: red is the Download button's, and an annotation is not a Download
 * button. Every annotation still picks any of the six anchors; this is only where they start.
 */
export const DEFAULT_STROKE = '#1D6BE5'

/** Marker yellow, drawn with `globalCompositeOperation: 'multiply'` so it tints rather than washes. */
export const DEFAULT_HIGHLIGHT = '#FFE24A'

/** A counter badge's diameter at density 1, and the tilt it is dealt at creation. */
export const COUNTER_DIAMETER = 44
export const COUNTER_TILT = 3
export const DEFAULT_COUNTER_FILL = '#E11900'
export const DEFAULT_COUNTER_DIGITS = '#FFFFFF'
/** Where a fresh pin's point sits: down and to the right, at this much of the diameter from centre. */
export const COUNTER_TIP_ANGLE = 70
export const COUNTER_TIP_REACH = 0.85

// --- rectangles --------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// --- transforms --------------------------------------------------------------

/**
 * A node's placement in its parent's frame. This is Konva's own node model — position, scale,
 * rotation about the node's origin — which is why the preview can consume a resolved transform
 * without unpacking it, and the export renderer can hand it straight to `setTransform`.
 *
 * Rotation is in degrees, clockwise, matching Konva and the inspector's own field.
 */
export interface Transform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

export const IDENTITY: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }

// --- nodes -------------------------------------------------------------------

interface NodeBase {
  id: string
  /** Shown in the layers panel. Absent means "use the type plus an ordinal" — a display concern. */
  name?: string
  /** A hidden node is kept in the document, drawn by nobody, and excluded from `shapesRect`. */
  hidden?: boolean
  /** A locked node is not selectable on the canvas. It is still selectable in the panel. */
  locked?: boolean
  transform: Transform
}

/** Local geometry shared by every node drawn as an axis-aligned box in its own frame. */
interface BoxGeometry {
  width: number
  height: number
}

export interface RectangleNode extends NodeBase, BoxGeometry {
  type: 'rectangle'
  stroke: string
  strokeWidth: number
  /** `'none'` keeps the shape an outline; any other value is a CSS colour. */
  fill: string
  radius: number
  opacity: number
}

export interface EllipseNode extends NodeBase, BoxGeometry {
  type: 'ellipse'
  stroke: string
  strokeWidth: number
  fill: string
  opacity: number
}

export interface ArrowNode extends NodeBase {
  type: 'arrow'
  /** `[x1, y1, x2, y2]` in the node's own frame. */
  points: readonly number[]
  stroke: string
  strokeWidth: number
  /** The head's length along the shaft; it is also what the head adds to the node's bounds. */
  headSize: number
  opacity: number
  /**
   * Three kinds: `solid` is one filled shape, a shaft that widens from the tail
   * to a triangular head; `line` is a round-capped stroke with an open chevron; `double` has one at
   * each end.
   */
  style: ArrowStyle
  /**
   * Where the curve's middle handle sits, as an offset from the midpoint of the two ends. Absent is
   * straight. Relative to the ends, so dragging one end keeps the bend's shape.
   */
  bend?: { x: number; y: number }
  /**
   * A solid arrow's thickness is not stored: it follows the arrow's length, and
   * this percentage makes it bolder or lighter than that (100 is normal). `strokeWidth` and
   * `headSize` are the Line and Both styles' own. See `arrowWeights`.
   */
  size: number
}

export const ARROW_STYLES = ['solid', 'line', 'double'] as const

/** A solid arrow's neck at Size 100, as a share of its length; its head is `ARROW_HEAD_RATIO` necks. */
const ARROW_NECK_PER_LENGTH = 0.08
const ARROW_HEAD_RATIO = 3
/** The neck never thins below or swells past these, however short or long the arrow (scene units). */
const ARROW_NECK_MIN = 2
const ARROW_NECK_MAX = 120
export const ARROW_SIZE_MIN = 25
export const ARROW_SIZE_MAX = 300

/**
 * The weight and head an arrow is drawn with. A Line or Both arrow's are its own; a solid one's
 * follow its length (the chord between its ends), times `size`, so dragging an end out makes the
 * whole shape bolder.
 */
export function arrowWeights(node: Pick<ArrowNode, 'points' | 'style' | 'strokeWidth' | 'headSize' | 'size'>): { strokeWidth: number; headSize: number } {
  if (node.style !== 'solid') return { strokeWidth: node.strokeWidth, headSize: node.headSize }
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
  const neck = Math.hypot(x2 - x1, y2 - y1) * ARROW_NECK_PER_LENGTH * (node.size / 100)
  const strokeWidth = Math.min(ARROW_NECK_MAX, Math.max(ARROW_NECK_MIN, neck))
  return { strokeWidth, headSize: strokeWidth * ARROW_HEAD_RATIO }
}

/** The Size that draws a solid arrow at `strokeWidth`, for an arrow saved before Size existed. */
function arrowSizeFor(points: readonly number[], strokeWidth: number): number {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = points
  const length = Math.hypot(x2 - x1, y2 - y1)
  const size = length === 0 ? 100 : Math.round((strokeWidth / (length * ARROW_NECK_PER_LENGTH)) * 100)
  return Math.min(ARROW_SIZE_MAX, Math.max(ARROW_SIZE_MIN, size))
}
export type ArrowStyle = (typeof ARROW_STYLES)[number]

export interface LineNode extends NodeBase {
  type: 'line'
  points: readonly number[]
  stroke: string
  strokeWidth: number
  opacity: number
}

export interface TextNode extends NodeBase, BoxGeometry {
  type: 'text'
  text: string
  /**
   * Set once a top, bottom or corner handle (or the H field) sizes the box, and both renderers clip
   * the text to it. Absent is auto-height, where the renderer measures `height` from the text.
   */
  fixedHeight?: true
  /** A family from `TEXT_FONTS`, or one picked on another machine; absent is the system font. */
  fontFamily?: string
  italic?: true
  /**
   * Filled text: a rounded box in this colour behind the text, the box being the node's
   * own `width` × `height` with the text inset by `textInset`. Absent is plain text, which is what
   * every text node stored before it reads as.
   */
  fill?: string
  /** A filled box's pointer, in the node's own units; drawn only when it lands outside the box. */
  tip?: { x: number; y: number }
  /** The outline: `'none'` or a colour, drawn under the fill so half its width shows outside. */
  stroke: string
  strokeWidth: number
  fontSize: number
  fontWeight: number
  align: 'left' | 'center' | 'right'
  color: string
  opacity: number
}

export interface BlurNode extends NodeBase, BoxGeometry {
  type: 'blur'
  /** StackBlur radius in scene units. Capped well below a band height, so a blur never spans one. */
  radius: number
  opacity: number
}

export interface HighlightNode extends NodeBase, BoxGeometry {
  type: 'highlight'
  color: string
  opacity: number
}

export interface EmojiNode extends NodeBase, BoxGeometry {
  type: 'emoji'
  /** One native glyph. Chrome rasterises colour emoji to a canvas, so both renderers get it free. */
  char: string
  fontSize: number
  opacity: number
}

/**
 * A numbered badge: a filled disc with an integer in it, for numbering steps in a bug report or a
 * how-to.
 *
 * It is a circle, so `width` and `height` are always the same number -- the diameter -- which is why
 * it takes the corner-only, ratio-held anchors an emoji does. The digits carry **no font size of
 * their own**: `counterFontSize` derives it from the diameter and the digit count, so growing the
 * badge grows its number and a 12 never spills out of a disc sized for a 1. One knob, not two.
 *
 * The small tilt each badge gets is not a field here. It goes in `transform.rotation` at
 * creation, which already exists, already renders, and already has an inspector row to straighten it
 * with.
 */
/**
 * A freehand stroke: the pen, and the marker that shares its geometry.
 *
 * `marker` is the whole difference between the two tools -- it swaps the fill for `multiply`, which
 * tints what is under it instead of painting over it. One node type rather than two because the
 * geometry, the parse, both renderers, the bounds and the fold are identical; a second type would
 * duplicate all of that for one composite operation.
 *
 * **Why multiply stays cheap here.** It is a per-pixel operation local to the pixels the stroke
 * covers, so the banded export draws each band's slice of a stroke correctly without any of the
 * overlap machinery blur needs. That property is what made the rectangle highlight cheap, and
 * a freehand highlight keeps it -- only the input model changes.
 *
 * `points` are already resampled and smoothed by `smoothStroke` when the stroke is committed; the
 * raw pointer samples are never stored.
 */
export interface FreehandNode extends NodeBase {
  type: 'freehand'
  /** Flat `[x0, y0, x1, y1, ...]` in the node's own frame. */
  points: readonly number[]
  stroke: string
  strokeWidth: number
  /** A marker tints rather than paints: `multiply`, as the rectangle highlight does. */
  marker?: true
  opacity: number
}

export interface CounterNode extends NodeBase, BoxGeometry {
  type: 'counter'
  /** The integer shown. `nextCount` picks it; the inspector's `#` row can overwrite it. */
  count: number
  /** The disc. */
  fill: string
  /** The digits. */
  color: string
  /**
   * The pin's point, in the node's own frame, or absent for a plain disc.
   *
   * Outside the disc it pulls a teardrop tail out to itself, which is what lets a badge sit clear of
   * the thing it labels and still point at it. Inside the disc it draws nothing -- dragging the tip
   * into the badge is how you take the tail off.
   */
  tip?: { x: number; y: number }
  opacity: number
}

/**
 * A magnifier: the node's own box is the **source**, the area magnified, and it
 * takes the usual handles. The **lens** shows that area bigger, joined to it by a line. Both frames are
 * a rectangle or a squircle.
 */
export interface MagnifierNode extends NodeBase, BoxGeometry {
  type: 'magnifier'
  /**
   * The lens's **centre**, in the node's **parent** frame, not its own, and its zoom: moving the
   * source leaves the lens where it is, and resizing the source resizes the lens
   * about its centre by the same proportion, so the picture is never stretched and the zoom holds
   * (a stored width made a widened source's lens shorter).
   */
  lens: { x: number; y: number; zoom: number }
  shape: MagnifierShape
  /** A squircle's roundness, 0-100: 0 is nearly square, 100 an oval. See `framePower`. */
  roundness: number
  /** The border of both frames and the joining line. */
  stroke: string
  strokeWidth: number
  opacity: number
}

export const MAGNIFIER_SHAPES = ['rectangle', 'squircle'] as const

export const DEFAULT_SQUIRCLE_ROUNDNESS = 85

/**
 * The frame's superellipse exponent, |x|ⁿ + |y|ⁿ = 1, or `undefined` for a rectangle. Roundness 100
 * is n = 2, an oval; 0 is n = 10, all but square. n = 4 looked too square.
 */
export function framePower(node: Pick<MagnifierNode, 'shape' | 'roundness'>): number | undefined {
  return node.shape === 'rectangle' ? undefined : 2 + (1 - Math.min(100, Math.max(0, node.roundness)) / 100) * 8
}
export type MagnifierShape = (typeof MAGNIFIER_SHAPES)[number]

/**
 * A picture the user added, by the Image tool or by dropping a file on the canvas. `src` is the
 * picture itself as a `data:image/…` URL, so it is saved with the document like every other edit and
 * no second store is needed. `width`/`height` are the box it is drawn into; the corners hold its ratio.
 */
export interface ImageNode extends NodeBase, BoxGeometry {
  type: 'image'
  src: string
  opacity: number
}

/** Only raster pictures a canvas can draw without tainting it; an SVG could reach for anything. */
export function isImageSource(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(value)
}

/**
 * A group is organisational, not a rendering boundary. The render walk flattens the
 * tree in document order, so a blur inside a group blurs content outside and below that group, and
 * the blur rule reads identically whether or not any groups exist. It owns no geometry: its bounds
 * are the union of its children's, and it does not clip.
 */
export interface GroupNode extends NodeBase {
  type: 'group'
  children: SceneNode[]
  opacity: number
}

export type ShapeNode =
  | RectangleNode
  | EllipseNode
  | ArrowNode
  | LineNode
  | TextNode
  | BlurNode
  | HighlightNode
  | EmojiNode
  | CounterNode
  | MagnifierNode
  | FreehandNode
  | ImageNode

export type KnownNode = ShapeNode | GroupNode
export type ShapeType = ShapeNode['type']

/**
 * A node written by a newer version of the extension. Parsed documents keep these verbatim —
 * destroying data the reader does not understand is how a downgrade silently corrupts someone's
 * work — and both renderers skip them, because a node whose type you cannot read has no bounds you
 * can trust either.
 */
export interface UnknownNode {
  id: string
  type: string
  [key: string]: unknown
}

export type SceneNode = KnownNode | UnknownNode

const SHAPE_TYPES: readonly string[] = [
  'rectangle',
  'ellipse',
  'arrow',
  'line',
  'text',
  'blur',
  'highlight',
  'emoji',
  'counter',
  'freehand',
  'magnifier',
  'image',
]

/**
 * These guards test structure, not just the `type` string, and that is load-bearing rather than
 * defensive. `parseNode` keeps an over-deep group (past the depth cap) as an `UnknownNode` with its
 * children still raw — it carries `type: 'group'` but no parsed `transform`. A guard that trusted
 * the string alone would hand the resolver a group it cannot walk.
 */
export function isShapeNode(node: SceneNode): node is ShapeNode {
  return SHAPE_TYPES.includes(node.type) && 'transform' in node
}

export function isGroupNode(node: SceneNode): node is GroupNode {
  return node.type === 'group' && 'transform' in node && Array.isArray((node as GroupNode).children)
}

export function isKnownNode(node: SceneNode): node is KnownNode {
  return isShapeNode(node) || isGroupNode(node)
}

// --- the document ------------------------------------------------------------

/**
 * Canvas properties — the ones that belong to the output rather than to the browser frame.
 *
 * Background and margin live here rather than inside `present` because the margin applies to
 * `outputRect` unconditionally, whether or not Present is on. A margin control that disappears with
 * the frame is a control that lies about what the margin does; today's result page has exactly that
 * bug, and this is the correction.
 *
 * `margin` is in **design units** — one CSS pixel of the captured page — matching the existing
 * `PresentOptions.padding` it is seeded from. `outputRect` multiplies by `captureDensity`.
 */
export interface CanvasOptions {
  background: PresentOptions['background']
  customColor: string
  margin: number
}

export interface SceneDoc {
  version: number
  /**
   * The capture's own size in scene units. Known before editing starts and never changed by it, so
   * every other rectangle in this file is derived from content while this one simply is.
   */
  capture: { width: number; height: number; density: number }
  canvas: CanvasOptions
  /**
   * The browser frame's configuration. Reuses the shape the result page already persists so that
   * moving Present into the editor changes where the controls live, not what is stored. `on`, and
   * only `on`, decides whether `frameRect` grows.
   *
   * `background`, `customColor` and `padding` are carried on this object too, because the type is
   * shared with the result page — but `canvas` above is the authority for all three. Nothing in
   * this module reads them from here.
   */
  present: PresentOptions
  /**
   * An explicit rectangle in scene space. When set it *is* `outputRect`; `contentRect` is ignored
   * entirely. It clips, it does not delete: a shape outside it still exists and returns when
   * the crop is cleared.
   */
  crop?: Rect
  /** The annotation tree's root children. Index 0 is the bottom-most. */
  nodes: SceneNode[]
}

let idCounter = 0

/** Locally unique node id. Ids never leave the device, so entropy is not a concern. */
export function newNodeId(): string {
  idCounter += 1
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`
}

export function emptyDoc(width: number, height: number, density = 1): SceneDoc {
  return {
    version: SCENE_DOC_VERSION,
    capture: { width, height, density },
    canvas: {
      background: DEFAULT_PRESENT_OPTIONS.background,
      customColor: DEFAULT_PRESENT_OPTIONS.customColor,
      margin: DEFAULT_PRESENT_OPTIONS.padding,
    },
    present: { ...DEFAULT_PRESENT_OPTIONS },
    nodes: [],
  }
}

/** The modifiers held during a draw gesture. */
export interface DrawModifiers {
  shift: boolean
  alt: boolean
}

/** The box tools, whose Shift constraint is a square -- which an ellipse draws as a circle. */
const SQUARE_TOOLS: readonly ShapeType[] = ['rectangle', 'ellipse', 'blur', 'highlight', 'emoji']

/**
 * The drag a draw gesture actually commits, once Shift and Alt have had their say.
 *
 * Lives here, and is called from both the draft and the commit, for the reason `nodeFromDrag` does:
 * a constraint applied on only one of the two paths would draw one shape and commit a different one.
 * Shift while drawing makes a circle, and snaps a line to 15 degree increments; this is where both
 * are applied.
 */
export function constrainDrag(
  tool: ShapeType,
  start: { x: number; y: number },
  end: { x: number; y: number },
  modifiers: DrawModifiers,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  // Text is sized by its content and reflows on the first keystroke, so neither modifier means
  // anything to it.
  if (tool === 'text') return { start, end }
  let point = end
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (modifiers.shift && SQUARE_TOOLS.includes(tool)) {
    // The longer axis wins, so the shape follows the pointer out rather than collapsing behind it.
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    point = { x: start.x + (dx < 0 ? -side : side), y: start.y + (dy < 0 ? -side : side) }
  } else if (modifiers.shift && (tool === 'arrow' || tool === 'line')) {
    // 45 degree increments: the pointer's distance is kept and only its angle is rounded, so the
    // line's tip stays under the hand instead of jumping to a projection of it.
    const step = Math.PI / 4
    const angle = Math.round(Math.atan2(dy, dx) / step) * step
    const length = Math.hypot(dx, dy)
    point = { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length }
  }
  if (!modifiers.alt) return { start, end: point }
  // Alt draws from the centre: the press point becomes the middle, so the shape grows both ways.
  return { start: { x: start.x - (point.x - start.x), y: start.y - (point.y - start.y) }, end: point }
}

/**
 * The digit size a badge of this diameter wears, so the number always fits the disc.
 *
 * Derived rather than stored: a counter has one size knob, its diameter, and a stored font size
 * would let the two drift until a two-digit badge spilled out of a disc sized for a one-digit one.
 * The steps are per digit count, because that is the only thing that changes how wide the number is.
 */
/**
 * How far apart the points of a committed stroke sit, in scene units at density 1, and the ceiling
 * on how many of them a single stroke may keep.
 */
export const STROKE_SPACING = 4
export const STROKE_MAX_POINTS = 3000

/**
 * Raw pointer samples into the stroke that is actually stored: **resampled at an even spacing, then
 * smoothed**.
 *
 * Resampling first is what makes the smoothing behave. A pointer emits samples by *time*, not by
 * distance, so a slow careful curve arrives as a dense cluster and a fast flick as four points far
 * apart; smoothing that directly rounds off the slow parts and leaves the fast parts angular. Once
 * the points are evenly spaced, one pass of a weighted average treats the whole stroke alike.
 *
 * The average is 1-2-1 over each point and its neighbours, with **both ends pinned** -- a stroke
 * whose ends creep inwards as it is smoothed does not end where the user lifted the pointer.
 *
 * What this deliberately does not do is shape correction, which straightens a near-line
 * and closes a near-circle into the shape it thinks you meant. That is a separate feature and a much
 * larger one; this only removes the tremor.
 *
 * ponytail: one averaging pass. Two passes read smoother on a shaky hand and cost another O(n) walk
 * -- make it a parameter if anyone asks for a smoothing strength.
 */
export function smoothStroke(raw: readonly number[], spacing: number): number[] {
  const resampled = resampleStroke(raw, spacing)
  if (resampled.length <= 4) return resampled
  const out = resampled.slice()
  for (let index = 1; index < resampled.length / 2 - 1; index += 1) {
    const at = index * 2
    for (const axis of [0, 1]) {
      const previous = resampled[at - 2 + axis] ?? 0
      const current = resampled[at + axis] ?? 0
      const next = resampled[at + 2 + axis] ?? 0
      out[at + axis] = previous * 0.25 + current * 0.5 + next * 0.25
    }
  }
  return out
}

/**
 * The same path walked at a fixed step, so the points are evenly spaced however fast it was drawn.
 *
 * The last raw point is always kept, whatever the step leaves over, because that is where the user
 * lifted the pointer and a stroke that stops short of it looks like a dropped frame.
 */
export function resampleStroke(raw: readonly number[], spacing: number): number[] {
  const step = Math.max(0.5, spacing)
  const count = Math.floor(raw.length / 2)
  if (count === 0) return []
  const firstX = raw[0] ?? 0
  const firstY = raw[1] ?? 0
  if (count === 1) return [firstX, firstY]
  const out = [firstX, firstY]
  let anchorX = firstX
  let anchorY = firstY
  for (let index = 1; index < count; index += 1) {
    const x = raw[index * 2] ?? 0
    const y = raw[index * 2 + 1] ?? 0
    let distance = Math.hypot(x - anchorX, y - anchorY)
    // A single long segment can owe several points, so this walks along it rather than emitting one.
    while (distance >= step && out.length < STROKE_MAX_POINTS * 2) {
      const ratio = step / distance
      anchorX += (x - anchorX) * ratio
      anchorY += (y - anchorY) * ratio
      out.push(anchorX, anchorY)
      distance = Math.hypot(x - anchorX, y - anchorY)
    }
  }
  const lastX = raw[count * 2 - 2] ?? 0
  const lastY = raw[count * 2 - 1] ?? 0
  const tailX = out[out.length - 2] ?? 0
  const tailY = out[out.length - 1] ?? 0
  if (Math.hypot(lastX - tailX, lastY - tailY) > 0.01) out.push(lastX, lastY)
  return out
}

/** A fresh pin's point, placed relative to a badge of this diameter. */
export function defaultCounterTip(diameter: number): { x: number; y: number } {
  const radians = (COUNTER_TIP_ANGLE * Math.PI) / 180
  return {
    x: diameter / 2 + Math.cos(radians) * diameter * COUNTER_TIP_REACH,
    y: diameter / 2 + Math.sin(radians) * diameter * COUNTER_TIP_REACH,
  }
}

/**
 * The two angles at which the tail leaves the disc: where the tangent lines from the tip touch it.
 *
 * This is what makes the tail meet the circle smoothly instead of as a triangle stuck on the side.
 * `undefined` when the tip is inside the disc, or so close to its edge that the tangents collapse --
 * dragging the tip into the badge is how the user takes the tail off, so that is a shape, not an
 * error.
 */
export function counterTangents(
  diameter: number,
  tip: { x: number; y: number } | undefined,
): { from: number; to: number } | undefined {
  if (!tip) return undefined
  const radius = diameter / 2
  const dx = tip.x - radius
  const dy = tip.y - radius
  const distance = Math.hypot(dx, dy)
  // A hair outside the radius, or the two tangent points sit on top of each other and the tail is a
  // zero-width spike that reads as a rendering fault.
  if (distance <= radius * 1.05) return undefined
  const centre = Math.atan2(dy, dx)
  const spread = Math.acos(radius / distance)
  return { from: centre + spread, to: centre - spread }
}

/**
 * The commands that draw a badge: a plain disc, or the teardrop when it has a tail.
 *
 * **Both renderers call this one function**, rather than each drawing its own arc. The digits above
 * had to be placed twice and kept in agreement by hand (Konva is the reference and
 * the export mimics it); this shape does not, because Konva's `sceneFunc` hands out the same
 * Canvas2D path API the export already writes to. Agreement by construction beats agreement by
 * inspection, so anywhere the seam allows it, prefer this.
 *
 * The arc runs the **major** way around -- from one tangent point the long way to the other -- so the
 * near side of the circle is left open for the tail to close across.
 */
export function counterPath(sink: CounterPathSink, diameter: number, tip?: { x: number; y: number }): void {
  const radius = diameter / 2
  const tangents = counterTangents(diameter, tip)
  sink.beginPath()
  if (!tangents || !tip) {
    sink.arc(radius, radius, radius, 0, Math.PI * 2, false)
    return
  }
  sink.arc(radius, radius, radius, tangents.from, tangents.to, false)
  sink.lineTo(tip.x, tip.y)
  sink.closePath()
}

/** The slice of Canvas2D `counterPath` needs. Konva's `sceneFunc` context satisfies it too. */
export interface CounterPathSink {
  beginPath(): void
  arc(x: number, y: number, radius: number, start: number, end: number, anticlockwise?: boolean): void
  lineTo(x: number, y: number): void
  closePath(): void
}

/**
 * How far a filled text box's text sits in from its edges. Proportional to the font, so a bigger
 * font gets a bigger box; zero for plain text, whose box is its text.
 */
export function textInset(node: { fontSize: number; fill?: string }): { x: number; y: number } {
  return node.fill === undefined ? { x: 0, y: 0 } : { x: node.fontSize * 0.45, y: node.fontSize * 0.2 }
}

/** Where a new filled box's pointer starts: below it, a third of the way along. */
export function defaultTextTip(node: { width: number; height: number; fontSize: number }): { x: number; y: number } {
  return { x: node.width * 0.3, y: node.height + node.fontSize * 1.6 }
}

/** Whether the pointer draws: only from outside the box. Dragged back inside, it is put away. */
export function textTailShown(node: { width: number; height: number; tip?: { x: number; y: number } }): boolean {
  const tip = node.tip
  return tip !== undefined && (tip.x < 0 || tip.y < 0 || tip.x > node.width || tip.y > node.height)
}

/**
 * A filled text box and its pointer, as one path both renderers fill -- agreement by construction,
 * as `counterPath` is. Two sub-paths wound the same way, so the non-zero fill is their union and a
 * translucent box is blended once where the pointer overlaps it.
 *
 * The pointer leaves the box where the line from the box's centre to the tip crosses its edge. Its
 * two sides are quadratic curves whose control points lie *on that edge*, so each side leaves the box
 * tangent to it -- the join is smooth, not a corner -- and bows inward on its way to a fine point.
 */
export function textBubblePath(sink: TextBubbleSink, node: { width: number; height: number; fontSize: number; tip?: { x: number; y: number } }): void {
  const { width, height } = node
  const radius = bubbleRadius(node)
  sink.beginPath()
  // Clockwise on screen: top edge left to right, then down the right side.
  sink.moveTo(radius, 0)
  sink.lineTo(width - radius, 0)
  sink.arcTo(width, 0, width, radius, radius)
  sink.lineTo(width, height - radius)
  sink.arcTo(width, height, width - radius, height, radius)
  sink.lineTo(radius, height)
  sink.arcTo(0, height, 0, height - radius, radius)
  sink.lineTo(0, radius)
  sink.arcTo(0, 0, radius, 0, radius)
  sink.closePath()
  const tip = node.tip
  if (!tip || !textTailShown(node)) return
  const joint = pointerJoint(node, tip, radius)
  if (!joint) return
  const { edge } = joint
  let { a, b } = joint
  // Same winding as the box, or non-zero would cut the overlap out of it instead of joining them.
  const winding = (a.x * tip.y - tip.x * a.y) + (tip.x * b.y - b.x * tip.y) + (b.x * a.y - a.x * b.y)
  if (winding < 0) [a, b] = [b, a]
  // Each side is a cubic: it leaves the box along the edge (its first control point is on the edge),
  // and arrives heading straight down the pointer's axis, where a semicircle of `round` turns it
  // round the tip. Tangent at both joins, so there is no corner anywhere -- the old quadratic cap
  // left one each side. The semicircle's far point is exactly the tip.
  const length = Math.hypot(tip.x - edge.x, tip.y - edge.y)
  const dx = (tip.x - edge.x) / length
  const dy = (tip.y - edge.y) / length
  const round = Math.max(0.5, Math.min(node.fontSize * 0.12, length / 6))
  // Square to the axis, on `a`'s side. Along the edge instead, a slanted pointer met its round at an
  // angle -- a corner each side of the tip.
  const toward = -dy * (a.x - edge.x) + dx * (a.y - edge.y) >= 0 ? 1 : -1
  const nx = -dy * round * toward
  const ny = dx * round * toward
  const cx = tip.x - dx * round
  const cy = tip.y - dy * round
  const reach = length * 0.12
  const onEdge = 0.7
  // The far side's control point sits near the axis, so it runs a long way along the edge before it
  // turns up to the tip in a long sweep. The near side's, close to its base point, is a short flare.
  // By identity, since the winding check above may have swapped the two.
  const run = (point: { x: number; y: number }): number => (point === joint.b ? 0.15 : onEdge)
  sink.moveTo(a.x, a.y)
  sink.bezierCurveTo(
    edge.x + (a.x - edge.x) * run(a), edge.y + (a.y - edge.y) * run(a),
    cx + nx - dx * reach, cy + ny - dy * reach,
    cx + nx, cy + ny,
  )
  // Round the tip from the `a` side to the `b` side, through the tip: the sweep whose middle is the
  // axis. Rotating `n` a quarter turn clockwise on screen gives the axis when the sweep is clockwise.
  const start = Math.atan2(ny, nx)
  sink.arc(cx, cy, round, start, start + Math.PI, -ny * dx + nx * dy < 0)
  sink.bezierCurveTo(
    cx - nx - dx * reach, cy - ny - dy * reach,
    edge.x + (b.x - edge.x) * run(b), edge.y + (b.y - edge.y) * run(b),
    b.x, b.y,
  )
  sink.closePath()
}

/**
 * Whether a point in a counter's or a filled text's own units lands on what is drawn, not merely in
 * its bounds. The bounds include the pointer's tip, so their corner between the shape and the tip is
 * empty page -- and a click there has to miss, or it can never deselect. The
 * pointer is tested as the triangle of its base and tip, a hair fuller than the curved sides.
 */
export function pointerShapeHit(node: CounterNode | TextNode, x: number, y: number): boolean {
  const tip = node.tip
  if (node.type === 'counter') {
    const r = node.width / 2
    if (Math.hypot(x - r, y - r) <= r) return true
    const tangents = counterTangents(node.width, tip)
    if (!tangents || !tip) return false
    const a = { x: r + r * Math.cos(tangents.from), y: r + r * Math.sin(tangents.from) }
    const b = { x: r + r * Math.cos(tangents.to), y: r + r * Math.sin(tangents.to) }
    return inTriangle({ x, y }, a, tip, b) || inTriangle({ x, y }, a, b, { x: r, y: r })
  }
  if (x >= 0 && y >= 0 && x <= node.width && y <= node.height) return true
  if (node.fill === undefined || !tip || !textTailShown(node)) return false
  const joint = pointerJoint(node, tip, bubbleRadius(node))
  if (!joint) return false
  return inTriangle({ x, y }, joint.a, tip, joint.b)
}

function inTriangle(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  const cross = (u: { x: number; y: number }, v: { x: number; y: number }): number => (v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x)
  const one = cross(a, b)
  const two = cross(b, c)
  const three = cross(c, a)
  return (one >= 0 && two >= 0 && three >= 0) || (one <= 0 && two <= 0 && three <= 0)
}

/** A filled text box's corner radius, which the box path and the pointer's base both keep clear of. */
function bubbleRadius(node: { width: number; height: number; fontSize: number }): number {
  return Math.max(0, Math.min(node.fontSize * 0.3, node.width / 2, node.height / 2))
}

/**
 * Where the pointer meets the box: its axis point on the edge, and its two base points `a` and `b`.
 *
 * The edge is the top or bottom when the tip is above or below, a side only when it is level with the
 * box. The axis point sits halfway from that edge's middle towards the tip. The base is
 * **asymmetric**: the side facing the tip joins near the axis, and the far side reaches on past the
 * middle of the edge, so its long run into the edge sweeps in gently. Nothing here reads the box's other
 * dimension, so a box that grows a line keeps its pointer.
 */
function pointerJoint(
  node: { width: number; height: number; fontSize: number },
  tip: { x: number; y: number },
  radius: number,
): { edge: { x: number; y: number }; a: { x: number; y: number }; b: { x: number; y: number } } | undefined {
  const { width, height } = node
  const outX = tip.x < 0 ? -tip.x : tip.x > width ? tip.x - width : 0
  const outY = tip.y < 0 ? -tip.y : tip.y > height ? tip.y - height : 0
  if (outX === 0 && outY === 0) return undefined
  // Top or bottom whenever the tip is above or below: a text box is wide and short, and a tip up and
  // to the left left through the short side, crammed into the corner.
  const across = outY > 0
  const length = across ? width : height
  const mid = length / 2
  const toward = across ? tip.x : tip.y
  const room = length / 2 - radius
  // The near side: a fifth of the tip's reach from the axis, never under half the font, so a far
  // pointer is a wedge and not a line.
  const near = Math.min(Math.max(node.fontSize * 0.5, Math.hypot(outX, outY) * 0.2), room)
  if (near <= 0) return undefined
  const lo = radius
  const hi = length - radius
  const axis = Math.min(Math.max((mid + toward) / 2, lo + near), hi - near)
  const side = toward < mid ? -1 : 1
  const nearAt = axis + side * near
  // The far side: towards a fifth of the edge past its middle, but no further from the axis than
  // 0.6 × the tip's reach, so a short pointer keeps a short base; never nearer than the near side.
  const reach = Math.hypot(outX, outY)
  const far = Math.max(near, Math.min(reach * 0.6, Math.abs(mid - side * length * 0.2 - axis)))
  const farAt = Math.min(Math.max(axis - side * far, lo), hi)
  const at = (value: number): { x: number; y: number } =>
    across ? { x: value, y: tip.y > height ? height : 0 } : { x: tip.x > width ? width : 0, y: value }
  return { edge: at(axis), a: at(nearAt), b: at(farAt) }
}

/**
 * Resizes a text box and carries its pointer with the edge it is beyond, so the pointer keeps its
 * shape: a tip below a box that grows a line moves down by that line, rather than the box swallowing
 * the pointer. A tip alongside the box keeps its place along the side in proportion.
 */
export function resizeTextBox(node: TextNode, width: number, height: number): void {
  const follow = (value: number, before: number, after: number): number =>
    value >= before ? value + after - before : value <= 0 ? value : before > 0 ? (value * after) / before : value
  if (node.tip) node.tip = { x: follow(node.tip.x, node.width, width), y: follow(node.tip.y, node.height, height) }
  node.width = width
  node.height = height
}

/** The slice of a 2D context `textBubblePath` needs; Konva's context and a canvas's both have it. */
export interface TextBubbleSink {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, start: number, end: number, anticlockwise?: boolean): void
  closePath(): void
}

/**
 * The small random tilt each badge is dealt, so a column of them reads as placed by hand rather than
 * stamped by a machine.
 *
 * It lands in `transform.rotation`, so the inspector's R row straightens it like any other rotation.
 */
export function counterTilt(): number {
  return (Math.random() * 2 - 1) * COUNTER_TILT
}

export function counterFontSize(diameter: number, count: number): number {
  const digits = String(Math.abs(Math.trunc(count))).length
  const share = digits <= 1 ? 0.56 : digits === 2 ? 0.46 : 0.34
  return Math.max(1, diameter * share)
}

/**
 * The number the next badge gets: one past the highest already in the document.
 *
 * Derived from the document rather than kept as editor state, which is what makes it survive undo,
 * redo, a reload and a second editor session without a counter anywhere to drift. Deleting badge 2
 * of three leaves 1 and 3 alone -- renumbering them would move numbers the user has already
 * referred to in the text beside the screenshot.
 */
export function nextCount(nodes: readonly SceneNode[]): number {
  let highest = 0
  const walk = (list: readonly SceneNode[]): void => {
    for (const node of list) {
      if (isGroupNode(node)) walk(node.children)
      else if (isShapeNode(node) && node.type === 'counter') highest = Math.max(highest, node.count)
    }
  }
  walk(nodes)
  return highest + 1
}

/**
 * The node a drag makes, at factory values -- `applyToolDefaults` then writes the saved default over
 * it. Lives here rather than in `editor.ts` because the defaults sheet builds its sample shapes from
 * the very same factory: a sample drawn from a second table would drift from what drawing produces.
 */
export function nodeFromDrag(
  tool: ShapeType,
  start: { x: number; y: number },
  end: { x: number; y: number },
  density: number,
): ShapeNode | undefined {
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  // Text and Counter are the two tools a plain click places: a counter is stamped where you click,
  // at its default diameter, so a QA pass can number ten things with ten clicks.
  if (tool !== 'text' && tool !== 'counter' && tool !== 'freehand' && (width < MIN_SHAPE_SIZE || height < MIN_SHAPE_SIZE)) return undefined
  const base = { id: newNodeId(), transform: { ...IDENTITY, x: left, y: top } }
  const strokeWidth = Math.max(2, 3 * density)

  switch (tool) {
    case 'rectangle':
      return { ...base, type: 'rectangle', width, height, stroke: DEFAULT_STROKE, strokeWidth, fill: 'none', radius: 0, opacity: 1 }
    case 'ellipse':
      return { ...base, type: 'ellipse', width, height, stroke: DEFAULT_STROKE, strokeWidth, fill: 'none', opacity: 1 }
    case 'magnifier':
      // The lens starts three times the source's size, beside it on the right; `placeLens` moves it
      // left when there is no room, which this function cannot see.
      return {
        ...base,
        type: 'magnifier',
        width,
        height,
        lens: { x: left + width + 24 * density + (width * 3) / 2, y: top + height / 2, zoom: 3 },
        // A squircle by default, at 85% roundness.
        shape: 'squircle',
        roundness: DEFAULT_SQUIRCLE_ROUNDNESS,
        stroke: DEFAULT_STROKE,
        strokeWidth,
        opacity: 1,
      }
    case 'arrow':
      return { ...base, transform: { ...IDENTITY, x: start.x, y: start.y }, type: 'arrow', points: [0, 0, end.x - start.x, end.y - start.y], stroke: DEFAULT_STROKE, strokeWidth, headSize: 9 * density, opacity: 1, style: 'solid', size: 100 }
    case 'line':
      return { ...base, transform: { ...IDENTITY, x: start.x, y: start.y }, type: 'line', points: [0, 0, end.x - start.x, end.y - start.y], stroke: DEFAULT_STROKE, strokeWidth, opacity: 1 }
    case 'text':
      // Empty, because the text editor opens on top of it the moment it is placed. Placing the word
      // "Text" and leaving no way to change it is the defect this replaces.
      return { ...base, type: 'text', width: Math.max(width, 180 * density), height: 24 * density, text: '', fontSize: 20 * density, fontWeight: 500, align: 'left', color: DEFAULT_STROKE, stroke: 'none', strokeWidth: 2 * density, opacity: 1 }
    case 'blur':
      return { ...base, type: 'blur', width, height, radius: 18 * density, opacity: 1 }
    case 'highlight':
      return { ...base, type: 'highlight', width, height, color: DEFAULT_HIGHLIGHT, opacity: 0.35 }
    case 'emoji': {
      const size = Math.max(width, height)
      return { ...base, type: 'emoji', char: '\u{1F642}', fontSize: size, width: size, height: size, opacity: 1 }
    }
    case 'freehand':
      // A stroke is not built from a drag rectangle -- `finishStroke` in the editor commits the real
      // points. This exists for the two callers that want a *representative* node without one: the
      // draft's style probe, and the defaults sheet's sample shape.
      return {
        ...base,
        transform: { ...IDENTITY, x: start.x, y: start.y },
        type: 'freehand',
        points: [0, 0, (end.x - start.x) / 2, (end.y - start.y) / 4, end.x - start.x, end.y - start.y],
        stroke: DEFAULT_STROKE,
        strokeWidth,
        opacity: 1,
      }
    case 'counter': {
      // A click gets the default diameter centred on the press point -- you click the thing you are
      // numbering, not its top-left corner. A real drag sizes the badge from its longer side.
      const dragged = Math.max(width, height)
      const size = dragged < MIN_SHAPE_SIZE ? COUNTER_DIAMETER * density : dragged
      const centre = dragged < MIN_SHAPE_SIZE ? { x: start.x - size / 2, y: start.y - size / 2 } : { x: left, y: top }
      return {
        ...base,
        // `count` is a placeholder: the commit overwrites it with `nextCount` against the live
        // document, which this function cannot see. The defaults sheet draws its sample from here,
        // and a sample badge reading 1 is exactly right.
        transform: { ...IDENTITY, x: centre.x, y: centre.y, rotation: counterTilt() },
        type: 'counter',
        count: 1,
        width: size,
        height: size,
        tip: defaultCounterTip(size),
        fill: DEFAULT_COUNTER_FILL,
        color: DEFAULT_COUNTER_DIGITS,
        opacity: 1,
      }
    }
  }
}

// --- parsing -----------------------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown }
  return typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function opacity(value: unknown): number {
  return Math.min(1, Math.max(0, num(value, 1)))
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function parseTransform(value: unknown): Transform {
  const raw = record(value)
  const scaleX = num(raw.scaleX, 1)
  const scaleY = num(raw.scaleY, 1)
  return {
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    // A zero scale collapses a node to nothing and makes its inverse undefined. Refuse it.
    scaleX: scaleX === 0 ? 1 : scaleX,
    scaleY: scaleY === 0 ? 1 : scaleY,
    rotation: num(raw.rotation, 0),
  }
}

function parsePoints(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 4) return [0, 0, MIN_SHAPE_SIZE, 0]
  const points = value.slice(0, 4).map((entry) => num(entry, 0))
  return points.length === 4 ? points : [0, 0, MIN_SHAPE_SIZE, 0]
}

function common(raw: Record<string, unknown>, id: string): NodeBase {
  return {
    id,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    transform: parseTransform(raw.transform),
  }
}

function size(raw: Record<string, unknown>): BoxGeometry {
  return {
    width: Math.max(MIN_SHAPE_SIZE, num(raw.width, MIN_SHAPE_SIZE)),
    height: Math.max(MIN_SHAPE_SIZE, num(raw.height, MIN_SHAPE_SIZE)),
  }
}

/**
 * Parses one node, or returns it untouched when its type is not one this build knows.
 *
 * Depth is capped at 5 — past that the layers panel's indent eats the
 * name column. A document nested deeper than that is not rejected: the over-deep group is kept as an
 * unknown node, so its contents survive a round-trip through an older build rather than being
 * silently flattened or dropped.
 */
export const MAX_GROUP_DEPTH = 5

function parseNode(value: unknown, depth: number): SceneNode | undefined {
  const raw = record(value)
  const id = str(raw.id, '')
  if (id === '') return undefined
  const base = common(raw, id)

  switch (raw.type) {
    case 'rectangle':
      return {
        ...base,
        ...size(raw),
        type: 'rectangle',
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 6)),
        fill: str(raw.fill, 'none'),
        radius: Math.max(0, num(raw.radius, 0)),
        opacity: opacity(raw.opacity),
      }
    case 'ellipse':
      return {
        ...base,
        ...size(raw),
        type: 'ellipse',
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 6)),
        fill: str(raw.fill, 'none'),
        opacity: opacity(raw.opacity),
      }
    case 'arrow':
      return {
        ...base,
        type: 'arrow',
        points: parsePoints(raw.points),
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 6)),
        headSize: Math.max(0, num(raw.headSize, 18)),
        opacity: opacity(raw.opacity),
        style: ARROW_STYLES.includes(raw.style as ArrowStyle) ? (raw.style as ArrowStyle) : 'solid',
        ...(isPoint(raw.bend) ? { bend: { x: raw.bend.x, y: raw.bend.y } } : {}),
        // An arrow from before Size keeps the thickness it had, as near as the range allows.
        size:
          typeof raw.size === 'number' && Number.isFinite(raw.size)
            ? Math.min(ARROW_SIZE_MAX, Math.max(ARROW_SIZE_MIN, raw.size))
            : arrowSizeFor(parsePoints(raw.points), Math.max(0, num(raw.strokeWidth, 6))),
      }
    case 'line':
      return {
        ...base,
        type: 'line',
        points: parsePoints(raw.points),
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 6)),
        opacity: opacity(raw.opacity),
      }
    case 'text':
      return {
        ...base,
        ...size(raw),
        type: 'text',
        text: str(raw.text, ''),
        ...(raw.fixedHeight === true ? { fixedHeight: true } : {}),
        fontSize: Math.max(1, num(raw.fontSize, 20)),
        fontWeight: Math.max(1, num(raw.fontWeight, 400)),
        ...(typeof raw.fontFamily === 'string' && raw.fontFamily.trim() !== '' ? { fontFamily: raw.fontFamily.trim() } : {}),
        ...(raw.italic === true ? { italic: true } : {}),
        ...(typeof raw.fill === 'string' && raw.fill !== '' && raw.fill !== 'none' ? { fill: raw.fill } : {}),
        ...(isPoint(raw.tip) ? { tip: { x: raw.tip.x, y: raw.tip.y } } : {}),
        stroke: str(raw.stroke, 'none'),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 2)),
        align: oneOf(raw.align, ['left', 'center', 'right'] as const, 'left'),
        color: str(raw.color, DEFAULT_STROKE),
        opacity: opacity(raw.opacity),
      }
    case 'magnifier': {
      const box = size(raw)
      const lens = raw.lens as { x?: unknown; y?: unknown; zoom?: unknown } | undefined
      return {
        ...base,
        ...box,
        type: 'magnifier',
        lens: {
          x: num(lens?.x, box.width * 3),
          y: num(lens?.y, box.height / 2),
          zoom: Math.max(0.1, num(lens?.zoom, 3)),
        },
        roundness: Math.min(100, Math.max(0, num(raw.roundness, DEFAULT_SQUIRCLE_ROUNDNESS))),
        // `ellipse` was the first build's oval; a squircle replaced it.
        shape: raw.shape === 'ellipse' || raw.shape === 'squircle' ? 'squircle' : 'rectangle',
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 6)),
        opacity: opacity(raw.opacity),
      }
    }
    case 'blur':
      return {
        ...base,
        ...size(raw),
        type: 'blur',
        radius: Math.max(0, num(raw.radius, 8)),
        opacity: opacity(raw.opacity),
      }
    case 'highlight':
      return {
        ...base,
        ...size(raw),
        type: 'highlight',
        color: str(raw.color, DEFAULT_HIGHLIGHT),
        opacity: opacity(raw.opacity ?? 0.35),
      }
    case 'image':
      // A picture that is not one a canvas can safely draw is kept verbatim, as a newer node would be.
      if (!isImageSource(raw.src)) return raw as UnknownNode
      return { ...base, ...size(raw), type: 'image', src: raw.src, opacity: opacity(raw.opacity) }
    case 'emoji':
      return {
        ...base,
        ...size(raw),
        type: 'emoji',
        char: str(raw.char, ''),
        fontSize: Math.max(1, num(raw.fontSize, 64)),
        opacity: opacity(raw.opacity),
      }
    case 'freehand': {
      const points = Array.isArray(raw.points) ? raw.points.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : []
      return {
        ...base,
        type: 'freehand',
        // Trimmed to whole pairs, and capped: a stroke is the one node whose size is unbounded by
        // anything the user sees, so a malformed or hostile document cannot make the editor chew
        // through a million points.
        points: points.slice(0, STROKE_MAX_POINTS * 2 - (points.length % 2)),
        stroke: str(raw.stroke, DEFAULT_STROKE),
        strokeWidth: Math.max(0, num(raw.strokeWidth, 3)),
        ...(raw.marker === true ? { marker: true as const } : {}),
        opacity: opacity(raw.opacity),
      }
    }
    case 'counter':
      return {
        ...base,
        ...size(raw),
        type: 'counter',
        // Clamped to a whole number at or above zero: the digit-count maths and the label both read
        // it, and a fractional or negative badge is not a thing the tool can produce.
        count: Math.max(0, Math.round(num(raw.count, 1))),
        fill: str(raw.fill, DEFAULT_COUNTER_FILL),
        color: str(raw.color, DEFAULT_COUNTER_DIGITS),
        // A badge written before the tail existed has no `tip` and stays a plain disc, rather than
        // sprouting a tail into a document the user already arranged.
        ...(isPoint(raw.tip) ? { tip: { x: raw.tip.x, y: raw.tip.y } } : {}),
        opacity: opacity(raw.opacity),
      }
    case 'group': {
      if (depth >= MAX_GROUP_DEPTH) return raw as UnknownNode
      const children = Array.isArray(raw.children) ? raw.children : []
      return {
        ...base,
        type: 'group',
        opacity: opacity(raw.opacity),
        children: children
          .map((child) => parseNode(child, depth + 1))
          .filter((child): child is SceneNode => child !== undefined),
      }
    }
    default:
      return typeof raw.type === 'string' ? (raw as UnknownNode) : undefined
  }
}

function parsePresent(value: unknown): PresentOptions {
  const raw = record(value)
  return {
    on: bool(raw.on, DEFAULT_PRESENT_OPTIONS.on),
    frame: oneOf(raw.frame, PRESENT_FRAME_STYLES, DEFAULT_PRESENT_OPTIONS.frame),
    chrome: oneOf(raw.chrome, PRESENT_CHROME_THEMES, DEFAULT_PRESENT_OPTIONS.chrome),
    url: str(raw.url, DEFAULT_PRESENT_OPTIONS.url),
    background: oneOf(raw.background, PRESENT_BACKGROUNDS, DEFAULT_PRESENT_OPTIONS.background),
    customColor: str(raw.customColor, DEFAULT_PRESENT_OPTIONS.customColor),
    padding: Math.max(0, num(raw.padding, DEFAULT_PRESENT_OPTIONS.padding)),
    corners: Math.max(0, num(raw.corners, DEFAULT_PRESENT_OPTIONS.corners)),
    shadow: bool(raw.shadow, DEFAULT_PRESENT_OPTIONS.shadow),
    stamp: oneOf(raw.stamp, PRESENT_STAMP_MODES, DEFAULT_PRESENT_OPTIONS.stamp),
  }
}

function parseCrop(value: unknown): Rect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const width = num(raw.width, 0)
  const height = num(raw.height, 0)
  // A crop with no area is not a crop; treating it as one would export a zero-pixel file.
  if (width <= 0 || height <= 0) return undefined
  return { x: num(raw.x, 0), y: num(raw.y, 0), width, height }
}

/**
 * Reads a document off the database, filling anything missing or malformed with a default.
 *
 * This is a trust boundary: the record comes back from IndexedDB, where it may have been written by
 * a newer build, an older one, or a half-finished write. It never throws — a document that cannot be
 * read at all still yields an empty scene over the capture, because losing the annotations is bad
 * and losing the screenshot with them is worse.
 */
export function parseSceneDoc(value: unknown, width: number, height: number, density = 1): SceneDoc {
  const raw = record(value)
  const capture = record(raw.capture)
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  return {
    version: num(raw.version, SCENE_DOC_VERSION),
    capture: {
      width: Math.max(1, num(capture.width, width)),
      height: Math.max(1, num(capture.height, height)),
      density: Math.max(0.01, num(capture.density, density)),
    },
    canvas: {
      background: oneOf(
        record(raw.canvas).background,
        PRESENT_BACKGROUNDS,
        DEFAULT_PRESENT_OPTIONS.background,
      ),
      customColor: str(record(raw.canvas).customColor, DEFAULT_PRESENT_OPTIONS.customColor),
      margin: Math.max(0, num(record(raw.canvas).margin, DEFAULT_PRESENT_OPTIONS.padding)),
    },
    present: parsePresent(raw.present),
    ...(parseCrop(raw.crop) ? { crop: parseCrop(raw.crop) as Rect } : {}),
    nodes: nodes
      .map((node) => parseNode(node, 0))
      .filter((node): node is SceneNode => node !== undefined),
  }
}

// --- the resolver ------------------------------------------------------------

/**
 * A 2×3 affine matrix, `[a, b, c, d, e, f]`, mapping `(x, y)` to
 * `(a·x + c·y + e, b·x + d·y + f)` — the argument order `CanvasRenderingContext2D.setTransform`
 * takes, so the export renderer hands it straight over.
 *
 * A matrix rather than a nested `Transform` because transforms do not compose into one: a rotated
 * group holding a rotated child, scaled non-uniformly, produces a skew that position-scale-rotation
 * cannot express. Storing TRS per node and resolving to a matrix keeps the document editable and the
 * output exact.
 */
export type Matrix = readonly [number, number, number, number, number, number]

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

const DEGREES = Math.PI / 180

export function matrixOf(transform: Transform): Matrix {
  const radians = transform.rotation * DEGREES
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [
    transform.scaleX * cos,
    transform.scaleX * sin,
    -transform.scaleY * sin,
    transform.scaleY * cos,
    transform.x,
    transform.y,
  ]
}

/** `parent` applied after `child` — the child's frame expressed in the parent's. */
export function multiply(parent: Matrix, child: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = parent
  const [a2, b2, c2, d2, e2, f2] = child
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

export function applyMatrix(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

/**
 * A world matrix back into position / rotation / skew / scale, which is the form a Konva node's
 * attributes take.
 *
 * The matrix is the truth and this is a format conversion, not a second derivation. It lives here
 * rather than in the preview so both renderers read numbers this module produced — the rule at the top of this file.
 *
 * The factorisation is `translate · rotate · shearX · scale`. `skewX` is a **shear factor**, not an
 * angle: it is the `k` in `x' = x + k·y`, which is what a shear matrix multiplies by directly. The
 * determinant's sign is carried into `scaleY`, so a mirrored node stays mirrored rather than being
 * silently un-flipped.
 */
export function decompose(matrix: Matrix): Transform & { skewX: number } {
  const [a, b, c, d, e, f] = matrix
  const scaleX = Math.hypot(a, b)
  const determinant = a * d - b * c
  const scaleY = scaleX === 0 ? 0 : determinant / scaleX
  return {
    x: e,
    y: f,
    scaleX: scaleX === 0 ? 1 : scaleX,
    scaleY: scaleY === 0 ? 1 : scaleY,
    rotation: Math.atan2(b, a) / DEGREES,
    skewX: determinant === 0 ? 0 : (a * c + b * d) / determinant,
  }
}

/**
 * The node's own drawn extent, in its own frame, before any transform.
 *
 * A stroke counts (bounds are measured on what is drawn, not on the geometric path), and so
 * does an arrow's head — an arrow whose bounds stopped at its endpoint would let the head fall
 * outside the exported image.
 *
 * Text and emoji carry a measured `width`/`height`, written back by whichever renderer laid the text
 * out. `scene` cannot measure a font in plain Node, so it takes the measurement as given; a text
 * node that has never been drawn has its default box, which is the correct answer for a node with no
 * pixels yet.
 */
export function localBounds(node: ShapeNode): Rect {
  switch (node.type) {
    case 'rectangle':
    case 'ellipse': {
      const inset = node.strokeWidth / 2
      return {
        x: -inset,
        y: -inset,
        width: node.width + node.strokeWidth,
        height: node.height + node.strokeWidth,
      }
    }
    case 'arrow': {
      // The curve's own extremes, not its control point, which sits twice as far out as the bend.
      const [start, control, end] = arrowCurve(node)
      const box = quadBounds(start, control, end)
      // A chevron's arm reaches `headSize · sin 40°` sideways and is round-capped.
      const { strokeWidth, headSize } = arrowWeights(node)
      const inset = node.style === 'solid' ? Math.max(strokeWidth, headSize) / 2 : headSize * 0.65 + strokeWidth / 2
      return { x: box.x - inset, y: box.y - inset, width: box.width + inset * 2, height: box.height + inset * 2 }
    }
    case 'line': {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
      const inset = node.strokeWidth / 2
      return {
        x: Math.min(x1, x2) - inset,
        y: Math.min(y1, y2) - inset,
        width: Math.abs(x2 - x1) + inset * 2,
        height: Math.abs(y2 - y1) + inset * 2,
      }
    }
    case 'freehand': {
      // Over every point, not just the ends: a stroke's extremes are wherever the hand went.
      const inset = node.strokeWidth / 2
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let index = 0; index + 1 < node.points.length; index += 2) {
        const x = node.points[index] ?? 0
        const y = node.points[index + 1] ?? 0
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
      return { x: minX - inset, y: minY - inset, width: maxX - minX + inset * 2, height: maxY - minY + inset * 2 }
    }
    case 'magnifier': {
      // The lens is part of what it draws, wherever it has been put: the export has to reach it.
      const inset = node.strokeWidth / 2
      const box = union({ x: 0, y: 0, width: node.width, height: node.height }, lensLocalRect(node))
      return { x: box.x - inset, y: box.y - inset, width: box.width + inset * 2, height: box.height + inset * 2 }
    }
    case 'counter': {
      // The tail reaches outside the disc, so the box has to follow it -- otherwise the selection
      // outline cuts the point off and, worse, the banded export skips a band the tail reaches into.
      const box = { x: 0, y: 0, width: node.width, height: node.height }
      if (!counterTangents(node.width, node.tip) || !node.tip) return box
      const left = Math.min(0, node.tip.x)
      const top = Math.min(0, node.tip.y)
      return {
        x: left,
        y: top,
        width: Math.max(node.width, node.tip.x) - left,
        height: Math.max(node.height, node.tip.y) - top,
      }
    }
    case 'text': {
      // The pointer reaches outside the box; the export's band inclusion has to see it (as a counter's).
      const box = { x: 0, y: 0, width: node.width, height: node.height }
      if (node.fill === undefined || !node.tip || !textTailShown(node)) return box
      const left = Math.min(0, node.tip.x)
      const top = Math.min(0, node.tip.y)
      return { x: left, y: top, width: Math.max(node.width, node.tip.x) - left, height: Math.max(node.height, node.tip.y) - top }
    }
    default:
      return { x: 0, y: 0, width: node.width, height: node.height }
  }
}

/** True when two scene-space rectangles share any area. Both renderers skip ops outside their window. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** The axis-aligned bounding box of `rect`'s four corners after `matrix`. */
export function transformedBounds(rect: Rect, matrix: Matrix): Rect {
  const corners = [
    applyMatrix(matrix, rect.x, rect.y),
    applyMatrix(matrix, rect.x + rect.width, rect.y),
    applyMatrix(matrix, rect.x + rect.width, rect.y + rect.height),
    applyMatrix(matrix, rect.x, rect.y + rect.height),
  ]
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/** A leaf shape with its ancestors resolved away. This is all either renderer is ever handed. */
export interface ResolvedShape {
  node: ShapeNode
  /** The node's frame in scene space, ancestors included. */
  matrix: Matrix
  /** Scene-space AABB of what the node draws, stroke and arrowhead included. */
  bounds: Rect
  /** The product of the node's own opacity and every ancestor group's. */
  opacity: number
  /**
   * The node's own lock, or any ancestor group's. A locked node is not selectable on the canvas —
   * it stays selectable in the panel, which is the entire point of locking.
   * Locking changes nothing about what is drawn, so neither renderer reads this.
   */
  locked: boolean
}

/**
 * Walks the tree in document order and resolves every visible leaf into scene space.
 *
 * Hidden nodes and their descendants are skipped entirely: a hidden shape is not in the picture, so
 * it neither draws nor contributes to bounds. Nodes of an unknown type are skipped too — a type
 * this build cannot read has no bounds it can trust.
 */
export function resolveShapes(doc: SceneDoc): ResolvedShape[] {
  const resolved: ResolvedShape[] = []
  const walk = (nodes: readonly SceneNode[], parent: Matrix, inherited: number, locked: boolean): void => {
    for (const node of nodes) {
      if (!isKnownNode(node) || node.hidden === true) continue
      const matrix = multiply(parent, matrixOf(node.transform))
      if (isGroupNode(node)) {
        walk(node.children, matrix, inherited * node.opacity, locked || node.locked === true)
        continue
      }
      resolved.push({
        node,
        matrix,
        bounds: transformedBounds(localBounds(node), matrix),
        opacity: inherited * node.opacity,
        locked: locked || node.locked === true,
      })
    }
  }
  walk(doc.nodes, IDENTITY_MATRIX, 1, false)
  return resolved
}

// --- the four derived rectangles ---------------------------------------------

function union(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function expand(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/** `(0, 0, captureWidth, captureHeight)`, by definition rather than by calculation. */
export function captureRect(doc: SceneDoc): Rect {
  return { x: 0, y: 0, width: doc.capture.width, height: doc.capture.height }
}

/**
 * The capture plus the Present chrome, which is drawn above it and therefore sits at a negative `y`.
 *
 * The band's size in scene space is `designUnits × captureDensity`, with **no export scale in it** —
 * that is the one change to how Present is sized. Today `chrome-template`'s geometry is multiplied
 * by `captureDensity × exportScale`, which makes the frame a different size in the preview than in
 * the file and leaves `outputRect` unable to be computed without knowing which file is about to be
 * written. Export scale now scales the whole composed scene once, as it does everything else.
 *
 * Neither template's `border` grows this: both `border` arrays are empty today, and their entries
 * are specified as insets drawn inside the card, so a border never adds extent.
 */
export function frameRect(doc: SceneDoc, bandHeight: number): Rect {
  const capture = captureRect(doc)
  if (!doc.present.on) return capture
  const band = bandHeight * doc.capture.density
  return { x: capture.x, y: capture.y - band, width: capture.width, height: capture.height + band }
}

/** The union of every visible leaf shape's scene-space bounds, or `undefined` when there are none. */
export function shapesRect(doc: SceneDoc): Rect | undefined {
  const shapes = resolveShapes(doc)
  const first = shapes[0]
  if (!first) return undefined
  return shapes.slice(1).reduce((acc, shape) => union(acc, shape.bounds), first.bounds)
}

/**
 * `union(frameRect, shapesRect)` — the picture before the margin.
 *
 * "The padding extends to cover the shape" falls out of this rather than being a special case: the
 * margin never changes, the content does. Dragging a shape past the frame's edge widens the export
 * and deleting it narrows the export again, because these bounds are derived on every read and never
 * accumulated.
 */
export function contentRect(doc: SceneDoc, bandHeight: number): Rect {
  const frame = frameRect(doc, bandHeight)
  const shapes = shapesRect(doc)
  return shapes ? union(frame, shapes) : frame
}

/**
 * What the exported file covers.
 *
 * **A crop wins outright**: when one is set it *is* the output, and `contentRect` is not
 * consulted at all — so moving a shape outside a crop does not grow the image. Two mechanisms want
 * to decide the output's size and only one can, or the picture resizes when the user drags an
 * annotation they had deliberately cropped away. The crop clips rather than deletes: the shape still
 * exists, still lists in the panel, and returns when the crop is cleared.
 *
 * Without a crop it is `contentRect` grown by the margin on all four sides — unconditionally,
 * whether or not Present is on.
 */
export function outputRect(doc: SceneDoc, bandHeight: number): Rect {
  if (doc.crop) return doc.crop
  return expand(contentRect(doc, bandHeight), doc.canvas.margin * doc.capture.density)
}

/** Pixel-aligned rows and columns both raster renderers must allocate to contain `outputRect`. */
export function renderRect(doc: SceneDoc, bandHeight: number): Rect {
  const rect = outputRect(doc, bandHeight)
  const left = Math.floor(rect.x)
  const top = Math.floor(rect.y)
  const right = Math.ceil(rect.x + rect.width)
  const bottom = Math.ceil(rect.y + rect.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// --- the render walk ---------------------------------------------------------

/**
 * One entry in the flat, ordered list of world-space draw operations both renderers consume.
 *
 * **This is where the tree ends.** Neither renderer ever sees a group: `flatten` resolves every
 * node's ancestors into a world matrix and emits leaves in document order, so grouping is a document
 * and layers-panel concept that the export renderer is completely unaffected by. A test asserts
 * that no emitted op is a group, because that is the actual contract.
 *
 * A blur is its own kind rather than a shape, because it is not a filter on a
 * node — it is an operation on the render target: read what is already there, blur it, write it
 * back clipped to the rect. A renderer handed it as a shape would draw it as one.
 */
export type DrawOp =
  | {
      kind: 'backdrop'
      /** Unbounded in principle; this is whatever the output turned out to be. */
      rect: Rect
      background: PresentOptions['background']
      customColor: string
    }
  | {
      kind: 'chrome'
      rect: Rect
      present: PresentOptions
      /**
       * Scene units per design unit — the capture's density, and nothing else. The renderer passes
       * this to `chrome-template`'s pure geometry; export scale is applied once to the whole scene.
       */
      unit: number
      /** Present rounds the band into the card's corners, exactly as the capture below it is. */
      clip?: { rect: Rect; radius: number }
    }
  | {
      kind: 'capture'
      rect: Rect
      /** Present rounds the capture into the frame's card; absent when there is no frame. */
      clip?: { rect: Rect; radius: number }
    }
  | { kind: 'shape'; shape: ResolvedShape }
  | {
      kind: 'blur'
      /**
       * The axis-aligned scene-space region whose pixels are read and written — what
       * `stackBlurRegion` takes. It is the node's bounds, so a rotated blur reads the whole box its
       * quad sits in and the renderer clips the write-back to the quad itself.
       */
      region: Rect
      /** Effective radius in scene units, the node's own radius scaled by its world transform. */
      radius: number
      shape: ResolvedShape
    }

/**
 * The whole picture as an ordered list: backdrop, frame, capture, then every visible leaf in
 * flattened document order.
 *
 * A blur therefore blurs everything earlier in this list and nothing after it — including the
 * backdrop and the browser chrome, which are below it, and including content outside the group it
 * happens to sit in, because groups are walked through rather than around.
 */
export function flatten(doc: SceneDoc, bandHeight: number): DrawOp[] {
  const output = renderRect(doc, bandHeight)
  const ops: DrawOp[] = [
    {
      kind: 'backdrop',
      rect: output,
      background: doc.canvas.background,
      customColor: doc.canvas.customColor,
    },
  ]
  if (doc.present.on) {
    const clip = {
      rect: frameRect(doc, bandHeight),
      radius: doc.present.corners * doc.capture.density,
    }
    ops.push({
      kind: 'chrome',
      rect: frameRect(doc, bandHeight),
      present: doc.present,
      unit: doc.capture.density,
      clip,
    })
    ops.push({
      kind: 'capture',
      rect: captureRect(doc),
      clip,
    })
  } else {
    ops.push({ kind: 'capture', rect: captureRect(doc) })
  }
  for (const shape of resolveShapes(doc)) {
    if (shape.node.type === 'blur') {
      ops.push({
        kind: 'blur',
        region: shape.bounds,
        radius: shape.node.radius * matrixScale(shape.matrix),
        shape,
      })
    } else {
      ops.push({ kind: 'shape', shape })
    }
  }
  return ops
}

/**
 * The larger of a matrix's two axis scales. A blur's radius is stored in the node's own frame, so a
 * blur inside a group scaled 2x blurs twice as wide; taking the larger axis keeps the band overlap
 * below a non-uniformly scaled blur's true support rather than half of it.
 */
function matrixScale(matrix: Matrix): number {
  const [a, b, c, d] = matrix
  return Math.max(Math.hypot(a, b), Math.hypot(c, d))
}

// --- the band plan -----------------------------------------------------------

/**
 * A stack blur of radius `r` is three box passes of radius `r`, so a pixel is influenced by others
 * up to `3r` away. That is the "true support" each band's overlap must cover.
 */
export const BLUR_SUPPORT = 3

/**
 * The window a blur repaints: its region grown by the kernel's own support, clipped to the output.
 *
 * `undefined` when the blur touches no output pixel at all — a committed crop can sit anywhere, and
 * a blur left outside it used to fall out of this arithmetic as a negative-size window that
 * `OffscreenCanvas` refuses to construct, throwing the whole preview render away. The export path's `rectsIntersect` guard already had the same answer; this is that
 * answer stated once, and both the region and the output are scene space.
 */
export function blurWindow(region: Rect, output: Rect, support: number): Rect | undefined {
  const x = Math.max(output.x, region.x - support)
  const y = Math.max(output.y, region.y - support)
  const right = Math.min(output.x + output.width, region.x + region.width + support)
  const bottom = Math.min(output.y + output.height, region.y + region.height + support)
  if (right <= x || bottom <= y) return undefined
  return { x, y, width: right - x, height: bottom - y }
}

// --- text and arrow layout both renderers draw -------------------------------

/**
 * Measures a run of text in the current font. Injected, so the layout below is plain arithmetic Node
 * can test, and so the export can hand in `context.measureText` while the preview's Konva uses its own.
 */
export type MeasureText = (text: string) => number

/**
 * Konva's own character split (`konva/lib/shapes/Text.js`, `stringToArray`), ported so the export
 * breaks an over-long word at the same character the preview does.
 *
 * Code points, with an emoji joined to a following modifier or zero-width joiner, a regional-indicator
 * pair joined, and a combining mark joined to the character before it. ponytail: Konva also emits the
 * second regional indicator of a flag on its own; that is copied, because matching the preview is the
 * point, and it only matters for a flag emoji wrapped mid-word.
 */
export function textCharacters(text: string): string[] {
  const chars = [...text]
  const out: string[] = []
  chars.forEach((char, index) => {
    if (/\p{Emoji}/u.test(char)) {
      const next = chars[index + 1]
      if (next && /\p{Emoji_Modifier}|‍/u.test(next)) {
        out.push(char + next)
        chars[index + 1] = ''
      } else {
        out.push(char)
      }
    } else if (/\p{Regional_Indicator}{2}/u.test(char + (chars[index + 1] ?? ''))) {
      out.push(char + (chars[index + 1] ?? ''))
    } else if (index > 0 && /\p{Mn}|\p{Me}|\p{Mc}/u.test(char)) {
      out[out.length - 1] += char
    } else if (char) {
      out.push(char)
    }
  })
  return out
}

/** One laid-out line: its text and its measured width. */
export interface TextLine {
  text: string
  width: number
}

/**
 * Konva's word wrap for a fixed-width box with no height limit (`_setTextData`, `wrap: 'word'`), ported.
 *
 * A paragraph that fits is kept verbatim, spaces and all. One that does not takes the longest prefix
 * that fits, then steps back to the last space or dash inside it; a single word wider than the box is
 * broken mid-word. Emitted lines lose trailing spaces and the remainder loses leading ones.
 */
export function wrapTextLines(text: string, maxWidth: number, measure: MeasureText): TextLine[] {
  const lines: TextLine[] = []
  const push = (line: string): void => {
    lines.push({ text: line, width: measure(line) })
  }
  for (const paragraph of text.split('\n')) {
    let line = paragraph
    if (measure(line) <= maxWidth) {
      push(line)
      continue
    }
    while (line.length > 0) {
      const chars = textCharacters(line)
      let low = 0
      let high = chars.length
      let match = ''
      let matchWidth = 0
      while (low < high) {
        const mid = (low + high) >>> 1
        const candidate = chars.slice(0, mid + 1).join('')
        const width = measure(candidate)
        if (width <= maxWidth) {
          low = mid + 1
          match = candidate
          matchWidth = width
        } else {
          high = mid
        }
      }
      if (!match) break
      const matchChars = textCharacters(match)
      const next = chars[matchChars.length]
      let wrapIndex: number
      if ((next === ' ' || next === '-') && matchWidth <= maxWidth) {
        wrapIndex = matchChars.length
      } else {
        wrapIndex = Math.max(matchChars.lastIndexOf(' '), matchChars.lastIndexOf('-')) + 1
      }
      if (wrapIndex > 0) {
        low = wrapIndex
        match = chars.slice(0, low).join('')
      }
      push(match.trimEnd())
      line = chars.slice(low).join('').trimStart()
      if (line.length > 0 && measure(line) <= maxWidth) {
        push(line)
        break
      }
    }
  }
  return lines
}

/**
 * Where Konva draws line `index` of a text node on the alphabetic baseline (its default rendering):
 * the first baseline sits at `(ascent - descent) / 2 + lineHeight / 2`, from the font box of `'M'`.
 */
export function textBaselineY(index: number, lineHeight: number, ascent: number, descent: number): number {
  return (ascent - descent) / 2 + lineHeight / 2 + index * lineHeight
}

/** A line's left edge inside its box for Konva's `left`, `center` and `right` alignment. */
export function textLineX(align: 'left' | 'center' | 'right', boxWidth: number, lineWidth: number): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2
  if (align === 'right') return boxWidth - lineWidth
  return 0
}

type Point = { x: number; y: number }

/**
 * Where a new lens goes: beside its source on the right, or on the left when the right edge of the
 * page would cut it off, and kept inside the page top to bottom where it fits.
 */
export function placeLens(node: MagnifierNode, pageWidth: number, pageHeight = Infinity): void {
  const lens = lensRect(node)
  const gap = lens.x - (node.transform.x + node.width)
  let x = lens.x
  if (x + lens.width > pageWidth) x = Math.max(0, node.transform.x - gap - lens.width)
  const y = Math.max(0, Math.min(lens.y, pageHeight - lens.height))
  node.lens = { ...node.lens, x: x + lens.width / 2, y: y + lens.height / 2 }
}

/** The lens in the node's parent frame: the source's size times the zoom, about the stored centre. */
export function lensRect(node: Pick<MagnifierNode, 'lens' | 'width' | 'height'>): Rect {
  return lensAround(node.lens, node.width, node.height)
}

/** A lens of `zoom` times a `width` × `height` source, centred on `centre`. */
export function lensAround(centre: { x: number; y: number; zoom: number }, width: number, height: number): Rect {
  const w = width * centre.zoom
  const h = height * centre.zoom
  return { x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h }
}

/**
 * The source and the lens in scene space, for a resolved magnifier. The lens is stored in the node's
 * parent frame, which is the resolved matrix with the node's own transform taken back off.
 */
export function magnifierWorld(shape: { node: MagnifierNode; matrix: Matrix }): { source: Rect; lens: Rect } {
  const own = invert(matrixOf(shape.node.transform))
  const parent = own ? multiply(shape.matrix, own) : shape.matrix
  return {
    source: transformedBounds({ x: 0, y: 0, width: shape.node.width, height: shape.node.height }, shape.matrix),
    lens: transformedBounds(lensRect(shape.node), parent),
  }
}

/** The lens in the node's own frame, which is what its bounds and hit test are measured in. */
export function lensLocalRect(node: MagnifierNode): Rect {
  const inverse = invert(matrixOf(node.transform))
  return inverse ? transformedBounds(lensRect(node), inverse) : lensRect(node)
}

function inShape(point: Point, rect: Rect, power: number | undefined): boolean {
  if (point.x < rect.x || point.y < rect.y || point.x > rect.x + rect.width || point.y > rect.y + rect.height) return false
  if (power === undefined) return true
  const dx = (point.x - (rect.x + rect.width / 2)) / (rect.width / 2 || 1)
  const dy = (point.y - (rect.y + rect.height / 2)) / (rect.height / 2 || 1)
  return Math.abs(dx) ** power + Math.abs(dy) ** power <= 1
}

/**
 * The line joining the source to the lens: from the edge of one to the edge of the other, along the
 * line between their centres, so it never crosses either picture. `undefined` when they overlap.
 */
export function magnifierConnector(source: Rect, lens: Rect, power: number | undefined): [Point, Point] | undefined {
  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
  const to = { x: lens.x + lens.width / 2, y: lens.y + lens.height / 2 }
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return undefined
  // The share of the centre-to-centre line that lies inside a frame of half-size (w, h).
  const inside = (w: number, h: number): number =>
    power === undefined
      ? Math.min(w / (Math.abs(dx) || Number.MIN_VALUE), h / (Math.abs(dy) || Number.MIN_VALUE))
      : 1 / (Math.abs(dx / (w || 1)) ** power + Math.abs(dy / (h || 1)) ** power) ** (1 / power)
  const out = inside(source.width / 2, source.height / 2)
  const back = inside(lens.width / 2, lens.height / 2)
  if (out + back >= 1) return undefined
  return [
    { x: from.x + dx * out, y: from.y + dy * out },
    { x: to.x - dx * back, y: to.y - dy * back },
  ]
}

/** A squircle's outline in `rect`, as points both renderers join: the superellipse |x|ⁿ + |y|ⁿ = 1. */
export function squirclePoints(rect: Rect, power: number, steps = 96): Point[] {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const points: Point[] = []
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    points.push({
      x: cx + (rect.width / 2) * Math.sign(cos) * Math.abs(cos) ** (2 / power),
      y: cy + (rect.height / 2) * Math.sign(sin) * Math.abs(sin) ** (2 / power),
    })
  }
  return points
}

/** The canvas calls `arrowPath` makes: Konva's scene context and a 2D context both have them. */
export interface ArrowSink {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  closePath(): void
}

/**
 * The arrow as a quadratic curve: its start, control point and end. The middle handle sits on the
 * curve at t = ½, which puts the control point at the ends' midpoint plus twice the bend.
 */
export function arrowCurve(node: Pick<ArrowNode, 'points' | 'bend'>): [Point, Point, Point] {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
  const bend = node.bend ?? { x: 0, y: 0 }
  return [{ x: x1, y: y1 }, { x: (x1 + x2) / 2 + bend.x * 2, y: (y1 + y2) / 2 + bend.y * 2 }, { x: x2, y: y2 }]
}

/** Where the middle handle sits: on the curve, halfway. */
export function arrowMiddle(node: Pick<ArrowNode, 'points' | 'bend'>): Point {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
  return { x: (x1 + x2) / 2 + (node.bend?.x ?? 0), y: (y1 + y2) / 2 + (node.bend?.y ?? 0) }
}

function quadAt(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
}

function quadBounds(a: Point, c: Point, b: Point): Rect {
  const points = [a, b]
  // Each axis peaks where its derivative is zero, once at most.
  for (const axis of ['x', 'y'] as const) {
    const denominator = a[axis] - 2 * c[axis] + b[axis]
    const t = denominator === 0 ? -1 : (a[axis] - c[axis]) / denominator
    if (t > 0 && t < 1) points.push(quadAt(a, c, b, t))
  }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

function unit(x: number, y: number): Point {
  const length = Math.hypot(x, y)
  return length === 0 ? { x: 1, y: 0 } : { x: x / length, y: y / length }
}

/** Which way the curve leaves `from`, away from `to` -- the chord's way when the curve is straight. */
function endDirection(end: Point, control: Point, other: Point): Point {
  const back = unit(end.x - control.x, end.y - control.y)
  return end.x === control.x && end.y === control.y ? unit(end.x - other.x, end.y - other.y) : back
}

/**
 * The arrow's outline, one path both renderers draw. A `solid` arrow is filled: a shaft that widens
 * from 60% of the weight at the tail to the full weight at the head, then a triangle `headSize` long
 * and across -- one polygon, so there is no seam and no overlap to double a translucent colour. A
 * `line` or `double` arrow is stroked, round-capped: the curve, and an open chevron at the head (and
 * the tail).
 */
export function arrowPath(sink: ArrowSink, node: Pick<ArrowNode, 'points' | 'bend' | 'style' | 'strokeWidth' | 'headSize' | 'size'>): void {
  const [start, control, end] = arrowCurve(node)
  const { strokeWidth, headSize: head } = arrowWeights(node)
  sink.beginPath()
  if (node.style !== 'solid') {
    sink.moveTo(start.x, start.y)
    sink.quadraticCurveTo(control.x, control.y, end.x, end.y)
    const chevron = (tip: Point, direction: Point): void => {
      // Arms 40° either side of the way the curve arrives.
      const cos = Math.cos((40 * Math.PI) / 180)
      const sin = Math.sin((40 * Math.PI) / 180)
      const arm = (side: number): Point => ({
        x: tip.x - head * (direction.x * cos - side * direction.y * sin),
        y: tip.y - head * (direction.y * cos + side * direction.x * sin),
      })
      const left = arm(1)
      const right = arm(-1)
      sink.moveTo(left.x, left.y)
      sink.lineTo(tip.x, tip.y)
      sink.lineTo(right.x, right.y)
    }
    if (head > 0) {
      chevron(end, endDirection(end, control, start))
      if (node.style === 'double') chevron(start, endDirection(start, control, end))
    }
    return
  }
  // Sample the curve by arc length, so the taper runs evenly however the bend is drawn.
  const steps = 32
  const samples: Array<{ point: Point; at: number; t: number }> = []
  let travelled = 0
  for (let index = 0; index <= steps; index += 1) {
    const point = quadAt(start, control, end, index / steps)
    const last = samples.at(-1)
    if (last) travelled += Math.hypot(point.x - last.point.x, point.y - last.point.y)
    samples.push({ point, at: travelled, t: index / steps })
  }
  // The head's base sits on the curve, `headSize` short of the tip, and the head aims from there at
  // the tip: aimed along the end's tangent instead, a bent arrow's head sat off the shaft in a notch.
  const shaftLength = Math.max(0, travelled - head)
  const shaft = samples.filter((sample) => sample.at < shaftLength)
  const past = samples.find((sample) => sample.at >= shaftLength)
  const lastShaft = shaft.at(-1)
  const base =
    past && lastShaft && travelled > head
      ? (() => {
          const share = (shaftLength - lastShaft.at) / (past.at - lastShaft.at || 1)
          return { x: lastShaft.point.x + (past.point.x - lastShaft.point.x) * share, y: lastShaft.point.y + (past.point.y - lastShaft.point.y) * share }
        })()
      : (() => {
          const way = endDirection(end, control, start)
          return { x: end.x - way.x * head, y: end.y - way.y * head }
        })()
  const direction = unit(end.x - base.x, end.y - base.y)
  // 60% of the weight at the tail, the full weight at the head: a gentle taper.
  const width = (at: number): number => (strokeWidth / 2) * (0.6 + 0.4 * (shaftLength === 0 ? 1 : at / shaftLength))
  const normalAt = (t: number): Point => {
    // The derivative of the curve, turned a quarter.
    const dx = 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x)
    const dy = 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y)
    const along = dx === 0 && dy === 0 ? direction : unit(dx, dy)
    return { x: -along.y, y: along.x }
  }
  const side = (sign: number): Point[] => [
    ...shaft.map((sample) => {
      const normal = normalAt(sample.t)
      const half = width(sample.at) * sign
      return { x: sample.point.x + normal.x * half, y: sample.point.y + normal.y * half }
    }),
    { x: base.x - direction.y * (strokeWidth / 2) * sign, y: base.y + direction.x * (strokeWidth / 2) * sign },
  ]
  const left = side(1)
  const right = side(-1).reverse()
  const [first, ...rest] = left
  if (!first) return
  sink.moveTo(first.x, first.y)
  for (const point of rest) sink.lineTo(point.x, point.y)
  sink.lineTo(base.x - direction.y * (head / 2), base.y + direction.x * (head / 2))
  sink.lineTo(end.x, end.y)
  sink.lineTo(base.x + direction.y * (head / 2), base.y - direction.x * (head / 2))
  for (const point of right) sink.lineTo(point.x, point.y)
  sink.closePath()
}

/**
 * Whether a point in the arrow's own frame is on what it draws: near the curve, or inside a head.
 * Its bounding box is mostly empty page once it is diagonal or bent, and a click there has to miss
 * or it can never deselect. A few units of slop keep a thin line clickable.
 */
export function arrowShapeHit(node: ArrowNode, x: number, y: number): boolean {
  const [start, control, end] = arrowCurve(node)
  const { strokeWidth, headSize } = arrowWeights(node)
  const reach = Math.max(strokeWidth / 2, 3) + 3
  const near = (point: Point, radius: number): boolean => Math.hypot(x - point.x, y - point.y) <= radius
  if (near(end, headSize) || (node.style === 'double' && near(start, headSize))) return true
  let previous = start
  for (let index = 1; index <= 32; index += 1) {
    const point = quadAt(start, control, end, index / 32)
    const dx = point.x - previous.x
    const dy = point.y - previous.y
    const share = Math.max(0, Math.min(1, ((x - previous.x) * dx + (y - previous.y) * dy) / (dx * dx + dy * dy || 1)))
    if (near({ x: previous.x + dx * share, y: previous.y + dy * share }, reach)) return true
    previous = point
  }
  return false
}

/**
 * Whether a shape must be drawn at full strength into a buffer and then blended once at its opacity.
 *
 * Konva does this for any shape that both fills and strokes below full opacity (`_useBufferCanvas`),
 * so the fill, the stroke and an arrow's shaft and head never double their transparency where they
 * overlap. Drawn piece by piece, a 50% arrow showed its square shaft end and its triangle as separate,
 * darker overlapping shapes in the export.
 */
export function usesOpacityBuffer(node: ShapeNode, opacity: number): boolean {
  if (opacity >= 1) return false
  // A solid arrow is one polygon; a stroked one's curve and chevrons overlap.
  if (node.type === 'arrow') return node.style !== 'solid' && node.strokeWidth > 0
  if (node.type === 'rectangle' || node.type === 'ellipse') return node.fill !== 'none' && hasStroke(node)
  if (node.type === 'text') return hasStroke(node)
  return false
}

/**
 * One horizontal band of the export.
 *
 * `offsetY` / `height` are the rows this band **owns** — they tile `outputRect` exactly, with no gap
 * and no overlap, and are what gets written to the file. `renderOffsetY` / `renderHeight` are the
 * rows it must actually **render**, widened so that a blur near a boundary has the neighbouring
 * pixels its kernel reads. The renderer draws the render window and crops back to the owned window.
 *
 * All four are offsets from the top of `outputRect`, not scene coordinates, because that is the
 * space the output file is written in.
 */
export interface Band {
  offsetY: number
  height: number
  renderOffsetY: number
  renderHeight: number
}

/**
 * Splits the output into bands, each carrying enough overlap for the blurs in the document.
 *
 * The split itself reuses `planTiles`, which is the same 8,192px banding the stitcher and the result
 * page's preview already use — one tile height across the codebase, so a band boundary is a band
 * boundary everywhere.
 *
 * The overlap is a single number for every band rather than per-band, because a blur can be dragged
 * across a boundary between one export and the next and a per-band figure would be a cache invalidated
 * by a gesture. It is zero on the overwhelmingly common document that contains no blur at all.
 *
 * This is the seam risk of the whole design — the same class of defect as the stitching hairline, and
 * it will not show up here. It needs a self-announcing fixture: a blur deliberately
 * straddling a band boundary over ruled content, so a mismatch reads as a visible step.
 */
export function planBands(doc: SceneDoc, bandHeight: number, tileHeight = TILE_HEIGHT): Band[] {
  const output = renderRect(doc, bandHeight)
  const overlap = Math.ceil(blurOverlap(doc, tileHeight))
  return planTiles(output.height, tileHeight).map((band) => {
    const renderOffsetY = Math.max(0, band.offsetY - overlap)
    const renderBottom = Math.min(output.height, band.offsetY + band.height + overlap)
    return {
      offsetY: band.offsetY,
      height: band.height,
      renderOffsetY,
      renderHeight: renderBottom - renderOffsetY,
    }
  })
}

/**
 * How far outside its own rows a band must read, in scene units. Zero when the document has no blur.
 *
 * **This is a sum, not a maximum, and that is the whole subtlety.** A band that owns rows
 * `[top, bottom)` must render `[top - overlap, bottom + overlap)`, because a blurred output pixel on
 * the band's last row reads source pixels up to its kernel's support below it. For one blur that
 * bound is the widest support. But blurs stack — overlapping blurs compound
 * deliberately — and a blur reading a *blurred* pixel reads through that blur's support as well, so
 * a chain of blurs extends the read by each of their supports in turn. Summing is the cheapest
 * upper bound on any such chain, it is exact for the single-blur case that is almost every document,
 * and a handful of blurs at typical radii still costs a couple of hundred pixels against an
 * 8,192-row band.
 *
 * Capped at the tile height so that a pathological document cannot make a band's render window
 * larger than a band, which would defeat the point of banding.
 */
export function blurOverlap(doc: SceneDoc, tileHeight = TILE_HEIGHT): number {
  let total = 0
  for (const shape of resolveShapes(doc)) {
    if (shape.node.type !== 'blur') continue
    total += shape.node.radius * matrixScale(shape.matrix) * BLUR_SUPPORT
  }
  return Math.min(total, tileHeight)
}

// --- the tree, as the layers panel edits it ---------------------------------

/**
 * Everything below this line is the document's *tree* rather than its geometry, and it lives here
 * for the same reason the rectangles do: the rule is that a renderer or a panel needing a number
 * must add it to `scene` rather than compute it locally. The layers panel needs a row height, an
 * indent, a drop-band split and a default name, and every one of them is arithmetic over the
 * document — so none of them belongs in a DOM module where no test can reach it.
 *
 * These operate on the caller's array **in place**. The editor snapshots the tree before each user
 * gesture for undo, so returning a fresh tree would mean cloning twice per gesture to no end.
 */

/**
 * Rows are 30px tall, and the name column starts at a fixed offset whatever the type.
 *
 * This is a constant and not a CSS number because the drop-band arithmetic below divides it. Row
 * height moved 28 -> 30 in a redesign; changing it in the stylesheet alone would have
 * left every drag hit-testing against the old row.
 */
export const LAYER_ROW_HEIGHT = 30

/** 16px per depth level, applied before the chevron. */
export const LAYER_INDENT = 16

/** The top 8px mean "before" and the bottom 8px "after", leaving 14px of "inside" on a group. */
export const LAYER_DROP_EDGE = 8

export type DropPosition = 'before' | 'inside' | 'after'
export type OrderMove = 'forward' | 'backward' | 'front' | 'back'

/**
 * Which of the two drag operations a pointer at `offsetY` within a row is asking for.
 *
 * A non-group row has no middle band at all — only before and after, split at the row's midpoint —
 * because "inside" has no meaning for a node that cannot hold children.
 */
export function dropPositionFor(offsetY: number, isGroup: boolean): DropPosition {
  if (!isGroup) return offsetY < LAYER_ROW_HEIGHT / 2 ? 'before' : 'after'
  if (offsetY < LAYER_DROP_EDGE) return 'before'
  if (offsetY >= LAYER_ROW_HEIGHT - LAYER_DROP_EDGE) return 'after'
  return 'inside'
}

/** One row of the panel, in display order. */
export interface LayerRow {
  node: KnownNode
  id: string
  /** 0 for a top-level node; the panel multiplies this by `LAYER_INDENT`. */
  depth: number
  /** The id of the group holding this node, or `undefined` when it sits at the root. */
  parentId?: string
  name: string
  isGroup: boolean
  hasChildren: boolean
  expanded: boolean
}

const TYPE_LABELS: Record<KnownNode['type'], string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  line: 'Line',
  text: 'Text',
  blur: 'Blur',
  highlight: 'Highlight',
  emoji: 'Emoji',
  counter: 'Counter',
  freehand: 'Drawing',
  magnifier: 'Magnifier',
  image: 'Image',
  group: 'Group',
}

/**
 * Every node's display name, keyed by id.
 *
 * A name the user typed wins. Otherwise it is the type plus an ordinal counted in **document**
 * order, so the number beside a shape does not change when something above it is deleted — except
 * for Text and Emoji, which name themselves after their own content, which is the only thing that
 * makes a text-heavy annotation set readable at all.
 */
/**
 * How many annotations the document holds, for the status bar and the layers header.
 *
 * Groups are containers, not annotations, so they are not counted -- but their children are, at any
 * depth. Counting `layerNames(doc).size` instead would include every group and read one or two high
 * on any grouped document.
 */
export function countAnnotations(doc: SceneDoc): number {
  let total = 0
  const walk = (nodes: readonly SceneNode[]): void => {
    for (const node of nodes) {
      if (!isKnownNode(node)) continue
      if (isGroupNode(node)) walk(node.children)
      else total += 1
    }
  }
  walk(doc.nodes)
  return total
}

export function layerNames(doc: SceneDoc): Map<string, string> {
  const names = new Map<string, string>()
  const counts = new Map<string, number>()
  const walk = (nodes: readonly SceneNode[]): void => {
    for (const node of nodes) {
      if (!isKnownNode(node)) continue
      const ordinal = (counts.get(node.type) ?? 0) + 1
      counts.set(node.type, ordinal)
      names.set(node.id, node.name ?? autoName(node, ordinal))
      if (isGroupNode(node)) walk(node.children)
    }
  }
  walk(doc.nodes)
  return names
}

function autoName(node: KnownNode, ordinal: number): string {
  if (node.type === 'emoji') return node.char || `${TYPE_LABELS.emoji} ${ordinal}`
  // A badge names itself after its own number, like Text and Emoji do after their content. A
  // document-order ordinal would disagree with the digits on the badge the moment one is deleted.
  if (node.type === 'counter') return `${TYPE_LABELS.counter} ${node.count}`
  if (node.type === 'text') {
    const trimmed = node.text.trim()
    if (trimmed !== '') return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
  }
  return `${TYPE_LABELS[node.type]} ${ordinal}`
}

/**
 * The panel's rows, top-most first.
 *
 * Display order is the **reverse** of document order, because index 0 is the bottom-most node and
 * the panel reads top-down. That inversion is what makes the blur influence band free: a subtree is
 * contiguous in document order, so a row sitting below a blur's row in this list is exactly a node
 * the blur paints over, and the panel needs no second walk to find the band.
 *
 * Collapsed groups contribute their own row and none of their children's. Unknown nodes are skipped
 * — a type this build cannot read has no name, no icon and no bounds it can offer.
 */
export function layerRows(doc: SceneDoc, collapsed: ReadonlySet<string> = new Set()): LayerRow[] {
  const names = layerNames(doc)
  const rows: LayerRow[] = []
  const walk = (nodes: readonly SceneNode[], depth: number, parentId?: string): void => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]
      if (!node || !isKnownNode(node)) continue
      const isGroup = isGroupNode(node)
      const expanded = isGroup && !collapsed.has(node.id)
      rows.push({
        node,
        id: node.id,
        depth,
        parentId,
        name: names.get(node.id) ?? node.id,
        isGroup,
        hasChildren: isGroup && node.children.length > 0,
        expanded,
      })
      if (isGroup && expanded) walk(node.children, depth + 1, node.id)
    }
  }
  walk(doc.nodes, 0)
  return rows
}

/** The chain from a root node down to `id`, inclusive. `undefined` when the id is not in the tree. */
export function nodePath(nodes: readonly SceneNode[], id: string): KnownNode[] | undefined {
  for (const node of nodes) {
    if (!isKnownNode(node)) continue
    if (node.id === id) return [node]
    if (!isGroupNode(node)) continue
    const below = nodePath(node.children, id)
    if (below) return [node, ...below]
  }
  return undefined
}

export function findNode(nodes: readonly SceneNode[], id: string): KnownNode | undefined {
  return nodePath(nodes, id)?.at(-1)
}

/** The top-level ancestor of `id` — what a canvas click selects, before any double-click descends. */
export function outermostOf(nodes: readonly SceneNode[], id: string): KnownNode | undefined {
  return nodePath(nodes, id)?.[0]
}

/** The group holding `id`, or `undefined` when it sits at the root. `Esc` on the canvas ascends to it. */
export function parentOf(nodes: readonly SceneNode[], id: string): GroupNode | undefined {
  const path = nodePath(nodes, id)
  const parent = path?.at(-2)
  return parent && isGroupNode(parent) ? parent : undefined
}

/** The array `id` lives in, so a caller can splice it. */
function siblingsOf(nodes: SceneNode[], id: string): SceneNode[] | undefined {
  if (nodes.some((node) => node.id === id)) return nodes
  for (const node of nodes) {
    if (!isGroupNode(node)) continue
    const found = siblingsOf(node.children, id)
    if (found) return found
  }
  return undefined
}

/** How many levels of group a subtree carries below its own row. A leaf is 0. */
export function subtreeDepth(node: SceneNode): number {
  if (!isGroupNode(node)) return 0
  return 1 + node.children.reduce((deepest, child) => Math.max(deepest, subtreeDepth(child)), 0)
}

/** The depth `id` sits at, counting the root as 0. */
export function depthOf(nodes: readonly SceneNode[], id: string): number {
  const path = nodePath(nodes, id)
  return path ? path.length - 1 : 0
}

/**
 * Whether a drag may land where the pointer says.
 *
 * Three refusals, and each shows **no indicator at all** rather than an indicator the drop then
 * rejects: a node cannot be dropped into itself, nor into any of its own descendants — which
 * would detach the subtree from the tree entirely — and no drop may push any part of the dragged
 * subtree past `MAX_GROUP_DEPTH`.
 */
export function canDrop(
  nodes: readonly SceneNode[],
  dragId: string,
  targetId: string,
  position: DropPosition,
): boolean {
  if (dragId === targetId) return false
  const dragged = findNode(nodes, dragId)
  const targetPath = nodePath(nodes, targetId)
  if (!dragged || !targetPath) return false
  if (targetPath.some((ancestor) => ancestor.id === dragId)) return false
  if (position === 'inside' && !isGroupNode(targetPath.at(-1) as SceneNode)) return false
  // "inside" lands one level below the target row; "before"/"after" land beside it.
  const landingDepth = targetPath.length - (position === 'inside' ? 0 : 1)
  // The cap is on groups, which is where `parseNode` puts it: a group may sit at depth 0…4, so its
  // children — leaves included — may sit at depth 5. A leaf therefore never fails this test, because
  // the only way to land one deeper than that is inside a group that could not have been made.
  if (!isGroupNode(dragged)) return true
  return landingDepth + subtreeDepth(dragged) - 1 < MAX_GROUP_DEPTH
}

/** Lifts `id` out of the tree and returns it, leaving the tree otherwise untouched. */
export function detachNode(nodes: SceneNode[], id: string): SceneNode | undefined {
  const siblings = siblingsOf(nodes, id)
  if (!siblings) return undefined
  const index = siblings.findIndex((node) => node.id === id)
  if (index < 0) return undefined
  return siblings.splice(index, 1)[0]
}

/**
 * The whole drag-to-reorder gesture: one move, one undo step, children carried along because they
 * hang off the node being moved.
 *
 * `position` is in **display** terms, which are the reverse of document order (`layerRows`), so a
 * drop "before" a row — visually above it — inserts *after* it in the document. Getting that
 * inversion wrong puts every reorder one slot out and reverses what a blur covers, which is why it
 * is stated here once rather than being re-derived by the panel.
 */
export function moveNode(
  nodes: SceneNode[],
  dragId: string,
  targetId: string,
  position: DropPosition,
): boolean {
  if (!canDrop(nodes, dragId, targetId, position)) return false
  const dragged = detachNode(nodes, dragId)
  if (!dragged) return false
  if (position === 'inside') {
    const target = findNode(nodes, targetId)
    if (!target || !isGroupNode(target)) return false
    // The top of a group's children in display order is the end of them in document order.
    target.children.push(dragged)
    return true
  }
  const siblings = siblingsOf(nodes, targetId)
  if (!siblings) return false
  const index = siblings.findIndex((node) => node.id === targetId)
  siblings.splice(position === 'before' ? index + 1 : index, 0, dragged)
  return true
}

/**
 * Moves selected nodes within their current parent. Document order runs bottom-to-top, so forward
 * means toward the end of a sibling array. A selected group moves as one node; locked selections and
 * descendants of locked groups do not move.
 */
export function reorderNodes(
  nodes: SceneNode[],
  ids: readonly string[],
  move: OrderMove,
): boolean {
  const selected = new Set(ids)
  let changed = false

  const reorder = (siblings: SceneNode[], inheritedLock: boolean, selectedAncestor: boolean): void => {
    const moving = new Set<string>()
    for (const node of siblings) {
      if (!isKnownNode(node)) continue
      const isSelected = selected.has(node.id)
      const locked = inheritedLock || node.locked === true
      if (isSelected && !selectedAncestor && !locked) moving.add(node.id)
      if (isGroupNode(node)) reorder(node.children, locked, selectedAncestor || isSelected)
    }
    if (moving.size === 0) return

    // Unknown nodes have no panel row and draw nothing in this build, so one keyboard step crosses
    // one known sibling, matching the order the user can see.
    const ordered = siblings.filter(isKnownNode)
    const desired = [...ordered]
    const isMoving = (index: number): boolean => moving.has((desired[index] as KnownNode).id)
    if (move === 'forward') {
      for (let index = desired.length - 2; index >= 0; index -= 1) {
        if (!isMoving(index) || isMoving(index + 1)) continue
        const current = desired[index]
        const next = desired[index + 1]
        if (!current || !next) continue
        desired[index] = next
        desired[index + 1] = current
      }
    } else if (move === 'backward') {
      for (let index = 1; index < desired.length; index += 1) {
        if (!isMoving(index) || isMoving(index - 1)) continue
        const previous = desired[index - 1]
        const current = desired[index]
        if (!previous || !current) continue
        desired[index - 1] = current
        desired[index] = previous
      }
    } else {
      const selectedNodes = ordered.filter((node) => moving.has(node.id))
      const stationary = ordered.filter((node) => !moving.has(node.id))
      desired.splice(0, desired.length, ...(move === 'front' ? [...stationary, ...selectedNodes] : [...selectedNodes, ...stationary]))
    }

    if (desired.every((node, index) => node === ordered[index])) return
    let edge = desired[0]
    if (!edge) return
    for (const node of desired.slice(1)) {
      if (moveNode(nodes, node.id, edge.id, 'before')) changed = true
      edge = node
    }
  }

  reorder(nodes, false, false)
  return changed
}

/**
 * Groups the given ids into one new group, inserted where the top-most of them sat.
 *
 * Only nodes sharing a parent can be grouped: grouping across two parents would have to move some
 * of them out of a group they were deliberately put in, and there is no reading of `Cmd G` that
 * makes that the obvious outcome. Returns the new group, or `undefined` when nothing was done.
 */
export function groupNodes(nodes: SceneNode[], ids: readonly string[], id = newNodeId()): GroupNode | undefined {
  if (ids.length < 2) return undefined
  const first = ids[0]
  if (first === undefined) return undefined
  const siblings = siblingsOf(nodes, first)
  if (!siblings) return undefined
  const members = siblings.filter((node) => ids.includes(node.id))
  if (members.length !== ids.length) return undefined
  const deepest = members.reduce((most, node) => Math.max(most, subtreeDepth(node)), 0)
  // The new group lands where the members are, so it is their depth that must still hold a group.
  if (depthOf(nodes, first) + deepest >= MAX_GROUP_DEPTH) return undefined
  const at = Math.max(...members.map((node) => siblings.indexOf(node)))
  for (const member of members) siblings.splice(siblings.indexOf(member), 1)
  const group: GroupNode = {
    id,
    type: 'group',
    transform: { ...IDENTITY },
    opacity: 1,
    children: members,
  }
  siblings.splice(Math.min(at - members.length + 1, siblings.length), 0, group)
  return group
}

/**
 * Dissolves a group, leaving its children in its place and in their own order.
 *
 * The group's transform is folded into each child's, because a child is stored in its parent's
 * frame: dropping the group without folding would teleport every child. Rotation and scale compose
 * as matrices; the result is decomposed back into the child's own transform.
 */
export function ungroupNode(nodes: SceneNode[], id: string): string[] {
  const group = findNode(nodes, id)
  if (!group || !isGroupNode(group)) return []
  const siblings = siblingsOf(nodes, id)
  if (!siblings) return []
  const parentMatrix = matrixOf(group.transform)
  const children = group.children
  for (const child of children) {
    if (!isKnownNode(child)) continue
    const world = decompose(multiply(parentMatrix, matrixOf(child.transform)))
    child.transform = { x: world.x, y: world.y, scaleX: world.scaleX, scaleY: world.scaleY, rotation: world.rotation }
    child.opacity *= group.opacity
  }
  siblings.splice(siblings.indexOf(group), 1, ...children)
  return children.map((child) => child.id)
}

// --- picking, and a node's own rectangle ------------------------------------

/**
 * The inverse of an affine matrix, or `undefined` when it collapses — a zero scale has no inverse,
 * and a shape scaled to nothing cannot be hit anyway.
 */
export function invert(matrix: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (determinant === 0) return undefined
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]
}

/**
 * The top-most shape under a scene-space point, or `undefined`.
 *
 * The point is taken back into each candidate's own frame and tested against its local box, so a
 * rotated shape is hit where it is drawn rather than anywhere inside the box it happens to span.
 * Locked nodes are skipped: they are not selectable on the canvas, and a locked node swallowing
 * clicks meant for the shape behind it is exactly the trap locking is supposed to avoid.
 */
export function hitTest(doc: SceneDoc, x: number, y: number): ShapeNode | undefined {
  const shapes = resolveShapes(doc)
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index]
    if (!shape || shape.locked) continue
    const inverse = invert(shape.matrix)
    if (!inverse) continue
    const local = applyMatrix(inverse, x, y)
    const box = localBounds(shape.node)
    if (local.x < box.x || local.x > box.x + box.width || local.y < box.y || local.y > box.y + box.height) continue
    const node = shape.node
    if ((node.type === 'counter' || node.type === 'text') && !pointerShapeHit(node, local.x, local.y)) continue
    if (node.type === 'arrow' && !arrowShapeHit(node, local.x, local.y)) continue
    // The source or the lens; the empty page between them, and the joining line, miss.
    if (node.type === 'magnifier' && !inShape(local, { x: 0, y: 0, width: node.width, height: node.height }, undefined) && !inShape(local, lensLocalRect(node), framePower(node))) continue
    return node
  }
  return undefined
}

/**
 * One node's scene-space bounding box, whether it is a leaf or a group.
 *
 * A group owns no geometry, so its box is the union of its visible descendants' —
 * which is what the hover and selection outlines draw, and what makes selecting a group on the
 * canvas show something rather than nothing.
 */
export function nodeBounds(doc: SceneDoc, id: string): Rect | undefined {
  const path = nodePath(doc.nodes, id)
  const node = path?.at(-1)
  if (!path || !node) return undefined
  const matrix = path.reduce<Matrix>((acc, ancestor) => multiply(acc, matrixOf(ancestor.transform)), IDENTITY_MATRIX)
  if (!isGroupNode(node)) return transformedBounds(localBounds(node), matrix)

  let box: Rect | undefined
  const walk = (nodes: readonly SceneNode[], parent: Matrix): void => {
    for (const child of nodes) {
      if (!isKnownNode(child) || child.hidden === true) continue
      const childMatrix = multiply(parent, matrixOf(child.transform))
      if (isGroupNode(child)) {
        walk(child.children, childMatrix)
        continue
      }
      const bounds = transformedBounds(localBounds(child), childMatrix)
      box = box ? union(box, bounds) : bounds
    }
  }
  walk(node.children, matrix)
  return box
}

// --- direct manipulation ----------------------------------------------------

/**
 * Everything below is what the selection handles need, and it lives here for the same reason rather
 * than in the preview: a surface that derives its own geometry is a second source of truth, and the
 * transform write-back is the most consequential arithmetic in the editor. Get it wrong and a drag
 * silently moves the wrong node, or moves it twice.
 */

/**
 * The product of `id`'s ancestors' transforms, **excluding its own** — the frame its stored
 * transform is expressed in.
 *
 * `IDENTITY_MATRIX` for a top-level node, which is every node until the user makes a group.
 */
export function parentMatrixOf(doc: SceneDoc, id: string): Matrix {
  const path = nodePath(doc.nodes, id)
  if (!path) return IDENTITY_MATRIX
  return path
    .slice(0, -1)
    .reduce<Matrix>((acc, ancestor) => multiply(acc, matrixOf(ancestor.transform)), IDENTITY_MATRIX)
}

/**
 * A node's own transform after a gesture whose net effect in **scene space** is `delta`.
 *
 * The conjugation is the whole point. `delta` is measured on the canvas, in scene space; a node's
 * transform is stored in its parent's frame. Applying one to the other directly would double-count
 * every ancestor transform, so the delta is first carried into the parent's frame —
 * `parent⁻¹ · delta · parent` — and only then composed with what the node already had.
 *
 * A collapsed parent has no inverse; the node cannot be seen, let alone dragged, so the transform is
 * returned untouched rather than being replaced with something invented.
 */
export function composeLocal(delta: Matrix, transform: Transform, parent: Matrix): Transform {
  const inverse = invert(parent)
  if (!inverse) return transform
  const local = multiply(multiply(inverse, delta), parent)
  const next = decompose(multiply(local, matrixOf(transform)))
  return { x: next.x, y: next.y, scaleX: next.scaleX, scaleY: next.scaleY, rotation: next.rotation }
}

/**
 * Folds a leaf's scale into its own geometry, so a resize changes the shape rather than magnifying
 * it — the stroke stays the weight the user chose, and the inspector's W and H stay the numbers they
 * were showing.
 *
 * This is the documented Konva recipe (read `scaleX`, write it into the size, reset the scale) with
 * one addition per type, because "bigger" means something different for each: a box grows, a line's
 * points stretch, and text never changes its font size on a resize. `scaleX` goes to the wrap
 * width; a `scaleY` other than 1 means a top, bottom or corner handle moved, and that fixes the box's
 * height, which the text is then clipped to.
 *
 * **The sign is kept on the transform, never folded.** A handle dragged past the opposite edge gives
 * a negative scale, and folding its magnitude while dropping the sign would un-mirror the node and
 * move it at the same time. Only the magnitude folds; a `-1` stays where Konva put it.
 */
export function foldScale(node: ShapeNode): void {
  const scaleX = node.transform.scaleX
  const scaleY = node.transform.scaleY
  const magnitudeX = Math.abs(scaleX)
  const magnitudeY = Math.abs(scaleY)
  if (magnitudeX === 1 && magnitudeY === 1) return

  switch (node.type) {
    case 'arrow':
    case 'line':
    case 'freehand':
      node.points = node.points.map((value, index) => value * (index % 2 === 0 ? magnitudeX : magnitudeY))
      if (node.type === 'arrow' && node.bend) node.bend = { x: node.bend.x * magnitudeX, y: node.bend.y * magnitudeY }
      break
    case 'text':
      // The pointer moves with the edge it hangs from: drag the bottom edge down and
      // a pointer below comes down by the same amount, keeping its shape; drag the top edge and it
      // stays on what it points at. `resizeTextBox` is
      // the same rule a new line of text uses. A counter's tail scales, with its disc.
      resizeTextBox(
        node,
        Math.max(MIN_SHAPE_SIZE, node.width * magnitudeX),
        magnitudeY !== 1 ? Math.max(MIN_SHAPE_SIZE, node.height * magnitudeY) : node.height,
      )
      if (magnitudeY !== 1) node.fixedHeight = true
      break
    case 'emoji':
      node.fontSize = Math.max(1, node.fontSize * magnitudeY)
      node.width = Math.max(MIN_SHAPE_SIZE, node.width * magnitudeX)
      node.height = Math.max(MIN_SHAPE_SIZE, node.height * magnitudeY)
      break
    case 'counter':
      // The tail scales with the disc, or resizing a badge would leave its point behind where the
      // old edge used to be. The anchors hold the ratio, so the two magnitudes are the same number.
      if (node.tip) node.tip = { x: node.tip.x * magnitudeX, y: node.tip.y * magnitudeY }
      node.width = Math.max(MIN_SHAPE_SIZE, node.width * magnitudeX)
      node.height = Math.max(MIN_SHAPE_SIZE, node.height * magnitudeY)
      break
    default:
      node.width = Math.max(MIN_SHAPE_SIZE, node.width * magnitudeX)
      node.height = Math.max(MIN_SHAPE_SIZE, node.height * magnitudeY)
      break
  }
  node.transform.scaleX = scaleX < 0 ? -1 : 1
  node.transform.scaleY = scaleY < 0 ? -1 : 1
}

/**
 * The geometry a leaf will commit to if a resize by `scaleX`/`scaleY` ended now, as a fresh node.
 *
 * The preview draws this mid-gesture under an inverse scale, so a stroke keeps its weight while the
 * handles move rather than stretching until release. Going through `foldScale` is what guarantees
 * the live shape and the committed one are the same shape.
 */
export function liveFold(node: ShapeNode, scaleX: number, scaleY: number): ShapeNode {
  const folded = structuredClone(node)
  folded.transform = { ...folded.transform, scaleX, scaleY }
  foldScale(folded)
  return folded
}

/**
 * Where a child drawn at folded geometry sits, and at what scale, inside a group Konva has scaled by
 * `scaleX`/`scaleY`, so that it lands exactly where the committed shape will.
 *
 * The group scales the child's *position* as well as its drawing. An ellipse's child sits at its
 * centre, `width / 2`, so undoing only the drawing put that centre at `width * scale² / 2`: too far
 * right mid-drag, and a jump left on release. Both are divided by the scale's magnitude; the sign
 * stays with the group, which is what mirrors the shape.
 */
export function inverseScale(
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
): { x: number; y: number; scaleX: number; scaleY: number } {
  const magnitudeX = Math.abs(scaleX) || 1
  const magnitudeY = Math.abs(scaleY) || 1
  return { x: x / magnitudeX, y: y / magnitudeY, scaleX: 1 / magnitudeX, scaleY: 1 / magnitudeY }
}

/**
 * Whether a shape draws a stroke at all. Both renderers ask this rather than reading `stroke`: a
 * canvas ignores a colour it cannot parse, so `'none'` would silently draw in whatever colour the
 * previous shape left on the context.
 */
export function hasStroke(node: ShapeNode): boolean {
  return 'stroke' in node && node.stroke !== 'none' && 'strokeWidth' in node && node.strokeWidth > 0
}

/**
 * How far, in screen pixels, the selection outline sits from a selection's geometry so that a
 * `lineWidth`-pixel line lies wholly outside the widest stroke rather than across it. Strokes
 * are scene units, so they are scaled to the screen first.
 */
export function selectionPadding(strokeWidths: readonly number[], scale: number, lineWidth = 1): number {
  const widest = strokeWidths.reduce((max, width) => Math.max(max, width), 0)
  return (widest / 2) * scale + lineWidth / 2
}

/** How far the rotate handle sits outside the selection outline, in screen pixels. */
export const ROTATE_ANCHOR_GAP = 18

/**
 * Konva's `rotateAnchorOffset` for a transformer padded by `padding`, so the handle sits
 * `ROTATE_ANCHOR_GAP` outside the *padded* outline.
 *
 * Konva measures the offset from the unpadded box and then moves the handle by the padding the
 * wrong way -- inward (`- padding * dirY` in `Transformer.update`, Konva 10.3). A pen's padding is a
 * pixel or two and hid it; a marker's is half a 16-unit stroke, which put the handle on the stroke.
 * ponytail: remove the `2 *` term if Konva ever fixes the sign.
 */
export function rotateAnchorOffset(padding: number): number {
  return ROTATE_ANCHOR_GAP + 2 * padding
}

/**
 * A box's four corners grown outward by `pad` in its own units, then placed by `matrix` — the hover
 * and locked-shape outline, which like the transformer's border sits outside the stroke.
 *
 * ponytail: `pad` is in the shape's own units, so a shape inside a scaled group gets a pad scaled
 * with the group. Groups are created at identity and are not scaled by any control today.
 */
export function expandedQuad(matrix: Matrix, width: number, height: number, pad: number): { x: number; y: number }[] {
  return [
    applyMatrix(matrix, -pad, -pad),
    applyMatrix(matrix, width + pad, -pad),
    applyMatrix(matrix, width + pad, height + pad),
    applyMatrix(matrix, -pad, height + pad),
  ]
}

/**
 * The visible leaf shapes a selection resolves to: a selected shape is itself, and a selected group
 * is its descendants.
 *
 * The handles attach to these, because neither renderer is ever handed a group — `flatten` resolves
 * the tree away. Document order is preserved, and a node selected twice (itself and inside a
 * selected ancestor) appears once.
 */
export function selectionLeaves(doc: SceneDoc, ids: readonly string[]): ResolvedShape[] {
  const wanted = new Set(ids)
  return resolveShapes(doc).filter((shape) => {
    const path = nodePath(doc.nodes, shape.node.id)
    return path !== undefined && path.some((node) => wanted.has(node.id))
  })
}

/**
 * The leaves the selection handles may attach to: `selectionLeaves` minus anything locked.
 *
 * Separate from `selectionLeaves` because the two questions have different answers. A locked node
 * is still *selected* — the panel selects it deliberately, and a lock you cannot
 * undo from the interface is a trap — so it still takes a selection outline, still reports its
 * numbers to the inspector, and still counts toward zoom-to-selection. What it must not take is a
 * handle, because a handle is a gesture that changes it, and that is the one thing a lock means.
 */
export function handleTargets(doc: SceneDoc, ids: readonly string[]): ResolvedShape[] {
  return selectionLeaves(doc, ids).filter((leaf) => !leaf.locked)
}

/** Konva's anchor names for the eight resize handles, in the order `enabledAnchors` takes them. */
export const BOX_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const

/**
 * Which anchors a selection of these types gets.
 *
 * Nine handles for a shape — the eight above plus rotation. Text gets all nine too: its
 * sides set the wrap width, and its top, bottom and corners size the box without touching the font.
 *
 * A mixed selection takes the intersection — the alternative is a handle that silently does nothing
 * to one member of the selection.
 */
export function isStraightSelection(types: readonly KnownNode['type'][]): boolean {
  const only = types.length === 1 ? types[0] : undefined
  return only === 'arrow' || only === 'line'
}

export function anchorsFor(types: readonly KnownNode['type'][]): string[] {
  // One arrow or one line is two points, not a box. A box around it offers eight handles of which
  // six can only shear or squash the segment, and none of them says what the thing actually is. It
  // gets two endpoint handles instead, drawn by the renderer. More than one, or one mixed with
  // anything else, is a box again: then you are scaling a group and the box is the right idea.
  if (isStraightSelection(types)) return []
  // An emoji is one glyph: a side handle could only stretch it, and its width is re-measured from the
  // font on the next render, so the stretch snapped back and the handle did nothing. It keeps the
  // four corners, which hold its ratio.
  if (!types.includes('emoji') && !types.includes('counter')) return [...BOX_ANCHORS]
  return BOX_ANCHORS.filter((anchor) => !anchor.includes('center') && !anchor.includes('middle'))
}

/**
 * Whether a corner handle holds the selection's ratio on its own, without Shift.
 *
 * An emoji cannot be stretched at all, so a selection made only of emoji always keeps its shape from
 * a corner. Anything else, text included, resizes freely and Shift constrains.
 */
export function cornersHoldRatio(types: readonly unknown[]): boolean {
  return types.length > 0 && types.every((type) => type === 'emoji' || type === 'counter' || type === 'image')
}

/**
 * Whether the middle-left and middle-right anchors fit between the corners on screen.
 *
 * Below this the side anchor overlaps both corners, so a press meant for a corner lands on the side
 * and reflows text instead of scaling it. Figma hides its
 * side handles on a short box for the same reason.
 */
export function sideAnchorsFit(screenHeight: number, anchorSize: number): boolean {
  return Math.abs(screenHeight) >= anchorSize * 3
}

/**
 * The box a ratio-locked resize should take, given the unconstrained box the pointer asked for.
 *
 * The axis that leads is the one that changed more **relative to its own size**. Comparing absolute
 * change made a wide, short text flip between the two axes from one pointer move to the next: ten
 * units is 3% of a 300-wide box and 40% of a 24-tall one, so the chosen scale jumped every frame.
 */
export function ratioLockedBox<T extends { x: number; y: number; width: number; height: number; rotation: number }>(
  oldBox: T,
  newBox: T,
  fixed: { u: number; v: number } = { u: 0, v: 0 },
): T {
  if (oldBox.width === 0 || oldBox.height === 0) return newBox
  const ratio = oldBox.width / oldBox.height
  const byWidth = Math.abs(newBox.width / oldBox.width - 1) >= Math.abs(newBox.height / oldBox.height - 1)
  const width = byWidth ? newBox.width : newBox.height * ratio
  const height = byWidth ? newBox.width / ratio : newBox.height
  // Changing the size moves every corner but the box's origin, which is only right when the dragged
  // corner is the bottom-right one. The point that should stay still -- the opposite corner, or the
  // centre -- is found in the pointer's box and put back, along the box's own (rotated) axes. Without
  // this, every other corner jumped each frame.
  const cos = Math.cos(newBox.rotation)
  const sin = Math.sin(newBox.rotation)
  const at = (w: number, h: number) => ({
    x: fixed.u * w * cos - fixed.v * h * sin,
    y: fixed.u * w * sin + fixed.v * h * cos,
  })
  const held = at(newBox.width, newBox.height)
  const now = at(width, height)
  return { ...newBox, width, height, x: newBox.x + held.x - now.x, y: newBox.y + held.y - now.y }
}

/**
 * A deep copy of a node with fresh ids throughout, for duplicate and paste.
 *
 * Ids are regenerated at every depth: a copied group whose children kept their originals' ids would
 * give `findNode` two answers for one id, and every lookup in the editor would then depend on
 * document order.
 */
export function cloneSubtree(node: SceneNode): SceneNode {
  const copy = structuredClone(node) as SceneNode
  const rename = (target: SceneNode): void => {
    target.id = newNodeId()
    if (isGroupNode(target)) for (const child of target.children) rename(child)
  }
  rename(copy)
  return copy
}

/**
 * Leaves copies under the selected subtrees so an Alt-drag can move the originals without rebuilding
 * the renderer mid-gesture. Copies stay beside their originals and locked paths are left untouched.
 */
export function duplicateNodesInPlace(nodes: SceneNode[], ids: readonly string[]): boolean {
  const selected = new Set(ids)
  let duplicated = false

  const duplicate = (siblings: SceneNode[], inheritedLock: boolean, selectedAncestor: boolean): void => {
    const next: SceneNode[] = []
    for (const node of siblings) {
      if (!isKnownNode(node)) {
        next.push(node)
        continue
      }
      const isSelected = selected.has(node.id)
      const locked = inheritedLock || node.locked === true
      if (isSelected && !selectedAncestor && !locked) {
        next.push(cloneSubtree(node))
        duplicated = true
      }
      next.push(node)
      if (isGroupNode(node)) duplicate(node.children, locked, selectedAncestor || isSelected)
    }
    siblings.splice(0, siblings.length, ...next)
  }

  duplicate(nodes, false, false)
  return duplicated
}

/**
 * The scene-space delta a Konva gesture produced, given one node's world matrix before and after.
 *
 * `Konva.Transformer` computes one delta and applies it to every node it holds, so reading it off a
 * single node is exact for a multi-node gesture as well — and reading it off *one* node is what lets
 * a group be moved by writing one transform rather than rewriting every child.
 */
export function gestureDelta(before: Matrix, after: Matrix): Matrix | undefined {
  const inverse = invert(before)
  return inverse ? multiply(after, inverse) : undefined
}

// --- snapping ---------------------------------------------------------------

/**
 * Snapping. The thresholds are the surface's business — they are in *screen*
 * pixels, because a scene-unit threshold feels sticky at 25% zoom and unreachable at 400% — but
 * what snaps to what is geometry, so it lives here.
 */

/** One line a moving shape can align to, and the rectangle it belongs to, which the guide spans. */
export interface SnapStop {
  at: number
  from: Rect
}

export interface SnapCandidates {
  x: SnapStop[]
  y: SnapStop[]
}

/** A rectangle's left / centre / right, or its top / middle / bottom. */
function linesOf(rect: Rect): { x: number[]; y: number[] } {
  return {
    x: [rect.x, rect.x + rect.width / 2, rect.x + rect.width],
    y: [rect.y, rect.y + rect.height / 2, rect.y + rect.height],
  }
}

/**
 * Every line the moving selection can align to: the six of each other visible shape, and the six of
 * the frame.
 *
 * The frame earns its place because most annotation is aligned to the screenshot rather than to
 * another annotation — an arrow centred on the picture is the common case, and without the frame's
 * lines it is the one thing that cannot be snapped.
 */
export function snapCandidates(
  doc: SceneDoc,
  bandHeight: number,
  moving: ReadonlySet<string>,
): SnapCandidates {
  const rects: Rect[] = [frameRect(doc, bandHeight)]
  for (const shape of resolveShapes(doc)) {
    if (moving.has(shape.node.id)) continue
    rects.push(shape.bounds)
  }
  const candidates: SnapCandidates = { x: [], y: [] }
  for (const rect of rects) {
    const lines = linesOf(rect)
    for (const at of lines.x) candidates.x.push({ at, from: rect })
    for (const at of lines.y) candidates.y.push({ at, from: rect })
  }
  return candidates
}

export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
  from: Rect
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/** The nearest stop to any of `lines`, within `threshold`, as the offset that would reach it. */
function nearest(lines: readonly number[], stops: readonly SnapStop[], threshold: number): SnapStop & { offset: number } | undefined {
  let best: (SnapStop & { offset: number }) | undefined
  for (const line of lines) {
    for (const stop of stops) {
      const offset = stop.at - line
      if (Math.abs(offset) > threshold) continue
      if (best && Math.abs(best.offset) <= Math.abs(offset)) continue
      best = { ...stop, offset }
    }
  }
  return best
}

/**
 * How far a moving rectangle must shift to snap, and which guides to draw for it.
 *
 * Each axis is decided independently — a shape can be aligned left to one neighbour and top to
 * another at the same time, which is what makes snapping feel like alignment rather than magnetism.
 *
 * `grid` is a fallback rather than an override: an alignment to a real edge is always more useful
 * than an alignment to an invisible lattice, so the grid only acts on an axis nothing else claimed.
 * Zero turns it off, which is the default.
 */
export function snapDelta(
  bounds: Rect,
  candidates: SnapCandidates,
  threshold: number,
  grid = 0,
): SnapResult {
  const lines = linesOf(bounds)
  const result: SnapResult = { dx: 0, dy: 0, guides: [] }
  const x = nearest(lines.x, candidates.x, threshold)
  const y = nearest(lines.y, candidates.y, threshold)
  if (x) {
    result.dx = x.offset
    result.guides.push({ axis: 'x', at: x.at, from: x.from })
  } else if (grid > 0) {
    result.dx = Math.round(bounds.x / grid) * grid - bounds.x
  }
  if (y) {
    result.dy = y.offset
    result.guides.push({ axis: 'y', at: y.at, from: y.from })
  } else if (grid > 0) {
    result.dy = Math.round(bounds.y / grid) * grid - bounds.y
  }
  return result
}

/** 8 scene units, and only when the user has turned the grid on. */
export const SNAP_GRID = 8

/** 5 CSS pixels, converted to scene units by the current zoom at the moment of the drag. */
export const SNAP_THRESHOLD_CSS = 5

/**
 * The union of the visible leaf bounds of a selection, in scene space — what a drag moves, and what
 * the snapping measures.
 */
export function selectionBounds(doc: SceneDoc, ids: readonly string[]): Rect | undefined {
  const leaves = selectionLeaves(doc, ids)
  const first = leaves[0]
  if (!first) return undefined
  return leaves.slice(1).reduce((acc, leaf) => {
    const left = Math.min(acc.x, leaf.bounds.x)
    const top = Math.min(acc.y, leaf.bounds.y)
    const right = Math.max(acc.x + acc.width, leaf.bounds.x + leaf.bounds.width)
    const bottom = Math.max(acc.y + acc.height, leaf.bounds.y + leaf.bounds.height)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }, first.bounds)
}

/**
 * What a canvas click on `hitId` selects: the outermost group, unless something on the path to
 * the hit is already selected, in which case that depth is kept — descending stays descended.
 *
 * A press uses the same answer to decide whether it must select before it can drag (as in
 * Figma, an unselected shape drags in one gesture).
 */
export function clickTarget(doc: SceneDoc, selection: readonly string[], hitId: string): string {
  const path = nodePath(doc.nodes, hitId) ?? []
  return path.find((node) => selection.includes(node.id))?.id ?? outermostOf(doc.nodes, hitId)?.id ?? hitId
}

/**
 * The outermost nodes whose visible bounds meet `rect` — what a rubber-band drag selects.
 *
 * Outermost, because a canvas selection selects the outermost group and descends on a double-click;
 * a marquee that picked leaves out of groups would contradict the click it sits beside. Locked
 * nodes are excluded for the same reason `hitTest` skips them.
 */
export function nodesInRect(doc: SceneDoc, rect: Rect): string[] {
  const ids: string[] = []
  for (const shape of resolveShapes(doc)) {
    if (shape.locked || !rectsIntersect(shape.bounds, rect)) continue
    const outermost = outermostOf(doc.nodes, shape.node.id)
    if (outermost && !ids.includes(outermost.id)) ids.push(outermost.id)
  }
  return ids
}

// --- crop, as a mode --------------------------------------------------------

/**
 * Crop mode, in numbers.
 *
 * A crop is not a node — it is an override on `outputRect` rather than a member of the stack —
 * so none of the direct-manipulation arithmetic above applies to it. What it still needs is the same
 * one-owner rule: the surface draws a scrim and a grid, and this module decides where the rectangle is.
 */

/** The crop presets, in the order the inspector shows it. */
export const CROP_PRESETS = ['free', 'original', '16:9', '4:3', '1:1'] as const

export type CropPreset = (typeof CROP_PRESETS)[number]

/**
 * A preset's aspect ratio, or `undefined` for `free`, which constrains nothing.
 *
 * `original` is the **capture's** ratio rather than the current output's: the output grows with a
 * shape dragged past the frame's edge, so an "original" that followed it would mean something
 * different depending on where the user had last dropped an arrow.
 */
export function cropRatioFor(preset: CropPreset, doc: SceneDoc): number | undefined {
  switch (preset) {
    case 'free':
      return undefined
    case 'original':
      return doc.capture.height === 0 ? undefined : doc.capture.width / doc.capture.height
    case '16:9':
      return 16 / 9
    case '4:3':
      return 4 / 3
    case '1:1':
      return 1
  }
}

/**
 * The rectangle the crop mode opens on when no crop is set: the whole picture.
 *
 * `contentRect` rather than `outputRect`, because `outputRect` *is* the crop once one exists — using
 * it would mean the first preset applied after a crop was set measured against the crop itself, and
 * `Free` would then be unable to get back to the whole picture. The margin is excluded for the same
 * reason it is excluded from `contentRect`: it is a frame around the picture, not part of it.
 */
export function defaultCrop(doc: SceneDoc, bandHeight: number): Rect {
  return contentRect(doc, bandHeight)
}

/**
 * `rect` fitted to an aspect ratio, centred on itself.
 *
 * It **shrinks, never grows.** The alternative — keeping the larger axis and extending the other —
 * walks the crop off the picture the moment the user picks 16:9 on a tall capture, which is the one
 * shape of capture this tool mostly produces. Shrinking always lands inside a rectangle the user
 * could already see.
 */
export function cropForRatio(rect: Rect, ratio: number | undefined): Rect {
  if (ratio === undefined || !(ratio > 0)) return rect
  const width = Math.min(rect.width, rect.height * ratio)
  const height = width / ratio
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  }
}

/**
 * A crop rectangle from a gesture's raw box.
 *
 * A handle dragged past the opposite edge gives a negative extent, exactly as it does for a shape —
 * but a shape keeps the mirror (`foldScale` leaves the sign on the transform) while a crop cannot:
 * there is nothing to mirror, only a rectangle that is now the other way round. So the sign is
 * resolved into the origin here rather than being carried anywhere.
 *
 * The floor is `MIN_SHAPE_SIZE`, the same "four units of drift is a twitch" the draw tools use, and
 * for the same reason: `parseCrop` refuses a crop with no area, so a gesture is not allowed to
 * produce one either.
 */
export function normalizeCrop(box: Rect): Rect {
  const width = Math.max(MIN_SHAPE_SIZE, Math.abs(box.width))
  const height = Math.max(MIN_SHAPE_SIZE, Math.abs(box.height))
  return {
    x: box.width < 0 ? box.x - width : box.x,
    y: box.height < 0 ? box.y - height : box.y,
    width,
    height,
  }
}
