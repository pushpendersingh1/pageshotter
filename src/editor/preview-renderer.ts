/*
 * `konva/lib/Core` first, and it is not optional.
 *
 * Konva's `Stage._pointermove` calls `Konva.isDragging()`, which reads `Konva['DD']` -- and `DD` is
 * assigned onto the global only by `_CoreInternals`, which `Core` is the entry point for. Importing
 * `konva/lib/Stage` and the shapes directly, as the tree-shaking advice says to, leaves `Konva.DD`
 * undefined, so **every pointer move over the stage threw** `Cannot read properties of undefined
 * (reading 'isDragging')` before Konva could fire a single event. Drawing, canvas selection and
 * canvas hover were all dead behind that one line; panning and zooming survived only because they
 * are native listeners on the host element rather than Konva events.
 *
 * Found in the browser console. It also explains why no synthetic pointer event ever
 * reached a stage handler in the automation harness, which had been recorded as a harness limit.
 */
import { Konva } from 'konva/lib/Core'
import { Stage } from 'konva/lib/Stage'
import { Layer } from 'konva/lib/Layer'
import { Group } from 'konva/lib/Group'
import { Rect as KonvaRect } from 'konva/lib/shapes/Rect'
import { Ellipse } from 'konva/lib/shapes/Ellipse'
import { Line } from 'konva/lib/shapes/Line'
import { Text } from 'konva/lib/shapes/Text'
import { Image as KonvaImage } from 'konva/lib/shapes/Image'
import { Circle } from 'konva/lib/shapes/Circle'
import { Label, Tag } from 'konva/lib/shapes/Label'
import { Transformer } from 'konva/lib/shapes/Transformer'
import { Shape as KonvaShape, type Shape } from 'konva/lib/Shape'
import type { Node } from 'konva/lib/Node'
import { chromeDensityFor } from '../result/chrome-template'
import { loadChromePieces, renderChromeBand } from '../result/present'
import { PRESENT_GRADIENTS } from '../result/presentation-options'
import type { TiledImage } from '../result/stitcher'
import { decodedImage, decodeImage, drawMagnifier, renderSceneWindow, roundedRectPath, SCENE_FONT, shapeQuad, type SceneRenderDetails } from './export-renderer'
import {
  BLUR_SUPPORT,
  blurWindow,
  cornersHoldRatio,
  BOX_ANCHORS,
  anchorsFor,
  applyMatrix,
  lensAround,
  invert,
  multiply,
  magnifierWorld,
  type MagnifierNode,
  arrowMiddle,
  arrowPath,
  localBounds,
  type ArrowNode,
  isStraightSelection,
  decompose,
  findNode,
  flatten,
  gestureDelta,
  handleTargets,
  hasStroke,
  IDENTITY_MATRIX,
  expandedQuad,
  inverseScale,
  isGroupNode,
  isShapeNode,
  type ShapeType,
  liveFold,
  constrainDrag,
  counterFontSize,
  counterPath,
  matrixOf,
  nodeBounds,
  normalizeCrop,
  ratioLockedBox,
  rectsIntersect,
  renderRect,
  resolveShapes,
  selectionBounds,
  selectionLeaves,
  selectionPadding,
  textFontFamily,
  textInset,
  textBubblePath,
  resizeTextBox,
  textFontStyle,
  sideAnchorsFit,
  rotateAnchorOffset,
  snapCandidates,
  snapDelta,
  SNAP_GRID,
  SNAP_THRESHOLD_CSS,
  type DrawModifiers,
  type DrawOp,
  type Matrix,
  type Rect,
  type ResolvedShape,
  type SceneDoc,
  type SceneNode,
  type SnapCandidates,
  type SnapGuide,
} from './scene'

// Middle-drag belongs to canvas pan; Konva otherwise starts node drags for buttons 0 and 1.
Konva.dragButtons = [0]

export type DrawTool = 'rectangle' | 'ellipse' | 'arrow' | 'line' | 'text' | 'blur' | 'highlight' | 'counter' | 'magnifier' | 'freehand' | 'marker'

/**
 * The node type a tool makes. One-to-one for every tool but Marker, which makes a `freehand` node
 * with `marker` set -- the two tools are one geometry and one composite operation apart, and a
 * second node type would have duplicated the parse, both renderers, the bounds and the fold.
 */
export function shapeTypeOf(tool: DrawTool): ShapeType {
  return tool === 'marker' ? 'freehand' : tool
}

/** The tools that paint a stroke from the pointer's own path rather than from a drag rectangle. */
export function isStrokeTool(tool: DrawTool): boolean {
  return tool === 'freehand' || tool === 'marker'
}

/**
 * How a canvas gesture reaches the document. The renderer moves Konva nodes; only the editor writes
 * to the scene, and it does it once per gesture — which is what keeps undo one step per drag.
 */
export interface GestureHost {
  /**
   * Called once, before anything has moved, so the editor can snapshot for undo. Returns whether an
   * Alt-drag left copies behind, which the preview must then keep drawing until the next render.
   */
  begin(duplicate: boolean): boolean
  /** The gesture's net effect in scene space. Called once, after everything has settled. */
  commit(delta: Matrix): void
  /**
   * One endpoint of a single straight arrow or line was dragged to a new place.
   *
   * Separate from `commit`, because that describes a gesture as a matrix delta and moving one end of
   * a segment while the other stays put is not a transform of the segment -- as a matrix it would be
   * an anchored scale that also rewrites the rotation, and it would drift. These points are in the
   * node's own local space, ready to store as they are.
   */
  pointsChanged(id: string, points: number[], live?: boolean): void

  /**
   * Where the crop rectangle ended up after a mode gesture.
   *
   * Deliberately not routed through `begin`/`commit`. A crop is not a node — it is an override
   * on `outputRect` rather than a member of the stack — and crop mode commits as a whole on `Enter`,
   * so a drag inside it writes no document and pushes no undo step.
   */
  cropChanged(rect: Rect): void
}

/**
 * A design-language token's computed value, read off the document.
 *
 * Konva paints into a canvas and cannot read a CSS variable, and hard-coding `#E11900` was already
 * wrong in the dark theme, where `--accent` lifts to `#FF4B3A` for contrast. One read per draw is
 * cheaper than a wrong colour.
 */
/**
 * The light theme's `--select`. Only reached if the stylesheet has not applied, but it was still
 * five copies of `#009EFF` after the token was deepened to `#1F6FEB` -- a fallback that names a
 * colour the product no longer uses is worse than no fallback, because it looks maintained.
 */
export const SELECT_FALLBACK = '#1F6FEB'

/** A hover is a maybe, a selection is a fact: the hover outline sits at 60%. */
const HOVER_OPACITY = 0.6

/** Screen pixels between the selection's bottom edge and the size tag under it. */
const TAG_GAP = 8

/** Screen radius of an endpoint handle: 10px across. */
const ENDPOINT_RADIUS = 5

/** Konva name on the endpoint handles, so the stage's gesture listeners can tell them apart. */
const ENDPOINT_NAME = 'endpoint-handle'

/**
 * What the size tag says for a box.
 *
 * One function, called when the tag is built and again on every frame of a gesture, so a resize
 * cannot show a number the release then disagrees with. For one straight two-point segment the
 * axis-aligned box's diagonal is the segment itself whatever its rotation, so a length needs no
 * separate transform walk.
 */
