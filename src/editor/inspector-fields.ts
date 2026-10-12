import { ARROW_STYLES, MAGNIFIER_SHAPES, type MagnifierShape, defaultTextTip, resizeTextBox, type ArrowStyle, type KnownNode, type TextNode } from './scene'

export type InspectorNumberFieldKey =
  | 'opacity'
  | 'strokeWidth'
  | 'radius'
  | 'headSize'
  | 'arrowSize'
  | 'roundness'
  | 'count'
  | 'fontSize'
  | 'fontWeight'
  | 'transform.x'
  | 'transform.y'
  | 'width'
  | 'height'
  | 'transform.rotation'
  | 'segmentAngle'

export type InspectorColorFieldKey = 'stroke' | 'fill' | 'color'
export type InspectorAlignFieldKey = 'align'
export type InspectorCheckFieldKey = 'autoHeight' | 'italic' | 'marker' | 'filled'
/** `''` is the system font. */
export type InspectorSelectFieldKey = 'fontFamily' | 'arrowStyle' | 'magnifierShape'
export type InspectorFieldKey =
  | InspectorNumberFieldKey
  | InspectorColorFieldKey
  | InspectorAlignFieldKey
  | InspectorCheckFieldKey
  | InspectorSelectFieldKey

export type InspectorFieldValue<Key extends InspectorFieldKey> = Key extends InspectorNumberFieldKey
  ? number
  : Key extends InspectorAlignFieldKey
    ? 'left' | 'center' | 'right'
    : Key extends InspectorCheckFieldKey
      ? boolean
      : string

export function readInspectorField<Key extends InspectorFieldKey>(
  node: KnownNode,
  key: Key,
): InspectorFieldValue<Key> | undefined
export function readInspectorField(node: KnownNode, key: InspectorFieldKey): number | string | boolean | undefined {
  switch (key) {
    case 'autoHeight': return node.type === 'text' ? node.fixedHeight !== true : undefined
    case 'italic': return node.type === 'text' ? node.italic === true : undefined
    case 'marker': return node.type === 'freehand' ? node.marker === true : undefined
    case 'filled': return node.type === 'text' ? node.fill !== undefined : undefined
    case 'fontFamily': return node.type === 'text' ? (node.fontFamily ?? '') : undefined
    case 'arrowStyle': return node.type === 'arrow' ? node.style : undefined
    case 'magnifierShape': return node.type === 'magnifier' ? node.shape : undefined
    case 'transform.x': return node.transform.x
    case 'transform.y': return node.transform.y
    case 'transform.rotation': return node.transform.rotation
    case 'segmentAngle': return 'points' in node ? segmentAngle(node) : undefined
    case 'opacity': return node.opacity
    case 'width': return 'width' in node ? node.width : undefined
    case 'height': return 'height' in node ? node.height : undefined
    case 'stroke': return 'stroke' in node ? node.stroke : undefined
    case 'strokeWidth': return 'strokeWidth' in node ? node.strokeWidth : undefined
    // Plain text has no box, so no Box row: Filled is the one switch.
    case 'fill': return 'fill' in node ? node.fill : undefined
    case 'radius': return 'radius' in node ? node.radius : undefined
    case 'headSize': return node.type === 'arrow' ? node.headSize : undefined
    case 'arrowSize': return node.type === 'arrow' ? node.size : undefined
    case 'roundness': return node.type === 'magnifier' ? node.roundness : undefined
    case 'count': return node.type === 'counter' ? node.count : undefined
    case 'fontSize': return 'fontSize' in node ? node.fontSize : undefined
    case 'fontWeight': return node.type === 'text' ? node.fontWeight : undefined
    case 'align': return node.type === 'text' ? node.align : undefined
    case 'color': return 'color' in node ? node.color : undefined
  }
}