function tagText(box: Rect, straight: boolean): string {
  if (straight) return `${Math.round(Math.hypot(box.width, box.height)).toLocaleString()} px`
  return `${Math.round(box.width).toLocaleString()} \u00d7 ${Math.round(box.height).toLocaleString()}`
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** Breathing room between the composition and the canvas edge, in CSS pixels. */
export const STAGE_PADDING = 40

/** The live Konva interpretation of `flatten()`. Its canvases are viewport-sized, never document-sized. */
/**
 * How the shape under the pointer is drawn while it is being dragged.
 *
 * It used to be a fixed #E11900 at 6px, which is why a drag looked red however the editor defaults
 * were set and then changed colour the instant the button came up. The caller resolves these from
 * the same `nodeFromDrag` + `applyToolDefaults` pair that builds the committed node, so the draft
 * and the release cannot disagree.
 */
export interface DraftStyle {
  stroke: string
  strokeWidth: number
  fill: string | undefined
  opacity: number
}

/** Figma's rotation step. Applied only while Shift is held. */
const ROTATION_SNAPS: number[] = Array.from({ length: 24 }, (_, step) => step * 15)

export class PreviewRenderer {
  readonly stage: Stage
  /**
   * Listening, because the handles need the selected shape itself to be draggable and Konva skips
   * a whole layer that is not listening. Every tile, blur bitmap and unselected shape on it is added
   * `listening: false`, so the hit graph holds only whatever is currently selected.
   */
  readonly compositionLayer = new Layer()
  /**
   * Listening, unlike the composition: the transformer lives here, and its
   * anchors are the only thing in the editor that Konva itself hit-tests. Everything else on this
   * layer -- the hover and selection marks, the guides, the crop -- is added `listening: false`, so
   * the layer costs one hit test per pointer move over a handle and none anywhere else.
   */
  readonly overlayLayer = new Layer()
  readonly interactionLayer = new Layer()

  private readonly composition = new Group()
  /**
   * The export area's marker: a plain element under the transparent Konva canvas wearing
   * the design language's `--shot-shadow`. Neutral, theme-aware, never in an export. It replaced a 1px
   * `--accent` rectangle that read as a theme border.
   */
  private readonly sheet = document.createElement('div')
  /**
   * Hover and selection outlines, and the one thing in this class that is deliberately *not* part of
   * `render()`. Hover must toggle state, never rebuild — rebuilding the canvas
   * on hover destroys the node under the cursor, re-fires `pointerover`, and freezes the tab. So the
   * marks live on their own group under the overlay layer, and `setOutlines` draws that layer alone.
   */
  private readonly marks = new Group({ listening: false })
  /** The alignment guides. Their own group, because they appear and vanish inside one gesture. */
  private readonly guides = new Group({ listening: false })
  /**
   * Crop mode: the scrim, the rule-of-thirds grid and the rectangle itself.
   *
   * Its own group rather than part of the composition, because `render()` rebuilds the composition on
   * every document change and the crop must survive one — the mode outlives any single edit.
   */
  private readonly cropGroup = new Group()
  private readonly interaction = new Group()
  /**
   * The size tag's own group.
   *
   * Not on `marks`, which `beginGesture` hides for the length of a gesture because the marks are
   * drawn from a document that has not been written yet. The tag is the one overlay that has to
   * survive that, since a resize is exactly when its number is worth reading.
   */
  private readonly tagGroup = new Group({ listening: false })
  /** The two endpoint handles of a single selected arrow or line, in place of a box. */
  private readonly endpoints = new Group()
  /**
   * The handles' own state, in a typed list rather than on Konva attrs. `getAttr` would mean a cast
   * at every read, and the point each handle holds is the thing this whole feature is about.
   */
  private endpointState: Array<{ handle: Circle; owner: Group; index: number; local: { x: number; y: number } }> = []
  /**
   * A selected magnifier's lens handles: a see-through body to drag it by and one grip on its right
   * edge to zoom it. Its centre is kept in scene space here and handed back in the
   * node's parent frame (`parent` undoes that).
   */
  private lensState: { id: string; view: KonvaShape; owner: Group; centre: { x: number; y: number; zoom: number }; parent: Matrix; body: KonvaRect; grip: Circle } | undefined
  /** The live size tag, kept so a zoom can re-place it without rebuilding the marks. */
  private sizeTag: Label | undefined
  /** Where that tag hangs from: the selection's bottom centre, in scene units. */
  private sizeTagFoot: { x: number; y: number } | undefined
  /** The tag's text node, rewritten live during a gesture rather than rebuilt. */
  private sizeTagText: Text | undefined
  /** Whether the tag is reading a single straight segment's length rather than a box. */
  private sizeTagStraight = false
  /**
   * The nine selection handles, drawn to the design language. `keepRatio: false` is the load-bearing
   * line: Konva's default is `true`, and its documented meaning is "hold Shift to *unlock* ratio",
   * which is the inverse of every tool the user has in muscle memory and is the specific trap the
   * parked branch fell into. Shift constrains instead, in `boundBoxFunc`.
   */
  private readonly transformer = new Transformer({
    keepRatio: false,
    rotateEnabled: true,
    rotateLineVisible: true,
    ignoreStroke: true,
    // A rectangle drawn `fill: none` is hit-testable on its stroke alone, so without this a drag
    // from the middle of a selected box would sail straight through it. It also makes the interior
    // of a multi-node selection draggable as one thing.
    shouldOverdrawWholeArea: true,
    rotateAnchorOffset: rotateAnchorOffset(1),
    anchorSize: 8,
    anchorCornerRadius: 2,
    anchorStrokeWidth: 1.2,
    padding: 1,
    // Empty by default and filled with `ROTATION_SNAPS` while Shift is held. Konva reads both
    // per rotation move, so `trackModifiers` can swap them mid-gesture. The old unconditional
    // [0, 45, 90, ...] set was the inverse of Figma: it snapped whether or not you wanted it, and
    // Cmd -- the documented escape hatch -- only ever suspended *drag* snapping, never this.
    rotationSnaps: [],
    // Half the step, so Shift quantises every angle rather than snapping near a few of them.
    rotationSnapTolerance: 7.5,
  })
  private readonly visibleTiles = new Map<number, { bitmap: ImageBitmap; node: KonvaImage }>()
  private readonly blurCanvases: OffscreenCanvas[] = []
  private captureGroup: Group | undefined
  private captureOp: Extract<DrawOp, { kind: 'capture' }> | undefined
  private image: TiledImage | undefined
  private tileToken = 0
  private renderToken = 0
  private output: Rect = { x: 0, y: 0, width: 1, height: 1 }
  private scale = 1
  private scrollX = 0
  private scrollY = 0
  private handleIds: readonly string[] = []
  /** The stroke weight of each shape the handles are on, which decides how far out the border sits. */
  private handleStrokes: number[] = []
  private gestureBefore: Map<string, Matrix> | undefined
  private pressed: Map<string, Matrix> | undefined
  private shiftHeld = false
  private altHeld = false
  private snapHeld = false
  /** Off by default, toggled from the zoom menu. */
  private gridSnap = false
  private drag: { candidates: SnapCandidates; bounds: Rect; starts: Map<string, { x: number; y: number }> } | undefined
  private doc: SceneDoc | undefined
  private bandHeight = 0
  /** The draggable crop rectangle while crop mode is on, and the flag that the mode *is* on. */
  private cropNode: KonvaRect | undefined

  constructor(
    private readonly host: HTMLDivElement,
    private readonly space: HTMLElement,
    private readonly gestures: GestureHost,
  ) {
    this.stage = new Stage({ container: host, width: 1, height: 1 })
    // After the stage, because Konva empties its container when it builds its DOM.
    this.sheet.className = 'export-sheet'
    this.sheet.hidden = true
    host.prepend(this.sheet)
    this.compositionLayer.add(this.composition)
    this.overlayLayer.add(this.marks, this.guides, this.cropGroup, this.transformer, this.endpoints, this.tagGroup)
    this.interactionLayer.add(this.interaction)
    this.stage.add(this.compositionLayer, this.overlayLayer, this.interactionLayer)
    this.wireHandles()
    this.resize()
  }

  /**
   * The handles' own wiring: what a gesture is, and what Shift and Alt do while one is running.
   *
   * Node drag events bubble to the stage, so one pair of listeners there covers a drag of any node —
   * including Konva's own proxy drag, which moves every attached node when one of them is dragged.
   * Both ends are idempotent: the proxy fires `dragstart` and `dragend` once per node, and the
   * gesture is one thing.
   */
  private wireHandles(): void {
    // Where the nodes were when the press began. A press inside the selection lands on the
    // transformer's `back`, and Konva's proxy has already moved the node by the time any `dragstart`
    // fires, so a snapshot taken there missed that first step and the shape fell back on release.
    this.stage.on('pointerdown', () => {
      this.pressed = new Map(this.transformer.nodes().map((node) => [node.id(), matrixOfNode(node)] as const))
    })
    // An endpoint handle runs its own gesture and commits points, not a matrix delta. Without this
    // guard its drag would also snapshot for undo here and then commit a near-identity transform,
    // costing an extra undo step for every endpoint nudge.
    this.stage.on('dragstart', (event) => {
      if (event.target.hasName(ENDPOINT_NAME)) return
      this.beginGesture(event.evt.altKey)
    })
    this.stage.on('dragend', (event) => {
      if (event.target.hasName(ENDPOINT_NAME)) return
      this.endGesture()
    })
    this.transformer.on('transformstart', () => this.beginGesture(false))
    this.transformer.on('transform', () => {
      this.followScale()
      // A resized source resizes its lens, so the lens handles follow the gesture.
      this.placeLens()
      this.followSizeTag()
    })
    this.transformer.on('transformend', () => this.endGesture())
    // A move changes where the tag hangs but not what it says; a resize changes both. One handler,
    // because the document is not written until the gesture ends -- `setOutlines` cannot see either.
    //
    // The endpoint handles ride along for the same reason: they are separate overlay nodes, so
    // nothing moves them when the shape under them moves, and they sat at the old place until the
    // drop re-derived them. The dragged handle is exempt -- `dragEndpoint`
    // already owns it, and re-deriving it from a local point it has just written back would fight
    // the pointer.
    this.stage.on('dragmove', (event) => {
      if (!event.target.hasName(ENDPOINT_NAME)) this.placeEndpoints()
      this.followSizeTag()
    })
    this.transformer.on('transformend dragend', () => this.placeEndpoints())
    // Read the modifiers off the pointer itself rather than tracking keydown: Konva runs a transform
    // off its own window listeners, and a key pressed while the window is not focused is missed.
    window.addEventListener('pointermove', this.trackModifiers, { capture: true })
    window.addEventListener('pointerdown', this.trackModifiers, { capture: true })
    window.addEventListener('pointerup', this.trackModifiers, { capture: true })

    this.transformer.anchorStyleFunc((anchor) => {
      // White squares with a selection-blue rim in both themes.
      anchor.fill('#FFFFFF')
      anchor.stroke(cssToken('--select', SELECT_FALLBACK))
      anchor.cornerRadius(anchor.name().includes('rotater') ? 4 : 2)
      // Konva sets each anchor's `visible` just before this runs, so this can only ever hide one.
      if (anchor.hasName('middle-left') || anchor.hasName('middle-right')) {
        // The anchors sit on the *padded* box, so that is the height they have to fit in: a flat
        // marker stroke is a few units tall between its points and a whole stroke width on screen.
        const padded = this.transformer.height() + 2 * this.transformer.padding()
        if (!sideAnchorsFit(padded, this.transformer.anchorSize())) anchor.visible(false)
      }
    })
    /**
     * Shift constrains, and this is where the inversion is corrected. `keepRatio: false` above means
     * Konva no longer holds the ratio on its own, so it is held here — and text always holds it on a
     * corner, because the four corners scale the font proportionally while the two side
     * anchors reflow the wrap width.
     */
    this.transformer.boundBoxFunc((oldBox, newBox) =>
      this.shouldKeepRatio() ? ratioLockedBox(oldBox, newBox, this.fixedPoint()) : newBox,
    )
  }

  private readonly trackModifiers = (event: PointerEvent): void => {
    if (this.shiftHeld !== event.shiftKey) {
      this.shiftHeld = event.shiftKey
      // Shift steps rotation in 15s, and nothing snaps it without Shift.
      this.transformer.rotationSnaps(this.shiftHeld ? ROTATION_SNAPS : [])
    }
    // Holding Cmd/Ctrl suspends snapping entirely. A snap you cannot turn off is a bug.
    this.snapHeld = event.metaKey || event.ctrlKey
    if (this.altHeld === event.altKey) return
    this.altHeld = event.altKey
    // Alt resizes from the centre. Konva reads this per move, so flipping it mid-gesture works.
    this.transformer.centeredScaling(this.altHeld)
  }

  /**
   * The modifiers a draw gesture should obey, read from the same tracker the transformer uses.
   *
   * The editor needs them on pointer*up*, where Konva hands it no event, and a second tracker
   * listening on keydown would miss a key pressed while the window was not focused -- the reason
   * this one reads pointer events in the first place.
   */
  drawModifiers(): DrawModifiers {
    return { shift: this.shiftHeld, alt: this.altHeld }
  }

  /** True when the active anchor must hold the ratio: Shift always, and a text or emoji corner always. */
  /**
   * The point a ratio-locked resize holds still, in the box's own fractions: the corner opposite the
   * dragged one, or the centre while Alt scales from it.
   */
  private fixedPoint(): { u: number; v: number } {
    if (this.transformer.centeredScaling()) return { u: 0.5, v: 0.5 }
    const anchor = this.transformer.getActiveAnchor() ?? ''
    return { u: anchor.includes('left') ? 1 : 0, v: anchor.includes('top') ? 1 : 0 }
  }

  private shouldKeepRatio(): boolean {
    if (this.shiftHeld) return true
    const anchor = this.transformer.getActiveAnchor()
    if (anchor === null || !anchor.includes('-')) return false
    const corner = !anchor.includes('center') && !anchor.includes('middle')
    return corner && cornersHoldRatio(this.transformer.nodes().map((node) => node.getAttr('sceneType')))
  }

  /**
   * A drag's snapping state, gathered once at the start of the gesture.
   *
   * Once, rather than per move: the candidate lines are every other shape's, and recomputing them
   * on every pointer move would walk the whole tree sixty times a second to get the same answer.
   */
  private beginDrag(): void {
    const doc = this.doc
    const nodes = this.transformer.nodes()
    const bounds = doc ? selectionBounds(doc, this.handleIds) : undefined
    if (!doc || !bounds || nodes.length === 0) {
      this.drag = undefined
      return
    }
    this.drag = {
      candidates: snapCandidates(doc, this.bandHeight, new Set(nodes.map((node) => node.id()))),
      bounds,
      starts: new Map(
        nodes.map((node) => {
          const pressed = this.pressed?.get(node.id())
          return [node.id(), pressed ? { x: pressed[4], y: pressed[5] } : { x: node.x(), y: node.y() }] as const
        }),
      ),
    }
  }

  /**
   * Where a dragged node is allowed to land: alignment snapping, in scene space.
   *
   * The threshold is **5 CSS pixels converted to scene units at the current zoom**, which is the
   * one thing that matters most — a scene-unit threshold would feel sticky at 25% and be
   * unreachable at 400%.
   *
   * Every attached node computes the same offset from its own start, because Konva's proxy drag
   * moves them all by one delta; so the followers agree with the node under the pointer rather than
   * each snapping to something different.
   */
  private readonly boundDrag = (node: Group, position: { x: number; y: number }): { x: number; y: number } => {
    const drag = this.drag
    const start = drag?.starts.get(node.id())
    if (!drag || !start) return position
    const camera = this.camera()
    const wanted = { x: (position.x - camera.x) / this.scale, y: (position.y - camera.y) / this.scale }
    const delta = { x: wanted.x - start.x, y: wanted.y - start.y }
    if (this.snapHeld) {
      this.setGuides([])
      return position
    }
    const moved: Rect = { ...drag.bounds, x: drag.bounds.x + delta.x, y: drag.bounds.y + delta.y }
    const snap = snapDelta(moved, drag.candidates, SNAP_THRESHOLD_CSS / this.scale, this.gridSnap ? SNAP_GRID : 0)
    this.setGuides(snap.guides, moved)
    return {
      x: camera.x + (start.x + delta.x + snap.dx) * this.scale,
      y: camera.y + (start.y + delta.y + snap.dy) * this.scale,
    }
  }

  /** A 1px `--accent` line with a 5px tick at each end, spanning the two shapes it relates. */
  private setGuides(guides: readonly SnapGuide[], moved?: Rect): void {
    this.guides.destroyChildren()
    if (guides.length > 0 && moved) {
      const accent = cssToken('--accent', '#E11900')
      const width = 1 / this.scale
      const tick = 5 / this.scale
      for (const guide of guides) {
        const from = guide.from
        const points =
          guide.axis === 'x'
            ? [guide.at, Math.min(moved.y, from.y), guide.at, Math.max(moved.y + moved.height, from.y + from.height)]
            : [Math.min(moved.x, from.x), guide.at, Math.max(moved.x + moved.width, from.x + from.width), guide.at]
        this.guides.add(new Line({ points, stroke: accent, strokeWidth: width, listening: false }))
        for (const end of [0, 2]) {
          const x = points[end] ?? 0
          const y = points[end + 1] ?? 0
          const ends = guide.axis === 'x' ? [x - tick, y, x + tick, y] : [x, y - tick, x, y + tick]
          this.guides.add(new Line({ points: ends, stroke: accent, strokeWidth: width, listening: false }))
        }
      }
    }
    this.overlayLayer.draw()
  }

  /** The grid is off by default and the zoom menu turns it on. */
  setGridSnap(on: boolean): void {
    this.gridSnap = on
  }

  gridSnapOn(): boolean {
    return this.gridSnap
  }

  private beginGesture(duplicate: boolean): void {
    // In crop mode the transformer holds the crop rectangle, which commits through `cropChanged`
    // rather than as a node delta. Without this the crop's own drag would snapshot the document for
    // undo and then try to move whatever happened to be selected underneath it.
    if (this.cropNode) return
    if (this.gestureBefore) return
    // The marks are drawn from the document, which does not change until the gesture commits; the
    // transformer's border follows the live node instead. Hidden until `setOutlines` redraws them.
    this.marks.visible(false)
    this.overlayLayer.draw()
    this.beginDrag()
    this.gestureBefore = new Map(
      this.transformer.nodes().map((node) => [node.id(), this.pressed?.get(node.id()) ?? matrixOfNode(node)] as const),
    )
    if (this.gestures.begin(duplicate)) this.leaveCopies()
  }

  /**
   * An Alt-drag's copies are already in the document, under the originals, but nothing draws them
   * until the gesture commits — so the dragged original seemed to leave an empty spot behind. A static
   * clone of each dragged node stands in for its copy until the next render replaces the whole stage.
   */
  private leaveCopies(): void {
    for (const node of this.transformer.nodes()) {
      const copy = node.clone({ id: '', listening: false, draggable: false })
      // Konva's proxy has already moved the node one step by `dragstart`; the copy belongs where the
      // press began, which is the gesture's own snapshot.
      const start = this.gestureBefore?.get(node.id())
      if (start) copy.setAttrs(decompose(start))
      node.getParent()?.add(copy)
      copy.zIndex(node.zIndex())
    }
    this.compositionLayer.draw()
  }

  /**
   * Keeps every resized leaf's stroke at its own weight while the handles move, as Figma does.
   *
   * The group keeps the scale Konva gave it, because the transformer and `endGesture` both read it.
   * Its child is rebuilt at the geometry the commit will fold to and drawn under the inverse
   * magnitude, so the picture matches the committed shape at every step rather than only on release.
   */
  private followScale(): void {
    const doc = this.doc
    const before = this.gestureBefore
    if (!doc || !before || this.cropNode) return
    for (const group of this.transformer.nodes()) {
      const source = findNode(doc.nodes, group.id())
      const start = before.get(group.id())
      // A magnifier draws itself from the group's live transform, and a rebuild would drop its pixels.
      if (!source || !start || !isShapeNode(source) || source.type === 'blur' || source.type === 'magnifier' || !(group instanceof Group)) continue
      const origin = decompose(start)
      const scaleX = group.scaleX() / origin.scaleX
      const scaleY = group.scaleY() / origin.scaleY
      const folded = liveFold(source, scaleX, scaleY)
      // Every child, not only the first: a filled text is its box *and* its letters, and keeping just
      // child 0 hid the text for the length of the resize.
      const children = shapeNode({ node: folded, matrix: IDENTITY_MATRIX, opacity: 1 } as ResolvedShape).getChildren().slice()
      if (children.length === 0) continue
      group.destroyChildren()
      for (const child of children) {
        child.setAttrs(inverseScale(child.x(), child.y(), scaleX, scaleY))
        group.add(child)
      }
    }
  }

  private endGesture(): void {
    if (this.cropNode) return
    const before = this.gestureBefore
    this.gestureBefore = undefined
    this.pressed = undefined
    this.drag = undefined
    this.setGuides([])
    if (!before) return
    for (const node of this.transformer.nodes()) {
      const start = before.get(node.id())
      const delta = start ? gestureDelta(start, matrixOfNode(node)) : undefined
      // One delta describes the whole gesture: Konva computes it once and applies it to every
      // attached node, so reading it off the first node is exact for a multi-node gesture too — and
      // it is what lets a group move by writing one transform instead of rewriting its children.
      if (delta) {
        this.gestures.commit(delta)
        return
      }
    }
  }

  /**
   * Arms a drag on a node this press only just selected, so an unselected shape can be dragged in one
   * gesture. Konva arms a drag from the node's own mousedown listener, which never
   * ran: the node was not listening when the press landed. Armed rather than started, so a press that
   * does not move past Konva's drag distance stays a click, and a double-click still reaches text edit.
   *
   * **No pointer id.** Konva runs the drag off window `mousemove`/`mouseup`, whose events carry no
   * `pointerId`, so it tracks them as 999; the `pointerdown` that selected the node carries the mouse's
   * real id. Arming with that id made the drag follow only the moves a pointer event happened to share
   * (the shape stalled after a few pixels), and a release could not end it, so a stale drag later moved
   * shapes under an unrelated multi-selection drag. Armed without one,
   * Konva takes the id from the first move, as its own mousedown path does.
   */
  armDrag(id: string): void {
    const node = this.transformer.nodes().find((candidate) => candidate.id() === id)
    if (!node) return
    this.pressed = new Map(this.transformer.nodes().map((candidate) => [candidate.id(), matrixOfNode(candidate)] as const))
    // ponytail: Konva's private drag arming (what its mousedown listener calls); re-check on a Konva upgrade.
    ;(node as unknown as { _createDragElement(evt?: unknown): void })._createDragElement()
  }

  /** Whether a pressed Konva node is one of the transformer's resize or rotate anchors. */
  isHandle(target: Node): boolean {
    // The endpoint and lens handles too: half of a grip hangs off the shape it sizes, and a press on
    // that half must not start a marquee under the drag.
    return (target.getParent() === this.transformer && target.hasName('_anchor')) || target.hasName(ENDPOINT_NAME)
  }

  /**
   * Puts the handles on the selection, or takes them away.
   *
   * A selected group has no Konva node of its own — `flatten` resolves groups away before either
   * renderer sees the scene — so what the handles attach to is the group's leaves. The write-back
   * still lands on the group, because `endGesture` reads one delta rather than N transforms.
   */
  setHandles(doc: SceneDoc | undefined, ids: readonly string[]): void {
    this.handleIds = ids
    // The crop owns the handles while its mode is on. Remembering the ids above rather than
    // returning before them is what lets `setCrop(undefined)` hand them straight back.
    if (this.cropNode) return
    for (const child of this.composition.getChildren()) {
      child.listening(false)
      child.draggable(false)
    }
    const leaves = doc ? handleTargets(doc, ids) : []
    const nodes = leaves
      .map((leaf) => this.composition.findOne<Group>(`#${leaf.node.id}`))
      .filter((node): node is Group => node !== undefined)
    for (const node of nodes) {
      node.listening(true)
      node.draggable(true)
      node.dragBoundFunc((position) => this.boundDrag(node, position))
    }
    const types = leaves.map((leaf) => leaf.node.type)
    const straight = isStraightSelection(types)
    this.transformer.enabledAnchors(anchorsFor(types))
    this.transformer.nodes(nodes)
    // No box and no rotation handle around a single segment: it is two points, and both are
    // draggable. The border goes by *width* below, never by `borderEnabled` -- see why there.
    this.transformer.rotateEnabled(!straight)
    this.endpoints.destroyChildren()
    this.endpointState = []
    this.lensState = undefined
    // A magnifier's source is a box on the page and its lens stays level with it: no rotation.
    if (types.includes('magnifier')) this.transformer.rotateEnabled(false)
    const magnifier = leaves.length === 1 && leaves[0]?.node.type === 'magnifier' ? leaves[0] : undefined
    if (magnifier && nodes[0]) this.buildLens(magnifier as { node: MagnifierNode; matrix: Matrix }, nodes[0])
    const segment = straight ? leaves[0]?.node : undefined
    // An arrow's third handle is its bend, on the curve halfway.
    if (segment?.type === 'arrow' && nodes[0]) {
      const middle = arrowMiddle(segment)
      this.buildEndpoints(segment.id, [...segment.points, middle.x, middle.y], nodes[0])
    } else if (segment && nodes[0] && 'points' in segment) this.buildEndpoints(segment.id, segment.points, nodes[0])
    // A counter keeps its four corner anchors *and* gets a tip handle -- it is the one shape that
    // wants both, which is why this is a second branch rather than a widening of `straight`.
    const pinned = leaves.length === 1 ? leaves[0]?.node : undefined
    // A filled text's pointer is the same kind of handle; its box is child 0, as the pin.
    const pointed = pinned?.type === 'counter' || (pinned?.type === 'text' && pinned.fill !== undefined)
    if (pinned && pointed && 'tip' in pinned && pinned.tip && nodes[0]) {
      this.buildEndpoints(pinned.id, [pinned.tip.x, pinned.tip.y], nodes[0])
    }
    // The transformer's border is the one selection outline for anything with handles: it follows a
    // gesture live, and it sits outside the widest selected stroke.
    this.handleStrokes = leaves.map((leaf) => (hasStroke(leaf.node) && 'strokeWidth' in leaf.node ? leaf.node.strokeWidth : 0))
    this.transformer.borderStroke(cssToken('--select', SELECT_FALLBACK))
    /*
     * Width 0 for a single segment, not `borderEnabled(false)`.
     *
     * Konva's transformer builds a `back` shape, and that shape is what `shouldOverdrawWholeArea`
     * uses to make the whole selected area draggable rather than only the shape's own stroke. Konva
     * sets `visible: this.borderEnabled()` on it, and an invisible Konva node is not hit-testable --
     * so `borderEnabled(false)` did not merely hide the rectangle around an arrow, it took away the
     * only way to pick the arrow up and move it. Width 0 draws nothing and keeps the node alive.
     */
    this.transformer.borderStrokeWidth(straight ? 0 : 1)
    // A segment is picked up by its own drawn shape, not its box: the box of a diagonal or bent
    // arrow is mostly empty page, and a press there has to fall through.
    this.transformer.shouldOverdrawWholeArea(!straight)
    this.padHandles(selectionPadding(this.handleStrokes, this.scale))
    this.transformer.forceUpdate()
    this.compositionLayer.draw()
    this.overlayLayer.draw()
  }


  /**
   * Crop mode, on and off. `undefined` leaves the mode and hands the handles back.
   *
   * **The eight handles are the selection's own.** One `Konva.Transformer` takes the crop
   * rectangle instead of the composition's nodes, with rotation off — a rotated crop has no meaning
   * against `outputRect`, which is axis-aligned by definition. Growing a second handle set here is
   * exactly what reusing them avoids, and it would have re-inherited every bug the selection
   * handles had already shed.
   */
  setCrop(rect: Rect | undefined): void {
    this.cropGroup.destroyChildren()
    this.cropNode = undefined
    this.transformer.rotateEnabled(rect === undefined)
    this.transformer.shouldOverdrawWholeArea(true)
    if (!rect) {
      // The mode is over, so the shape handles come back to whatever is selected.
      this.setHandles(this.doc, this.handleIds)
      this.overlayLayer.draw()
      return
    }
    // Nothing in the composition is draggable while the crop is: a stray drag on a shape underneath
    // the scrim would move an annotation the user cannot currently see.
    this.transformer.nodes([])
    for (const child of this.composition.getChildren()) {
      child.listening(false)
      child.draggable(false)
    }

    const accent = cssToken('--accent', '#E11900')
    // A fully transparent fill is still a fill, so Konva gives the rectangle its whole area in the
    // hit graph and the crop can be dragged from the middle rather than only by its handles.
    const node = new KonvaRect({ ...rect, fill: 'rgba(0,0,0,0)', draggable: true, name: 'crop' })
    this.cropNode = node

    this.cropGroup.add(
      new KonvaShape({
        // The 55% scrim. Opacity on the node rather than an alpha baked into the colour, because
        // `--stage` is a theme token and reading a hex out of it to re-assemble an rgba would be the
        // hard-coded-colour bug `--accent` already had in three places.
        opacity: 0.55,
        fill: cssToken('--stage', '#F1F1F1'),
        listening: false,
        sceneFunc: (context, shape) => {
          const box = this.cropBox()
          const output = this.output
          context.beginPath()
          context.rect(output.x, output.y, output.width, output.height)
          if (box) {
            // Wound the other way round, so the non-zero fill rule punches the crop out of the scrim
            // rather than four rectangles being kept in step with the rectangle they surround.
            context.moveTo(box.x, box.y)
            context.lineTo(box.x, box.y + box.height)
            context.lineTo(box.x + box.width, box.y + box.height)
            context.lineTo(box.x + box.width, box.y)
            context.closePath()
          }
          context.fillStrokeShape(shape)
        },
      }),
      new KonvaShape({
        // The rule-of-thirds grid. The rectangle's own border is the transformer's, so this draws
        // only the four interior lines and is deliberately fainter than they are.
        stroke: accent,
        opacity: 0.5,
        listening: false,
        sceneFunc: (context, shape) => {
          const box = this.cropBox()
          if (!box) return
          shape.strokeWidth(1 / this.scale)
          context.beginPath()
          for (const third of [1, 2]) {
            const x = box.x + (box.width * third) / 3
            context.moveTo(x, box.y)
            context.lineTo(x, box.y + box.height)
            const y = box.y + (box.height * third) / 3
            context.moveTo(box.x, y)
            context.lineTo(box.x + box.width, y)
          }
          context.fillStrokeShape(shape)
        },
      }),
      node,
    )

    // The scrim and the grid read the rectangle live, so following a gesture is one redraw and no
    // state to keep in step.
    node.on('dragmove transform', () => this.overlayLayer.draw())
    node.on('dragend transformend', () => {
      const box = normalizeCrop({
        x: node.x(),
        y: node.y(),
        width: node.width() * node.scaleX(),
        height: node.height() * node.scaleY(),
      })
      // Folded the way a leaf's resize is, and for the same reason: the rectangle is its size,
      // not a magnified version of an older one.
      node.setAttrs({ ...box, scaleX: 1, scaleY: 1 })
      this.gestures.cropChanged(box)
      this.overlayLayer.draw()
    })

    this.transformer.enabledAnchors([...BOX_ANCHORS])
    this.transformer.nodes([node])
    this.transformer.borderStroke(cssToken('--select', SELECT_FALLBACK))
    this.transformer.borderStrokeWidth(1)
    this.padHandles(selectionPadding([], this.scale))
    this.transformer.forceUpdate()
    this.compositionLayer.draw()
    this.overlayLayer.draw()
  }

  /** Pads the handles off the stroke, and keeps the rotate handle outside the padding. */
  private padHandles(padding: number): void {
    this.transformer.padding(padding)
    this.transformer.rotateAnchorOffset(rotateAnchorOffset(padding))
  }

  /** The crop rectangle as it stands mid-gesture, scale included. */
  private cropBox(): Rect | undefined {
    const node = this.cropNode
    if (!node) return undefined
    return normalizeCrop({
      x: node.x(),
      y: node.y(),
      width: node.width() * node.scaleX(),
      height: node.height() * node.scaleY(),
    })
  }

  resize(): void {
    this.stage.size({ width: Math.max(1, this.host.clientWidth), height: Math.max(1, this.host.clientHeight) })
    this.syncCamera()
  }

  setViewport(scale: number, scrollX: number, scrollY: number): void {
    this.scale = scale
    this.placeSizeTag()
    this.placeEndpoints()
    this.scrollX = scrollX
    this.scrollY = scrollY
    this.space.style.width = `${Math.ceil(this.output.width * scale + STAGE_PADDING * 2)}px`
    this.space.style.height = `${Math.ceil(this.output.height * scale + STAGE_PADDING * 2)}px`
    this.syncCamera()
    void this.syncVisibleTiles()
  }

  scenePoint(): { x: number; y: number } | null {
    const point = this.stage.getPointerPosition()
    if (!point) return null
    return this.sceneAt(point.x, point.y)
  }

  /** Where a scene point lands on the stage, in CSS pixels — what the text overlay is positioned by. */
  stageAt(x: number, y: number): { x: number; y: number } {
    const camera = this.camera()
    return { x: camera.x + x * this.scale, y: camera.y + y * this.scale }
  }

  /** The current preview scale, so a DOM overlay can match the composition's type size. */
  viewScale(): number {
    return this.scale
  }

  /**
   * Hides one composition node without touching the document.
   *
   * A hidden *node* would be the wrong tool: `hidden` is a document property, so it would drop the
   * node out of `shapesRect` and resize the output while the user was typing. This is a Konva
   * visibility toggle, and it survives until the next render, which is exactly the life of one edit.
   */
  /**
   * Rebuilds one node's drawing from the document, re-measured, and moves the handles to it -- for a
   * text being typed into, whose box grows and shrinks between full renders. The node stays however
   * `concealNode` left it.
   */
  refreshNode(doc: SceneDoc, id: string): void {
    const node = findNode(doc.nodes, id)
    if (!node || !isShapeNode(node)) return
    measureTextNodes([node])
    const shape = resolveShapes(doc).find((candidate) => candidate.node.id === id)
    const group = this.composition.findOne<Group>(`#${id}`)
    if (!shape || !group) return
    const fresh = shapeNode(shape)
    group.destroyChildren()
    for (const child of fresh.getChildren().slice()) group.add(child)
    fresh.destroy()
    this.transformer.forceUpdate()
    this.placeEndpoints()
    this.overlayLayer.draw()
  }

  concealNode(id: string | undefined): void {
    for (const child of this.composition.getChildren()) child.visible(true)
    if (id !== undefined) this.composition.findOne(`#${id}`)?.visible(false)
    this.compositionLayer.draw()
  }

  /** The scene point under a position given in stage pixels. Zooming keeps one of these fixed. */
  sceneAt(stageX: number, stageY: number): { x: number; y: number } {
    const camera = this.camera()
    return { x: (stageX - camera.x) / this.scale, y: (stageY - camera.y) / this.scale }
  }

  async render(
    doc: SceneDoc,
    image: TiledImage,
    bandHeight: number,
    details: SceneRenderDetails,
  ): Promise<void> {
    const token = ++this.renderToken
    measureTextNodes(doc.nodes)
    const output = renderRect(doc, bandHeight)
    const ops = flatten(doc, bandHeight)
    // The new composition is built off-stage and swapped in only after the last await. Destroying the
    // live nodes first let the browser paint an empty or half-built stage between awaits -- the flash
    // after every drop -- and committing `output` early redrew the old nodes under a new camera.
    const built: Array<Group | KonvaRect> = []
    const canvases: OffscreenCanvas[] = []
    let captureGroup: Group | undefined
    let captureOp: Extract<DrawOp, { kind: 'capture' }> | undefined
    // A slower render finishing late must not paint over the fresh one: every await in the loop can
    // interleave with a newer call, so the token is checked before each mutation that follows one.
    const fresh = (): boolean => {
      if (token === this.renderToken) return true
      for (const canvas of canvases) {
        canvas.width = 0
        canvas.height = 0
      }
      return false
    }

    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index]
      if (!op) continue
      switch (op.kind) {
        case 'backdrop':
          built.push(backdropNode(op))
          break
        case 'chrome': {
          const radius = op.present.corners * op.unit
          built.push(
            new KonvaRect({
              x: op.rect.x,
              y: op.rect.y,
              width: op.rect.width,
              height: op.rect.height,
              fill: '#FFFFFF',
              cornerRadius: radius,
              shadowColor: '#1A1A1A',
              shadowOpacity: op.present.shadow ? 0.28 : 0,
              shadowBlur: 28 * op.unit,
              shadowOffsetY: 14 * op.unit,
              listening: false,
            }),
          )
          const pieces = await loadChromePieces(
            op.present.frame,
            chromeDensityFor(op.unit),
            op.present.chrome === 'dark',
          )
          if (!fresh()) return
          const band = renderChromeBand(op.rect.width, op.present, details.address, details.stamp, op.unit, pieces)
          canvases.push(band)
          // The band clips to the card's corners like the capture beneath it; the card and its
          // shadow above stay unclipped, matching `composePresented`'s order.
          const bandGroup = op.clip
            ? new Group({ clipFunc: (context) => roundedRectPath(context, op.clip!.rect, op.clip!.radius) })
            : new Group()
          bandGroup.add(
            new KonvaImage({ x: op.rect.x, y: op.rect.y, width: op.rect.width, height: band.height, image: band, listening: false }),
          )
          bandGroup.listening(false)
          built.push(bandGroup)
          break
        }
        case 'capture': {
          captureGroup = op.clip
            ? new Group({ clipFunc: (context) => roundedRectPath(context, op.clip!.rect, op.clip!.radius) })
            : new Group()
          captureOp = op
          built.push(captureGroup)
          break
        }
        case 'shape': {
          const node = op.shape.node
          if (node.type === 'image') {
            await decodeImage(node.src)
            if (!fresh()) return
          }
          if (node.type !== 'magnifier') {
            built.push(shapeNode(op.shape))
            break
          }
          // The lens shows the capture under the source, painted for that rectangle as the export does.
          const { source } = magnifierWorld({ node, matrix: op.shape.matrix })
          const pixels =
            source.width >= 1 && source.height >= 1
              ? await renderSceneWindow(doc, image, bandHeight, details, { rect: source, ops: ops.filter((candidate) => candidate.kind === 'capture') })
              : undefined
          if (pixels) canvases.push(pixels)
          if (!fresh()) return
          built.push(shapeNode(op.shape, pixels && { canvas: pixels, rect: source }, this.paintTiles))
          break
        }
        case 'blur': {
          // The handle proxy first, and before the window check, so a blur cropped out of view is
          // still selectable. Without it a selected blur had no handles and no outline.
          built.push(shapeNode(op.shape))
          // `blurWindow` is the region grown by the kernel's own support and clipped to the output,
          // and it is `undefined` when a committed crop leaves the blur no output pixel at all —
          // the case that used to arrive here as a negative-size window and threw the render.
          const window = blurWindow(op.region, output, op.radius * BLUR_SUPPORT)
          if (!window) break
          const canvas = await renderSceneWindow(doc, image, bandHeight, details, {
            rect: window,
            ops: ops.slice(0, index + 1),
          })
          canvases.push(canvas)
          if (!fresh()) return
          const quad = shapeQuad(op.shape)
          const clipped = new Group({
            opacity: op.shape.opacity,
            clipFunc: (context) => {
              const first = quad[0]
              if (!first) return
              context.beginPath()
              context.moveTo(first.x, first.y)
              for (const point of quad.slice(1)) context.lineTo(point.x, point.y)
              context.closePath()
            },
          })
          clipped.add(
            new KonvaImage({
              x: window.x,
              y: window.y,
              width: window.width,
              height: window.height,
              image: canvas,
              listening: false,
            }),
          )
          built.push(clipped)
          break
        }
      }
    }
    if (!fresh()) return

    // The swap: synchronous from here to the end of the tile re-attach, so no paint sees it half done.
    // The same capture keeps its decoded tiles; only a different image re-decodes.
    const sameImage = image === this.image
    this.tileToken += 1
    const tiles = [...this.visibleTiles.entries()]
    if (sameImage) for (const [, source] of tiles) source.node.remove()
    else this.releaseSources()
    for (const canvas of this.blurCanvases.splice(0, this.blurCanvases.length, ...canvases)) {
      canvas.width = 0
      canvas.height = 0
    }
    this.doc = doc
    this.bandHeight = bandHeight
    this.output = output
    this.image = image
    this.captureGroup = captureGroup
    this.captureOp = captureOp
    this.composition.clipFunc(
      doc.crop
        ? (context) => {
            context.rect(this.output.x, this.output.y, this.output.width, this.output.height)
          }
        : undefined,
    )
    this.composition.destroyChildren()
    this.composition.add(...built)
    if (sameImage && captureGroup && captureOp) {
      for (const [index, source] of tiles) {
        const tile = image.tiles[index]
        if (!tile) continue
        source.node.position({ x: captureOp.rect.x, y: captureOp.rect.y + tile.offsetY })
        captureGroup.add(source.node)
      }
    } else if (sameImage) {
      for (const [, source] of tiles) {
        source.node.destroy()
        source.bitmap.close()
      }
      this.visibleTiles.clear()
    }
    this.setViewport(this.scale, this.scrollX, this.scrollY)
    await this.syncVisibleTiles()
    if (token !== this.renderToken) return
    // Every composition node was just destroyed and rebuilt, so the handles are pointing at
    // nothing until they are re-attached to the new ones.
    this.setHandles(doc, this.handleIds)
    this.drawNow()
  }

  /**
   * The live pen or marker stroke: the raw pointer path, drawn exactly as sampled.
   *
   * Unsmoothed on purpose -- the line has to sit under the pointer while it is being drawn, and
   * smoothing here would make it squirm behind the hand as earlier points were re-averaged. The
   * resample and smooth happen once, when the stroke is committed.
   */
  showStroke(points: readonly number[], style: DraftStyle, marker: boolean): void {
    this.interaction.destroyChildren()
    this.interaction.add(
      new Line({
        points: [...points],
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        lineCap: 'round',
        lineJoin: 'round',
        opacity: style.opacity,
        listening: false,
        ...(marker ? { globalCompositeOperation: 'multiply' as const } : {}),
      }),
    )
    this.interactionLayer.draw()
  }

  showDraft(
    tool: DrawTool,
    start: { x: number; y: number },
    end: { x: number; y: number },
    style: DraftStyle,
  ): void {
    this.interaction.destroyChildren()
    const left = Math.min(start.x, end.x)
    const top = Math.min(start.y, end.y)
    const width = Math.max(1, Math.abs(end.x - start.x))
    const height = Math.max(1, Math.abs(end.y - start.y))
    let node: Shape
    if (tool === 'counter') {
      // A badge is a circle sized by the drag's longer side, which is what `nodeFromDrag` commits.
      // Filled and unstroked like a highlight: the disc's colour is the whole of its appearance.
      const diameter = Math.max(width, height)
      node = new Ellipse({ x: left + diameter / 2, y: top + diameter / 2, radiusX: diameter / 2, radiusY: diameter / 2, fill: style.fill })
    } else if (tool === 'ellipse') {
      node = new Ellipse({ x: left + width / 2, y: top + height / 2, radiusX: width / 2, radiusY: height / 2 })
    } else if (tool === 'arrow') {
      node = arrowShape({ points: [start.x, start.y, end.x, end.y], style: 'solid', size: 100, stroke: style.stroke, strokeWidth: style.strokeWidth, headSize: style.strokeWidth * 3 })
    } else if (tool === 'line') {
      node = new Line({ points: [start.x, start.y, end.x, end.y] })
    } else {
      node = new KonvaRect({ x: left, y: top, width, height, fill: style.fill })
    }
    node.setAttrs({
      stroke: style.stroke,
      strokeWidth: tool === 'highlight' || tool === 'counter' ? 0 : style.strokeWidth,
      opacity: style.opacity,
      listening: false,
    })
    this.interaction.add(node)
    this.interactionLayer.draw()
  }

  /**
   * The selection and hover outlines. Class-toggle-equivalent work: it touches the marks group and
   * redraws the overlay layer, and the composition is never rebuilt, so this is safe to call from a
   * `pointerover` handler at whatever rate the pointer moves.
   */
  setOutlines(doc: SceneDoc, selected: readonly string[], hovered?: string): void {
    this.marks.destroyChildren()
    this.marks.visible(true)
    const shapes = resolveShapes(doc)
    const line = 1 / this.scale
    const select = cssToken('--select', SELECT_FALLBACK)
    // Anything with handles is outlined by the transformer's border, which follows a gesture live;
    // drawing a mark under it as well was the double outline. So marks are for hover,
    // for locked shapes, and for a selection while a draw tool has taken the handles away.
    // Asked of the transformer, not the scene: a shape whose handles did not attach still gets its
    // outline, which is how a selected blur ended up showing nothing at all.
    const handled = new Set(this.transformer.nodes().map((node) => node.id()))
    const hasHandles = (id: string): boolean => selectionLeaves(doc, [id]).some((leaf) => handled.has(leaf.node.id))
    // One solid 1px line outside the stroke — hover included, which used to be dashed.
    // `opacity` separates the two weights: a hover is a maybe and a selection is a fact, and at the
    // same strength the pointer moving across a crowded capture read as things being selected.
    const draw = (id: string, opacity = 1): void => {
      const shape = shapes.find((candidate) => candidate.node.id === id)
      if (shape) {
        const node = shape.node
        if (!('width' in node) || !('height' in node)) return
        const stroke = hasStroke(node) && 'strokeWidth' in node ? node.strokeWidth / 2 : 0
        const quad = expandedQuad(shape.matrix, node.width, node.height, stroke + line / 2)
        this.marks.add(
          new Line({ points: quad.flatMap((point) => [point.x, point.y]), closed: true, stroke: select, strokeWidth: line, opacity, listening: false }),
        )
        return
      }
      // A group owns no geometry, so what is outlined is the box its children occupy.
      const bounds = nodeBounds(doc, id)
      if (!bounds) return
      const pad = line / 2
      this.marks.add(
        new KonvaRect({ x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2, stroke: select, strokeWidth: line, opacity, listening: false }),
      )
    }
    // With more than one thing selected the transformer's border is only the combined box, so each
    // member gets its own outline too, as in Figma. One selected thing keeps the
    // single outline.
    for (const id of selected) if (selected.length > 1 || !hasHandles(id)) draw(id)
    if (hovered !== undefined && !selected.includes(hovered)) draw(hovered, HOVER_OPACITY)
    this.drawSizeTag(doc, selected)
    this.overlayLayer.draw()
  }

  /**
   * The size tag under a selection: `W x H` in output pixels, or a single straight arrow or line's
   * `N px` length.
   *
   * Drawn on the marks group, so it follows selection and hover without rebuilding the composition,
   * and counter-scaled by the view so it stays one size on screen at every zoom -- a tag that grew
   * with the picture would cover the shape it is describing at 200%.
   *
   * The number is scene units, and scene units *are* output pixels here: `emptyDoc` is built from
   * the tiled image's own width and height. So there is no display-px-times-capture-scale conversion
   * to do: a mockup would measure in CSS pixels, and this document
   * does not. The export scale is deliberately not folded in either, for the same reason the status
   * bar leaves it out: these numbers describe the document, and one readout applying it while the
   * other two did not is exactly the disagreement the single-owner rule exists to prevent.
   */
  private drawSizeTag(doc: SceneDoc, selected: readonly string[]): void {
    // `marks.destroyChildren()` at the top of `setOutlines` has already destroyed the old one, so the
    // reference is dangling until it is replaced or cleared here.
    // Its own group, so `marks.destroyChildren()` above does not reach it.
    this.tagGroup.destroyChildren()
    this.sizeTag = undefined
    this.sizeTagText = undefined
    this.sizeTagFoot = undefined
    if (selected.length === 0) return
    // ponytail: the label is rebuilt, and its text re-measured, on every `setOutlines` -- which means
    // on every pointer move while something is selected. Same pattern as the outlines beside it. If a
    // crowded capture ever feels heavy on hover, cache the label and only rebuild when the text
    // changes; not worth the state until it measurably does.
    const bounds = selectionBounds(doc, selected)
    if (!bounds) return
    const only = selected.length === 1 ? findNode(doc.nodes, selected[0] as string) : undefined
    const straight = only?.type === 'arrow' || only?.type === 'line'
    const label = new Label({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height + TAG_GAP / this.scale,
      scaleX: 1 / this.scale,
      scaleY: 1 / this.scale,
      listening: false,
    })
    label.add(new Tag({ fill: cssToken('--select', SELECT_FALLBACK), cornerRadius: 3, pointerDirection: 'none' }))
    const textNode = new Text({
      text: tagText(bounds, straight),
      fill: cssToken('--on-select', '#FFFFFF'),
      fontFamily: cssToken('--mono', 'ui-monospace, monospace'),
      fontSize: 10.5,
      padding: 3,
    })
    label.add(textNode)
    // Centred on the selection. Konva can only measure the text once the child is in place, and the
    // offset is in the label's own units, so it survives the counter-scale below unchanged.
    label.offsetX(label.getClientRect({ relativeTo: label }).width / 2)
    this.tagGroup.add(label)
    this.sizeTag = label
    this.sizeTagText = textNode
    this.sizeTagStraight = straight
    this.sizeTagFoot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }
    this.placeSizeTag()
  }

  /**
   * Re-reads the size tag from the nodes as they are *right now*, mid-gesture.
   *
   * `setOutlines` draws the tag from the document, and the document is not written until a gesture
   * ends -- so during a resize the tag would sit at the old size, at the old place, until the mouse
   * came up. The live box is the union of the transformed nodes' own rectangles, `skipStroke` so a
   * thick outline does not inflate the number.
   *
   * **Measured against `composition`, which is the thing that holds the camera.** The camera is set
   * on the scene *groups*, not on the layers -- `syncCamera` positions and scales `composition`,
   * `interaction` and every overlay child, while the layers themselves stay at identity. So
   * `relativeTo: overlayLayer` returns stage pixels, and feeding stage pixels to a tag that lives
   * inside a camera-scaled group threw it up towards the top-left corner the moment a drag started.
   * `relativeTo: composition` returns scene units, which is the space `tagGroup` is in.
   *
   * Not the transformer's own `getClientRect` either: that includes the anchors and the border, and
   * would read about 8px large on every side.
   */
  /**
   * Two round handles on a single arrow or line, one per point.
   *
   * Each remembers its own point in the node's local space, so a zoom re-derives where it belongs
   * rather than trying to keep a stale absolute position. A drag converts back through the owning
   * group's own transform -- Konva's inverse, not hand-rolled matrix maths -- which keeps the handle
   * correct on a segment that has been moved, scaled or rotated since it was drawn.
   */
  private buildEndpoints(id: string, points: readonly number[], owner: Group): void {
    const select = cssToken('--select', SELECT_FALLBACK)
    // However many points it is handed: two for a segment's ends, one for a counter's pin tip.
    for (let index = 0; index < points.length / 2; index += 1) {
      const local = { x: points[index * 2] ?? 0, y: points[index * 2 + 1] ?? 0 }
      const handle = new Circle({
        name: ENDPOINT_NAME,
        draggable: true,
        radius: ENDPOINT_RADIUS / this.scale,
        fill: '#FFFFFF',
        stroke: select,
        strokeWidth: 1.2 / this.scale,
      })
      this.endpoints.add(handle)
      const entry = { handle, owner, index, local }
      this.endpointState.push(entry)
      handle.absolutePosition(owner.getAbsoluteTransform().point(local))
      handle.on('dragstart', () => this.gestures.begin(false))
      handle.on('dragmove', () => {
        this.dragEndpoint(entry)
        // Live, so the inspector's angle counts while the end is dragged rather than after it. The
        // undo snapshot was taken by `begin` above, so these writes all ride on one step.
        this.gestures.pointsChanged(id, this.currentPoints(), true)
      })
      handle.on('dragend', () => this.gestures.pointsChanged(id, this.currentPoints()))
    }
    this.overlayLayer.draw()
  }

  /** The two points as the handles currently stand, in the owning node's local space. */
  private currentPoints(): number[] {
    const out = new Array<number>(this.endpointState.length * 2).fill(0)
    for (const entry of this.endpointState) {
      out[entry.index * 2] = entry.local.x
      out[entry.index * 2 + 1] = entry.local.y
    }
    return out
  }

  private dragEndpoint(entry: { handle: Circle; owner: Group; index: number; local: { x: number; y: number } }): void {
    const before = entry.local
    entry.local = entry.owner.getAbsoluteTransform().copy().invert().point(entry.handle.absolutePosition())
    // Shift steps an endpoint in 45s about the *other* end,
    // through the same function a fresh draw uses -- the angles a line can be dragged to and the
    // angles it can be drawn at must be one list. The constraint is applied in the node's local
    // space, so it constrains the points the inspector reports rather than their rotated projection.
    const anchor = this.shiftHeld && entry.index < 2 ? this.endpointState.find((other) => other.index === 1 - entry.index) : undefined
    if (anchor) {
      entry.local = constrainDrag('line', anchor.local, entry.local, { shift: true, alt: false }).end
      // The handle is put back on the constrained point, or it drifts away from the end it moves.
      entry.handle.absolutePosition(entry.owner.getAbsoluteTransform().point(entry.local))
    }
    // An arrow's bend is kept relative to its ends, so the middle handle rides half of an end's move.
    const middle = entry.index < 2 ? this.endpointState.find((other) => other.index === 2) : undefined
    if (middle) {
      middle.local = { x: middle.local.x + (entry.local.x - before.x) / 2, y: middle.local.y + (entry.local.y - before.y) / 2 }
      middle.handle.absolutePosition(middle.owner.getAbsoluteTransform().point(middle.local))
    }
    const child = entry.owner.getChildren()[0]
    if (entry.owner.getAttr('sceneType') === 'arrow' && child) {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, mx = 0, my = 0] = this.currentPoints()
      child.setAttrs({ points: [x1, y1, x2, y2], bend: { x: mx - (x1 + x2) / 2, y: my - (y1 + y2) / 2 } })
    } else if (child instanceof Line) child.points(this.currentPoints())
    // A counter's pin reads its tip off its own attribute, so the live tail follows the handle
    // without rebuilding the composition -- the same trick, one attribute instead of a points array.
    else if (child instanceof KonvaShape) child.setAttr('tip', { ...entry.local })
    this.compositionLayer.batchDraw()
    this.followSizeTag()
  }

  private buildLens(shape: { node: MagnifierNode; matrix: Matrix }, owner: Group): void {
    const view = owner.getChildren()[0]
    if (!(view instanceof KonvaShape)) return
    const select = cssToken('--select', SELECT_FALLBACK)
    const own = invert(matrixOf(shape.node.transform))
    const parent = own ? multiply(shape.matrix, own) : shape.matrix
    // Transparent, not unfilled: a fill is what gives a Konva shape its whole area to press.
    const body = new KonvaRect({ name: ENDPOINT_NAME, draggable: true, fill: 'rgba(0,0,0,0)' })
    const grip = new Circle({ name: ENDPOINT_NAME, draggable: true, fill: '#FFFFFF', stroke: select })
    this.endpoints.add(body, grip)
    const state = { id: shape.node.id, view, owner, centre: { ...(view.getAttr('lens') as { x: number; y: number; zoom: number }) }, parent, body, grip }
    this.lensState = state
    const commit = (live: boolean): void => {
      const inverse = invert(state.parent)
      const at = inverse ? applyMatrix(inverse, state.centre.x, state.centre.y) : state.centre
      this.gestures.pointsChanged(state.id, [at.x, at.y, state.centre.zoom], live)
    }
    const redraw = (): void => {
      view.setAttr('lens', { ...state.centre })
      this.placeLens()
      this.compositionLayer.batchDraw()
      this.overlayLayer.batchDraw()
    }
    const toScene = (node: Node): { x: number; y: number } => this.composition.getAbsoluteTransform().copy().invert().point(node.absolutePosition())
    body.on('dragstart', () => this.gestures.begin(false))
    grip.on('dragstart', () => this.gestures.begin(false))
    body.on('dragend', () => commit(false))
    grip.on('dragend', () => commit(false))
    body.on('dragmove', () => {
      const at = toScene(body)
      const rect = this.lensRectNow()
      if (!rect) return
      state.centre = { ...state.centre, x: at.x + rect.width / 2, y: at.y + rect.height / 2 }
      redraw()
      commit(true)
    })
    // The grip sets the zoom from the lens's right edge; the lens grows and shrinks about its centre.
    grip.on('dragmove', () => {
      const at = toScene(grip)
      const source = sourceRectOf(owner, shape.node)
      state.centre = { ...state.centre, zoom: Math.max(0.5, (2 * (at.x - state.centre.x)) / (source.width || 1)) }
      redraw()
      commit(true)
    })
    this.placeLens()
  }

  /** The selected lens in scene space, from its centre and zoom and the source's live size. */
  private lensRectNow(): Rect | undefined {
    const state = this.lensState
    if (!state) return undefined
    const node = findNode(this.doc?.nodes ?? [], state.id)
    if (node?.type !== 'magnifier') return undefined
    const source = sourceRectOf(state.owner, node)
    return lensAround(state.centre, source.width, source.height)
  }

  /** A `TilePainter` over the decoded capture tiles: each one's share of `source`, scaled into `lens`. */
  private readonly paintTiles: TilePainter = (context, source, lens) => {
    const kx = lens.width / (source.width || 1)
    const ky = lens.height / (source.height || 1)
    for (const { bitmap, node } of this.visibleTiles.values()) {
      const tile = { x: node.x(), y: node.y(), width: node.width(), height: node.height() }
      const x = Math.max(source.x, tile.x)
      const y = Math.max(source.y, tile.y)
      const right = Math.min(source.x + source.width, tile.x + tile.width)
      const bottom = Math.min(source.y + source.height, tile.y + tile.height)
      if (right <= x || bottom <= y) continue
      const bx = bitmap.width / (tile.width || 1)
      const by = bitmap.height / (tile.height || 1)
      context.drawImage(
        bitmap,
        (x - tile.x) * bx,
        (y - tile.y) * by,
        (right - x) * bx,
        (bottom - y) * by,
        lens.x + (x - source.x) * kx,
        lens.y + (y - source.y) * ky,
        (right - x) * kx,
        (bottom - y) * ky,
      )
    }
  }

  /** Puts the lens handles on the lens, at this zoom's screen size. */
  private placeLens(): void {
    const state = this.lensState
    const rect = this.lensRectNow()
    if (!state || !rect) return
    const toAbsolute = (x: number, y: number): { x: number; y: number } => this.composition.getAbsoluteTransform().point({ x, y })
    state.body.absolutePosition(toAbsolute(rect.x, rect.y))
    state.body.size({ width: rect.width, height: rect.height })
    state.grip.radius(ENDPOINT_RADIUS / this.scale)
    state.grip.strokeWidth(1.2 / this.scale)
    state.grip.absolutePosition(toAbsolute(rect.x + rect.width, rect.y + rect.height / 2))
  }


  /** Re-derives each handle's place and screen size. Same reason as `placeSizeTag`: zoom. */
  private placeEndpoints(): void {
    this.placeLens()
    for (const entry of this.endpointState) {
      entry.handle.radius(ENDPOINT_RADIUS / this.scale)
      entry.handle.strokeWidth(1.2 / this.scale)
      entry.handle.absolutePosition(entry.owner.getAbsoluteTransform().point(entry.local))
    }
  }

  private followSizeTag(): void {
    const tag = this.sizeTag
    const text = this.sizeTagText
    const nodes = this.transformer.nodes()
    if (!tag || !text || nodes.length === 0) return
    let box: Rect | undefined
    for (const node of nodes) {
      const rect = node.getClientRect({ relativeTo: this.composition, skipStroke: true })
      box = box === undefined ? rect : unionRect(box, rect)
    }
    if (!box || (box.width === 0 && box.height === 0)) return
    text.text(tagText(box, this.sizeTagStraight))
    tag.offsetX(tag.getClientRect({ relativeTo: tag }).width / 2)
    this.sizeTagFoot = { x: box.x + box.width / 2, y: box.y + box.height }
    this.placeSizeTag()
    this.overlayLayer.batchDraw()
  }

  /**
   * Puts the size tag at its anchor, counter-scaled so it is the same size on screen at every zoom.
   *
   * It lives here rather than inside `drawSizeTag` because **`setZoom` never calls `setOutlines`** --
   * it calls `setViewport` twice and returns. A tag positioned only where it is built would keep the
   * previous zoom's counter-scale and grow with the picture, and nothing in the test suite can see
   * that. `setViewport` is the one place every scale change passes through, so the placement is
   * owned here and called from both.
   */
  private placeSizeTag(): void {
    const tag = this.sizeTag
    const foot = this.sizeTagFoot
    if (!tag || !foot) return
    tag.scale({ x: 1 / this.scale, y: 1 / this.scale })
    tag.position({ x: foot.x, y: foot.y + TAG_GAP / this.scale })
  }

  clearDraft(): void {
    this.interaction.destroyChildren()
    this.interactionLayer.draw()
  }

  /** The rubber band: a drag on empty stage under Move, selecting whatever it touches. */
  showMarquee(rect: Rect): void {
    this.interaction.destroyChildren()
    const select = cssToken('--select', SELECT_FALLBACK)
    this.interaction.add(
      new KonvaRect({ ...rect, stroke: select, strokeWidth: 1 / this.scale, fill: select, opacity: 0.12, listening: false }),
    )
    this.interactionLayer.draw()
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.trackModifiers, { capture: true })
    window.removeEventListener('pointerdown', this.trackModifiers, { capture: true })
    window.removeEventListener('pointerup', this.trackModifiers, { capture: true })
    this.releaseSources()
    this.stage.destroy()
  }

  /**
   * Where the composition's scene origin sits on the stage, in CSS pixels.
   *
   * The slack terms are what centre it: when the scaled composition is smaller than the viewport
   * there is nothing to scroll, and without them the picture sits hard against the top-left corner
   * while the space it should be centred in opens to its right. The
   * composition belongs centred, and zooming out to a picture pinned in one corner reads as a broken zoom.
   */
  private camera(): { x: number; y: number } {
    return {
      x: STAGE_PADDING + this.slackX() - this.output.x * this.scale - this.scrollX,
      y: STAGE_PADDING + this.slackY() - this.output.y * this.scale - this.scrollY,
    }
  }

  /** Half of whatever viewport width the composition does not fill. Zero once it overflows. */
  slackX(): number {
    return Math.max(0, this.stage.width() - (this.output.width * this.scale + STAGE_PADDING * 2)) / 2
  }

  slackY(): number {
    return Math.max(0, this.stage.height() - (this.output.height * this.scale + STAGE_PADDING * 2)) / 2
  }

  private syncCamera(): void {
    const camera = this.camera()
    // The export marker follows the output rectangle in stage pixels, through the same camera.
    const origin = this.stageAt(this.output.x, this.output.y)
    this.sheet.hidden = this.doc === undefined
    this.sheet.style.transform = `translate(${origin.x}px, ${origin.y}px)`
    this.sheet.style.width = `${this.output.width * this.scale}px`
    this.sheet.style.height = `${this.output.height * this.scale}px`
    /*
     * Everything that thinks in scene units gets the camera, and that is everything on the overlay
     * *except the transformer*, which deliberately stays unscaled so its handles hold 8 CSS pixels
     * at any zoom.
     *
     * Derived, not listed. This was a hand-written list, and adding two groups to the overlay
     * without also adding them here left both in stage coordinates: the size tag was drawn far off
     * screen when a shape was selected, and its counter-scale had nothing to cancel, so it grew and
     * shrank with the zoom instead of holding still. A list that has to be kept in step with a
     * constructor is a list that will not be.
     */
    const scened = [this.composition, this.interaction, ...this.overlayLayer.getChildren((node) => node !== this.transformer)]
    for (const root of scened) {
      root.position(camera)
      root.scale({ x: this.scale, y: this.scale })
    }
    // The transformer sits on the unscaled layer, so its handles stay 8 CSS pixels at any zoom --
    // but it caches the box it drew, and the box moved. Its padding is screen pixels derived from a
    // scene-unit stroke, so a zoom has to recompute it or the outline slides onto the stroke.
    this.padHandles(selectionPadding(this.cropNode ? [] : this.handleStrokes, this.scale))
    this.transformer.forceUpdate()
    this.drawNow()
  }

  private drawNow(): void {
    // The browser harness never receives rAF, so `batchDraw()` can leave a correct stage empty.
    this.compositionLayer.draw()
    this.overlayLayer.draw()
    this.interactionLayer.draw()
  }

  private releaseSources(): void {
    this.tileToken += 1
    for (const { bitmap, node } of this.visibleTiles.values()) {
      node.destroy()
      bitmap.close()
    }
    this.visibleTiles.clear()
    this.captureGroup = undefined
    this.captureOp = undefined
    this.image = undefined
    for (const canvas of this.blurCanvases.splice(0)) {
      canvas.width = 0
      canvas.height = 0
    }
  }

  private async syncVisibleTiles(): Promise<void> {
    const group = this.captureGroup
    const op = this.captureOp
    const image = this.image
    if (!group || !op || !image) return
    const token = ++this.tileToken
    const visible: Rect = {
      x: this.output.x + Math.max(0, this.scrollX - STAGE_PADDING) / this.scale,
      y: this.output.y + Math.max(0, this.scrollY - STAGE_PADDING) / this.scale,
      width: this.stage.width() / this.scale,
      height: this.stage.height() / this.scale,
    }
    const wanted = new Set<number>()

    await Promise.all(
      image.tiles.map(async (tile, index) => {
        const rect = { x: op.rect.x, y: op.rect.y + tile.offsetY, width: tile.width, height: tile.height }
        if (!rectsIntersect(rect, visible)) return
        wanted.add(index)
        if (this.visibleTiles.has(index)) return
        const bitmap = await createImageBitmap(tile.blob)
        if (token !== this.tileToken || group !== this.captureGroup) {
          bitmap.close()
          return
        }
        const node = new KonvaImage({ ...rect, image: bitmap, listening: false })
        this.visibleTiles.set(index, { bitmap, node })
        group.add(node)
      }),
    )
    if (token !== this.tileToken) return
    for (const [index, source] of this.visibleTiles) {
      if (wanted.has(index)) continue
      source.node.destroy()
      source.bitmap.close()
      this.visibleTiles.delete(index)
    }
    this.compositionLayer.draw()
  }
}