export function writeInspectorField<Key extends InspectorFieldKey>(
  node: KnownNode,
  key: Key,
  value: InspectorFieldValue<Key>,
): boolean
export function writeInspectorField(node: KnownNode, key: InspectorFieldKey, value: number | string | boolean): boolean {
  if (key === 'autoHeight') {
    if (node.type !== 'text' || typeof value !== 'boolean') return false
    // Auto on hands the height back to the renderer's measurement on the next draw; off keeps the
    // current height as the fixed box.
    if (value) delete node.fixedHeight
    else node.fixedHeight = true
    return true
  }
  if (key === 'italic') {
    if (node.type !== 'text' || typeof value !== 'boolean') return false
    if (value) node.italic = true
    else delete node.italic
    return true
  }
  if (key === 'marker') {
    if (node.type !== 'freehand' || typeof value !== 'boolean') return false
    // On is `multiply`: the stroke tints what is under it instead of painting over it.
    if (value) node.marker = true
    else delete node.marker
    return true
  }
  if (key === 'filled') {
    if (node.type !== 'text' || typeof value !== 'boolean') return false
    setTextFilled(node, value)
    return true
  }
  if (key === 'fill' && node.type === 'text') {
    // Only a filled box's colour; filling is the Filled switch's job.
    if (typeof value !== 'string' || value === 'none' || node.fill === undefined) return false
    node.fill = value
    return true
  }
  if (key === 'fontFamily') {
    if (node.type !== 'text' || typeof value !== 'string') return false
    if (value.trim() === '') delete node.fontFamily
    else node.fontFamily = value.trim()
    return true
  }
  if (key === 'arrowStyle') {
    if (node.type !== 'arrow' || !ARROW_STYLES.includes(value as ArrowStyle)) return false
    node.style = value as ArrowStyle
    return true
  }
  if (key === 'magnifierShape') {
    if (node.type !== 'magnifier' || !MAGNIFIER_SHAPES.includes(value as MagnifierShape)) return false
    node.shape = value as MagnifierShape
    return true
  }
  if (key === 'align') {
    if (node.type !== 'text' || (value !== 'left' && value !== 'center' && value !== 'right')) return false
    node.align = value
    return true
  }

  if (typeof value === 'string') {
    switch (key) {
      case 'stroke':
        if (!('stroke' in node)) return false
        node.stroke = value
        return true
      case 'fill':
        if (!('fill' in node)) return false
        node.fill = value
        return true
      case 'color':
        if (!('color' in node)) return false
        node.color = value
        return true
    }
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  switch (key) {
    case 'transform.x': node.transform.x = value; return true
    case 'transform.y': node.transform.y = value; return true
    case 'transform.rotation': node.transform.rotation = value; return true
    case 'segmentAngle': {
      if (!('points' in node)) return false
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
      node.points = rotatedSegment(node, value)
      // The bend turns with the ends, or a curve would change shape as its angle was typed.
      if (node.type === 'arrow' && node.bend) {
        const [a1 = 0, b1 = 0, a2 = 0, b2 = 0] = node.points
        const turn = Math.atan2(b2 - b1, a2 - a1) - Math.atan2(y2 - y1, x2 - x1)
        const { x, y } = node.bend
        node.bend = { x: x * Math.cos(turn) - y * Math.sin(turn), y: x * Math.sin(turn) + y * Math.cos(turn) }
      }
      return true
    }
    case 'opacity': node.opacity = value; return true
    case 'width':
      if (!('width' in node)) return false
      if (node.type === 'text') resizeTextBox(node, value, node.height)
      else node.width = value
      return true
    case 'height':
      if (!('height' in node)) return false
      if (node.type === 'text') resizeTextBox(node, node.width, value)
      else node.height = value
      // Typing a text box's H is sizing the box, the same as dragging its bottom handle.
      if (node.type === 'text') node.fixedHeight = true
      return true
    case 'strokeWidth':
      if (!('strokeWidth' in node)) return false
      node.strokeWidth = value
      return true
    case 'radius':
      if (!('radius' in node)) return false
      node.radius = value
      return true
    case 'fontSize':
      if (!('fontSize' in node)) return false
      node.fontSize = value
      return true
    case 'headSize':
      if (node.type !== 'arrow') return false
      node.headSize = value
      return true
    case 'roundness':
      if (node.type !== 'magnifier') return false
      node.roundness = value
      return true
    case 'arrowSize':
      if (node.type !== 'arrow') return false
      node.size = Math.round(value)
      return true
    case 'count':
      if (node.type !== 'counter') return false
      // Whole numbers only: `counterFontSize` sizes the digits by how many there are, and the
      // renderers draw `String(count)`, so a 2.5 would render as "2.5" inside a disc sized for one.
      node.count = Math.max(0, Math.round(value))
      return true
    case 'fontWeight':
      if (node.type !== 'text') return false
      node.fontWeight = value
      return true
  }
  return false
}

/**
 * Filled and plain text trade one colour: filling a text makes its colour
 * the box and the letters white, and unfilling hands the box colour back to the letters -- so red text
 * becomes a red box, and not red letters on a red box. The pointer is placed the first time only, so
 * unfilling and refilling keeps where it was dragged.
 */
function setTextFilled(node: TextNode, filled: boolean): void {
  if (filled === (node.fill !== undefined)) return
  if (filled) {
    node.fill = node.color
    node.color = '#FFFFFF'
    node.tip ??= defaultTextTip(node)
  } else {
    node.color = node.fill ?? node.color
    delete node.fill
  }
}

/**
 * A straight arrow or line has no rotation of its own — it is two points, and a freshly drawn
 * diagonal one sits at `transform.rotation` 0 with the angle hidden in the points. So `R` on a
 * segment is this: the angle its own points make, plus whatever rotation its transform carries.
 *
 * ponytail: the transform's scale is ignored. A non-uniformly scaled frame shears the visual angle
 * away from this number, and a segment cannot be scaled by hand — it has two endpoint handles
 * and no resize anchors — so the only way in is a group transform, which `Cmd G` produces at
 * identity. Resolve it through the parent's matrix if group transforms ever become editable.
 */
function segmentAngle(node: KnownNode & { points: readonly number[] }): number {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
  return normaliseAngle(node.transform.rotation + (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI)
}

/**
 * The same segment at a new angle: the midpoint and the length are kept and both ends swing, which
 * is what rotating a line does everywhere else — rotating about one end would move the other end to
 * somewhere the user did not ask for.
 */
function rotatedSegment(node: KnownNode & { points: readonly number[] }, angle: number): number[] {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = node.points
  const half = Math.hypot(x2 - x1, y2 - y1) / 2
  const radians = ((angle - node.transform.rotation) * Math.PI) / 180
  const dx = Math.cos(radians) * half
  const dy = Math.sin(radians) * half
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  return [cx - dx, cy - dy, cx + dx, cy + dy]
}

/** Into (-180, 180], the range `atan2` already reports and the range the field accepts. */
export function normaliseAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/**
 * One inspector edit as one undo step, Figma's model.
 *
 * A focused field, or a held scrub, is a session. Its first write snapshots the document for undo
 * and every later write rides on that snapshot; focus leaving or Enter ends it. A session that wrote
 * nothing leaves no step. Esc cancels, and reports whether there is a snapshot to drop after the
 * values on focus are put back.
 */
export interface EditSession {
  /** Call before each write. True only for the first, when the host must snapshot. */
  change(): boolean
  finish(): void
  cancel(): boolean
}

export function editSession(): EditSession {
  let wrote = false
  return {
    change: () => {
      const first = !wrote
      wrote = true
      return first
    },
    finish: () => {
      wrote = false
    },
    cancel: () => {
      const had = wrote
      wrote = false
      return had
    },
  }
}