/** The height a text node's lines take at its width, laid out as Konva draws them. */
export function measureTextHeight(node: { text: string; width: number; fontSize: number; fontWeight: number; fontFamily?: string; italic?: true; fill?: string; align: 'left' | 'center' | 'right' }): number {
  const inset = textInset(node)
  const probe = new Text({
    text: node.text,
    width: Math.max(1, node.width - inset.x * 2),
    fontSize: node.fontSize,
    fontStyle: textFontStyle(node),
    fontFamily: textFontFamily(node),
    lineHeight: 1.2,
    align: node.align,
  })
  const height = Math.max(1, probe.height()) + inset.y * 2
  probe.destroy()
  return height
}

function measureTextNodes(nodes: readonly SceneNode[]): void {
  for (const node of nodes) {
    if (isGroupNode(node)) {
      measureTextNodes(node.children)
      continue
    }
    if (!isShapeNode(node)) continue
    if (node.type === 'text') {
      // A fixed box keeps the height the user gave it and the text is clipped to it.
      // Through `resizeTextBox`, so a pointer below the box moves down with a new line.
      if (!node.fixedHeight) resizeTextBox(node, node.width, measureTextHeight(node))
    } else if (node.type === 'emoji') {
      const probe = new Text({ text: node.char, fontSize: node.fontSize, fontFamily: SCENE_FONT })
      node.width = Math.max(1, probe.width())
      node.height = Math.max(1, probe.height())
      probe.destroy()
    }
  }
}

/**
 * A Konva node's own transform as a scene-space matrix.
 *
 * `shapeNode` writes each node's *world* transform onto the node itself — `flatten` has already
 * resolved the ancestors away — and the camera lives on the parent group, so a composition child's
 * own attributes are scene space exactly. That is what makes a gesture's delta readable without
 * unpacking anything.
 */
function matrixOfNode(node: { x(): number; y(): number; scaleX(): number; scaleY(): number; rotation(): number }): Matrix {
  return matrixOf({ x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() })
}

function backdropNode(op: Extract<DrawOp, { kind: 'backdrop' }>): KonvaRect {
  if (op.background === 'none') return new KonvaRect({ ...op.rect, listening: false })
  if (op.background === 'custom') return new KonvaRect({ ...op.rect, fill: op.customColor, listening: false })
  const stops = PRESENT_GRADIENTS[op.background]
  return new KonvaRect({
    ...op.rect,
    fillLinearGradientStartPoint: { x: 0, y: 0 },
    fillLinearGradientEndPoint: { x: op.rect.width, y: op.rect.height },
    fillLinearGradientColorStops: stops.flatMap((stop) => [stop.at, stop.color]),
    listening: false,
  })
}

/**
 * An arrow from the shared `arrowPath`: filled when solid, a round-capped stroke otherwise. `points`
 * and `bend` are read off the Konva node, so an end or the middle handle redraws by setting them
 * (`dragEndpoint`), as a counter's tip does.
 */
function arrowShape(node: Pick<ArrowNode, 'points' | 'bend' | 'style' | 'stroke' | 'strokeWidth' | 'headSize' | 'size'>): KonvaShape {
  const solid = node.style === 'solid'
  const shape = new KonvaShape({
    points: [...node.points],
    bend: node.bend,
    ...(solid ? { fill: node.stroke } : { stroke: node.stroke, strokeWidth: node.strokeWidth, lineCap: 'round', lineJoin: 'round' }),
    // A thin line is hard to press; the hit region is a little wider than the ink, as `arrowShapeHit`.
    hitStrokeWidth: (Math.max(node.strokeWidth / 2, 3) + 3) * 2,
    sceneFunc: (context, self) => {
      arrowPath(context, { ...node, points: self.getAttr('points') as number[], bend: self.getAttr('bend') as ArrowNode['bend'] })
      context.fillStrokeShape(self)
    },
  })
  // Konva cannot read a custom `sceneFunc`'s extent. The drawn extent, less the stroke Konva adds.
  // ponytail: instance override of Konva's getSelfRect; re-check it on a Konva major upgrade.
  shape.getSelfRect = () => {
    const box = localBounds({ ...(node as ArrowNode), type: 'arrow', points: shape.getAttr('points') as number[], bend: shape.getAttr('bend') as ArrowNode['bend'] })
    const pad = solid ? 0 : node.strokeWidth / 2
    return { x: box.x + pad, y: box.y + pad, width: box.width - pad * 2, height: box.height - pad * 2 }
  }
  return shape
}

/** A magnifier's source in scene space, read off its group's live transform (mid-drag included). */
function sourceRectOf(group: Node, node: { width: number; height: number }): Rect {
  const own = group.getTransform()
  const a = own.point({ x: 0, y: 0 })
  const b = own.point({ x: node.width, y: node.height })
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/** Paints the capture under `source` over `lens`, from whatever tiles the preview has decoded. */
type TilePainter = (context: CanvasRenderingContext2D, source: Rect, lens: Rect) => void

function shapeNode(shape: ResolvedShape, pixels?: { canvas: OffscreenCanvas; rect: Rect }, tiles?: TilePainter): Group {
  const node = shape.node
  const attrs = decompose(shape.matrix)
  // `sceneType` rides along so the handles can ask what they are attached to
  // without a second lookup into the document.
  const group = new Group({ ...attrs, id: node.id, sceneType: node.type, opacity: shape.opacity, listening: false })
  switch (node.type) {
    case 'rectangle':
      group.add(new KonvaRect({ width: node.width, height: node.height, stroke: hasStroke(node) ? node.stroke : undefined, strokeWidth: node.strokeWidth, fill: node.fill === 'none' ? undefined : node.fill, cornerRadius: node.radius }))
      break
    case 'ellipse':
      group.add(new Ellipse({ x: node.width / 2, y: node.height / 2, radiusX: node.width / 2, radiusY: node.height / 2, stroke: hasStroke(node) ? node.stroke : undefined, strokeWidth: node.strokeWidth, fill: node.fill === 'none' ? undefined : node.fill }))
      break
    case 'arrow':
      group.add(arrowShape(node))
      break
    case 'line':
      group.add(new Line({ points: [...node.points], stroke: node.stroke, strokeWidth: node.strokeWidth, lineCap: 'round', lineJoin: 'round' }))
      break
    case 'freehand':
      group.add(new Line({
        points: [...node.points],
        stroke: node.stroke,
        strokeWidth: node.strokeWidth,
        lineCap: 'round',
        lineJoin: 'round',
        /*
         * **No `tension`.** Konva's tension draws a Catmull-Rom spline through the points; the
         * export's `drawLine` draws straight segments between them, and the two would disagree
         * everywhere the stroke curves. The smoothing has already
         * happened in `smoothStroke`, and at a 4-unit resample a polyline reads as a curve anyway.
         * If a spline is ever wanted, it has to be built into the shared geometry, not switched on
         * here.
         */
        ...(node.marker ? { globalCompositeOperation: 'multiply' as const } : {}),
      }))
      break
    case 'text': {
      const outline = hasStroke(node)
      // `fillAfterStrokeEnabled` strokes first and fills over it, so the outline sits outside the
      // glyphs; the export draws in the same order.
      // A filled box: the box and its pointer from the shared `textBubblePath`, the text inset in it.
      // `width`/`height` are what `getSelfRect` falls back to -- the box, not the pointer, as a
      // counter's disc -- and `tip` is read off the node so a tip drag redraws by setting it.
      const inset = textInset(node)
      if (node.fill !== undefined) {
        group.add(new KonvaShape({
          tip: node.tip,
          fill: node.fill,
          width: node.width,
          height: node.height,
          sceneFunc: (context, shape) => {
            textBubblePath(context, { ...node, tip: shape.getAttr('tip') as { x: number; y: number } | undefined })
            context.fillStrokeShape(shape)
          },
        }))
      }
      const text = new Text({ x: inset.x, y: inset.y, text: node.text, width: Math.max(1, node.width - inset.x * 2), fontSize: node.fontSize, fontStyle: textFontStyle(node), fontFamily: textFontFamily(node), lineHeight: 1.2, align: node.align, fill: node.color, stroke: outline ? node.stroke : undefined, strokeWidth: outline ? node.strokeWidth : 0, lineJoin: 'round', fillAfterStrokeEnabled: true })
      if (!node.fixedHeight) {
        group.add(text)
        break
      }
      // A fixed box clips its text. The clip sits on an inner group so a mid-resize redraw that
      // swaps the outer group's children carries it. Konva's client rect ignores a clip and a Text
      // reports its lines, so the handles would wrap the hidden text: the Text reports the box instead.
      // A Text `height` would also clip, but only by dropping whole lines, where the export crops pixels.
      // ponytail: instance override of Konva's getSelfRect; re-check it on a Konva major upgrade.
      text.getSelfRect = () => ({ x: 0, y: 0, width: node.width - inset.x * 2, height: node.height - inset.y * 2 })
      // Room for the outline at the sides and top; the bottom edge is the crop the user set.
      const pad = outline ? node.strokeWidth / 2 : 0
      group.add(new Group({ clip: { x: -pad, y: -pad, width: node.width + pad * 2, height: node.height + pad } }).add(text))
      break
    }
    case 'highlight':
      group.add(new KonvaRect({ width: node.width, height: node.height, fill: node.color, globalCompositeOperation: 'multiply' }))
      break
    case 'emoji':
      group.add(new Text({ text: node.char, fontSize: node.fontSize, fontFamily: SCENE_FONT }))
      break
    case 'image': {
      // A box until the picture decodes, so the handles have something to hold meanwhile.
      const bitmap = decodedImage(node.src)
      group.add(bitmap ? new KonvaImage({ width: node.width, height: node.height, image: bitmap }) : new KonvaRect({ width: node.width, height: node.height }))
      break
    }
    case 'counter': {
      // The disc, then the digits laid out by hand rather than in a Konva text box: an unboxed Text
      // is one line of height `fontSize` at its own x/y, which is a placement the export can
      // reproduce exactly (it is how emoji already works). A box with `verticalAlign` would put the
      // baseline somewhere only Konva knows, and the two renderers would disagree by a pixel or two.
      const label = String(node.count)
      const fontSize = counterFontSize(node.width, node.count)
      const digits = new Text({ text: label, fontSize, fontFamily: SCENE_FONT, fontStyle: 'bold', fill: node.color })
      // A `Shape` with a `sceneFunc` rather than an `Ellipse`, so the disc and its tail come from
      // `counterPath` -- the very same function the export calls. `tip` is read off the Konva node
      // rather than closed over, so a tip drag can redraw by setting one attribute (`dragEndpoint`).
      const pin = new KonvaShape({
        tip: node.tip,
        fill: node.fill,
        // Konva cannot read a custom `sceneFunc`'s extent, and `getSelfRect` falls back to these.
        // The **disc**, deliberately, not the tail: the transformer box is what the four corner
        // anchors resize, and wrapping the tail would put the corners somewhere the drag does not
        // mean. The tail is still inside `localBounds`, which is what keeps the export from
        // clipping it.
        width: node.width,
        height: node.height,
        sceneFunc: (context, shape) => {
          counterPath(context, node.width, shape.getAttr('tip') as { x: number; y: number } | undefined)
          context.fillStrokeShape(shape)
        },
      })
      group.add(pin)
      digits.x((node.width - digits.width()) / 2)
      digits.y((node.height - fontSize) / 2)
      group.add(digits)
      break
    }
    case 'magnifier': {
      // One shape draws it all, in scene space: it takes its own group's transform back off, so the
      // lens stays put while the source is dragged or resized, and reads the source's place off that
      // same live transform. `width`/`height` are the source, which is what the box handles size.
      const world = magnifierWorld({ node, matrix: shape.matrix })
      group.add(new KonvaShape({
        // The lens's centre in scene space and its zoom; its size comes from the source's live size.
        lens: { x: world.lens.x + world.lens.width / 2, y: world.lens.y + world.lens.height / 2, zoom: world.lens.width / (world.source.width || 1) },
        width: node.width,
        height: node.height,
        fill: 'rgba(0,0,0,0)',
        sceneFunc: (context, self) => {
          const parent = self.getParent()
          if (!parent) return
          const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = parent.getTransform().copy().invert().getMatrix()
          const source = sourceRectOf(parent, node)
          const lens = lensAround(self.getAttr('lens') as { x: number; y: number; zoom: number }, source.width, source.height)
          const native = context._context
          native.save()
          native.transform(a, b, c, d, e, f)
          // At rest, the area painted for it at render time; once the source has moved or been resized,
          // the decoded tiles, live -- the source is on screen while it is being dragged, so they are
          // there. The rendered area is still the fallback for a source scrolled out of view.
          const still = pixels && Math.abs(pixels.rect.x - source.x) < 0.5 && Math.abs(pixels.rect.y - source.y) < 0.5 && Math.abs(pixels.rect.width - source.width) < 0.5 && Math.abs(pixels.rect.height - source.height) < 0.5
          drawMagnifier(native, node, source, lens, (target, into) => {
            if (still || !tiles) {
              if (pixels) target.drawImage(pixels.canvas, into.x, into.y, into.width, into.height)
            } else tiles(native, source, into)
          })
          native.restore()
        },
        // Pressed by its source only; the lens has its own handles in the overlay.
        hitFunc: (context, self) => {
          context.beginPath()
          context.rect(0, 0, node.width, node.height)
          context.closePath()
          context.fillStrokeShape(self)
        },
      }))
      break
    }
    case 'blur':
      // `render()` draws a blur as a clipped image with no id. This invisible box is what the handles
      // attach to, so a blur can be selected, moved and resized like any other shape.
      group.add(new KonvaRect({ width: node.width, height: node.height }))
      break
  }
  return group
}
