import { describe, expect, it } from 'vitest'
import {
  BOX_ANCHORS,
  IDENTITY_MATRIX,
  MIN_SHAPE_SIZE,
  anchorsFor,
  isStraightSelection,
  cornersHoldRatio,
  applyMatrix,
  clickTarget,
  cloneSubtree,
  composeLocal,
  findNode,
  foldScale,
  gestureDelta,
  handleTargets,
  expandedQuad,
  inverseScale,
  isGroupNode,
  liveFold,
  matrixOf,
  multiply,
  parentMatrixOf,
  parseSceneDoc,
  nodesInRect,
  ratioLockedBox,
  selectionBounds,
  selectionLeaves,
  selectionPadding,
  shapesRect,
  sideAnchorsFit,
  rotateAnchorOffset,
  ROTATE_ANCHOR_GAP,
  SCENE_FONT,
  textFontFamily,
  textFontStyle,
  usesOpacityBuffer,
  snapCandidates,
  snapDelta,
  type Matrix,
  type SnapCandidates,
  type SceneDoc,
  type ShapeNode,
} from '../src/editor/scene'

function doc(nodes: unknown[]): SceneDoc {
  return parseSceneDoc({ nodes }, 1000, 800)
}

function box(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'rectangle', transform: { x: 0, y: 0 }, width: 100, height: 50, strokeWidth: 0, ...extra }
}

function group(id: string, children: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'group', transform: { x: 0, y: 0 }, children, ...extra }
}

function shape(scene: SceneDoc, id: string): ShapeNode {
  const node = findNode(scene.nodes, id)
  if (!node || isGroupNode(node)) throw new Error(`${id} is not a shape`)
  return node
}

/** A translation, which is what a drag produces. */
function move(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y]
}

describe('what the handles attach to', () => {
  it('resolves a selected shape to itself', () => {
    const scene = doc([box('a'), box('b')])
    expect(selectionLeaves(scene, ['b']).map((leaf) => leaf.node.id)).toEqual(['b'])
  })

  it('resolves a selected group to its leaves, because neither renderer is handed a group', () => {
    const scene = doc([box('a'), group('g', [box('b'), group('h', [box('c')])])])
    expect(selectionLeaves(scene, ['g']).map((leaf) => leaf.node.id)).toEqual(['b', 'c'])
  })

  it('lists a node once even when it and its group are both selected', () => {
    const scene = doc([group('g', [box('b')])])
    expect(selectionLeaves(scene, ['g', 'b']).map((leaf) => leaf.node.id)).toEqual(['b'])
  })

  it('skips a hidden leaf, which is not in the picture and has no handles', () => {
    const scene = doc([group('g', [box('b'), box('c', { hidden: true })])])
    expect(selectionLeaves(scene, ['g']).map((leaf) => leaf.node.id)).toEqual(['b'])
  })
})

describe('what the handles refuse', () => {
  it('takes no handles on a locked node, though the node is still selected', () => {
    const scene = doc([box('a', { locked: true }), box('b')])
    expect(handleTargets(scene, ['a', 'b']).map((leaf) => leaf.node.id)).toEqual(['b'])
    // Still selected, still measurable: only the gesture is refused.
    expect(selectionLeaves(scene, ['a']).map((leaf) => leaf.node.id)).toEqual(['a'])
    expect(selectionBounds(scene, ['a'])).toBeDefined()
  })

  it('takes none at all when everything selected is locked', () => {
    const scene = doc([group('g', [box('a')], { locked: true })])
    expect(handleTargets(scene, ['g'])).toEqual([])
  })
})

describe('anchors', () => {
  it('gives a shape all eight', () => {
    expect(anchorsFor(['rectangle'])).toEqual([...BOX_ANCHORS])
  })

  it('gives text all eight, because its top and bottom size the box', () => {
    expect(anchorsFor(['text'])).toEqual([...BOX_ANCHORS])
    expect(anchorsFor(['rectangle', 'text'])).toEqual([...BOX_ANCHORS])
  })

  it('gives one arrow or one line none at all: it is two points, not a box', () => {
    expect(anchorsFor(['arrow'])).toEqual([])
    expect(anchorsFor(['line'])).toEqual([])
    expect(isStraightSelection(['arrow'])).toBe(true)
  })

  it('gives a box back as soon as the selection is more than that one segment', () => {
    // Two arrows, or an arrow with anything else, is a group being scaled -- a box is right there.
    expect(anchorsFor(['arrow', 'arrow'])).toEqual([...BOX_ANCHORS])
    expect(anchorsFor(['arrow', 'rectangle'])).toEqual([...BOX_ANCHORS])
    expect(isStraightSelection(['arrow', 'arrow'])).toBe(false)
    expect(isStraightSelection([])).toBe(false)
  })
})

describe('a fixed-height text box', () => {
  const text = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 't', type: 'text', transform: { x: 10, y: 10 }, width: 100, height: 20, text: 'hi', fontSize: 20, ...extra,
  })

  it('reopens an old text node as auto-height, exactly as it was', () => {
    const node = shape(doc([text()]), 't')
    expect(node).toMatchObject({ height: 20, fontSize: 20 })
    expect(node).not.toHaveProperty('fixedHeight')
  })

  it('keeps a fixed box across a save, and the output is the box because the text is clipped to it', () => {
    const scene = doc([text({ fixedHeight: true })])
    expect(shape(scene, 't')).toMatchObject({ fixedHeight: true })
    expect(shapesRect(scene)).toEqual({ x: 10, y: 10, width: 100, height: 20 })
    expect(selectionBounds(scene, ['t'])).toEqual({ x: 10, y: 10, width: 100, height: 20 })
  })
})

describe('text font, italic and outline', () => {
  const textNode = (extra: Record<string, unknown> = {}) => {
    const node = shape(doc([{ id: 't', type: 'text', transform: { x: 0, y: 0 }, width: 100, height: 20, text: 'hi', fontSize: 20, ...extra }]), 't')
    if (node.type !== 'text') throw new Error('not text')
    return node
  }

  it('reopens an old text node in the system font, upright, with no outline', () => {
    const node = textNode()
    expect(node).toMatchObject({ stroke: 'none' })
    expect(node).not.toHaveProperty('fontFamily')
    expect(node).not.toHaveProperty('italic')
    expect(textFontFamily(node)).toBe(SCENE_FONT)
    expect(textFontStyle(node)).toBe('400')
    expect(usesOpacityBuffer(node, 0.5)).toBe(false)
  })

  it('puts a picked family in front of the system font and italic in the style', () => {
    const node = textNode({ fontFamily: 'Times New Roman', italic: true, fontWeight: 700 })
    expect(textFontFamily(node)).toBe(`"Times New Roman", ${SCENE_FONT}`)
    expect(textFontStyle(node)).toBe('italic 700')
  })

  it('blends outlined text once below full opacity, as filled and stroked shapes are', () => {
    expect(usesOpacityBuffer(textNode({ stroke: '#ffffff', strokeWidth: 3 }), 0.5)).toBe(true)
    expect(usesOpacityBuffer(textNode({ stroke: '#ffffff', strokeWidth: 3 }), 1)).toBe(false)
  })
})

describe('what a click or a press selects', () => {
  it('selects a top-level shape itself', () => {
    expect(clickTarget(doc([box('a'), box('b')]), [], 'b')).toBe('b')
  })

  it('selects the outermost group when nothing on the path is selected', () => {
    const scene = doc([group('g', [group('h', [box('c')])])])
    expect(clickTarget(scene, [], 'c')).toBe('g')
    expect(clickTarget(scene, ['x'], 'c')).toBe('g')
  })

  it('keeps a descended depth: a selected group or leaf on the path is the target', () => {
    const scene = doc([group('g', [group('h', [box('c')])])])
    expect(clickTarget(scene, ['h'], 'c')).toBe('h')
    expect(clickTarget(scene, ['c'], 'c')).toBe('c')
  })
})

describe('a gesture’s delta', () => {
  it('is the transform that takes the node from where it was to where it is', () => {
    const before = matrixOf({ x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 })
    const after = matrixOf({ x: 40, y: 25, scaleX: 1, scaleY: 1, rotation: 0 })
    const delta = gestureDelta(before, after)
    expect(delta).toBeDefined()
    expect(applyMatrix(delta as Matrix, 0, 0)).toEqual({ x: 30, y: 5 })
  })

  it('is undefined when the node had collapsed, which has no inverse', () => {
    expect(gestureDelta([0, 0, 0, 0, 0, 0], IDENTITY_MATRIX)).toBeUndefined()
  })
})

describe('writing a delta into a node', () => {
  it('moves a top-level node by the scene-space delta directly', () => {
    const scene = doc([box('a', { transform: { x: 100, y: 100 } })])
    const node = shape(scene, 'a')
    node.transform = composeLocal(move(20, -5), node.transform, parentMatrixOf(scene, 'a'))
    expect(node.transform.x).toBeCloseTo(120)
    expect(node.transform.y).toBeCloseTo(95)
  })

  it('carries the delta into the parent’s frame instead of double-counting it', () => {
    // The group is rotated 90°, so a scene-space drag to the right moves the child *down* its own
    // axis. Applying the delta to the child's local transform without conjugating would move it
    // sideways in the group's frame and therefore up the screen.
    const scene = doc([group('g', [box('b', { transform: { x: 0, y: 0 } })], { transform: { x: 0, y: 0, rotation: 90 } })])
    const node = shape(scene, 'b')
    node.transform = composeLocal(move(30, 0), node.transform, parentMatrixOf(scene, 'b'))
    expect(node.transform.x).toBeCloseTo(0)
    expect(node.transform.y).toBeCloseTo(-30)
    // What matters is where it ends up in scene space: 30 to the right of where it was.
    const world = multiply(matrixOf({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90 }), matrixOf(node.transform))
    const point = applyMatrix(world, 0, 0)
    expect(point.x).toBeCloseTo(30)
    expect(point.y).toBeCloseTo(0)
  })

  it('leaves a node inside a collapsed parent alone rather than inventing a transform', () => {
    const before = { x: 5, y: 6, scaleX: 1, scaleY: 1, rotation: 0 }
    expect(composeLocal(move(10, 10), before, [0, 0, 0, 0, 0, 0])).toEqual(before)
  })
})

describe('folding a resize into the geometry', () => {
  it('grows a box and leaves its stroke weight alone', () => {
    const scene = doc([box('a', { strokeWidth: 6, transform: { x: 0, y: 0, scaleX: 2, scaleY: 3 } })])
    const node = shape(scene, 'a')
    foldScale(node)
    expect(node).toMatchObject({ width: 200, height: 150, strokeWidth: 6 })
    expect(node.transform.scaleX).toBe(1)
    expect(node.transform.scaleY).toBe(1)
  })

  it('does nothing at all when the gesture was a move', () => {
    const scene = doc([box('a', { transform: { x: 4, y: 4 } })])
    const node = shape(scene, 'a')
    foldScale(node)
    expect(node).toMatchObject({ width: 100, height: 50 })
  })

  it('stretches a line’s points rather than its stroke', () => {
    const scene = doc([
      { id: 'l', type: 'line', transform: { x: 0, y: 0, scaleX: 2, scaleY: 0.5 }, points: [0, 0, 40, 80], strokeWidth: 4 },
    ])
    const node = shape(scene, 'l')
    foldScale(node)
    expect(node).toMatchObject({ points: [0, 0, 80, 40], strokeWidth: 4 })
  })

  it('sends a side handle to the wrap width and leaves an auto-height box auto', () => {
    const scene = doc([
      { id: 't', type: 'text', transform: { x: 0, y: 0, scaleX: 3, scaleY: 1 }, width: 100, height: 20, text: 'hi', fontSize: 20 },
    ])
    const node = shape(scene, 't')
    foldScale(node)
    expect(node).toMatchObject({ width: 300, height: 20, fontSize: 20 })
    expect(node).not.toHaveProperty('fixedHeight')
  })

  it('sizes and fixes the box from a corner, never the font', () => {
    const scene = doc([
      { id: 't', type: 'text', transform: { x: 0, y: 0, scaleX: 2, scaleY: 3 }, width: 100, height: 20, text: 'hi', fontSize: 20 },
    ])
    const node = shape(scene, 't')
    foldScale(node)
    expect(node).toMatchObject({ width: 200, height: 60, fontSize: 20, fixedHeight: true })
  })

  it('fixes the height from a top or bottom handle', () => {
    const scene = doc([
      { id: 't', type: 'text', transform: { x: 0, y: 0, scaleX: 1, scaleY: 0.5 }, width: 100, height: 40, text: 'hi', fontSize: 20 },
    ])
    const node = shape(scene, 't')
    foldScale(node)
    expect(node).toMatchObject({ width: 100, height: 20, fontSize: 20, fixedHeight: true })
  })

  it('keeps a mirror on the transform instead of folding its sign away', () => {
    const scene = doc([box('a', { transform: { x: 0, y: 0, scaleX: -2, scaleY: 1 } })])
    const node = shape(scene, 'a')
    foldScale(node)
    expect(node).toMatchObject({ width: 200 })
    expect(node.transform.scaleX).toBe(-1)
  })

  it('never folds a shape below the minimum size', () => {
    const scene = doc([box('a', { transform: { x: 0, y: 0, scaleX: 0.0001, scaleY: 0.0001 } })])
    const node = shape(scene, 'a')
    foldScale(node)
    expect(node).toMatchObject({ width: MIN_SHAPE_SIZE, height: MIN_SHAPE_SIZE })
  })
})

describe('duplicating', () => {
  it('gives every node in the copy a fresh id, at every depth', () => {
    const scene = doc([group('g', [box('b'), group('h', [box('c')])])])
    const original = findNode(scene.nodes, 'g')
    if (!original) throw new Error('missing')
    const copy = cloneSubtree(original)
    const collect = (node: unknown): string[] => {
      const known = node as { id: string; children?: unknown[] }
      return [known.id, ...(known.children ?? []).flatMap(collect)]
    }
    const copiedIds = collect(copy)
    expect(copiedIds).toHaveLength(4)
    expect(new Set(copiedIds).size).toBe(4)
    for (const id of copiedIds) expect(['g', 'b', 'h', 'c']).not.toContain(id)
  })

  it('copies the geometry, not a reference to it', () => {
    const scene = doc([box('a', { width: 120 })])
    const original = shape(scene, 'a')
    const copy = cloneSubtree(original) as ShapeNode
    original.transform.x = 999
    expect(copy.transform.x).toBe(0)
  })
})

describe('snapping', () => {
  const frame = { x: 0, y: 0, width: 1000, height: 800 }

  it('offers six lines per rectangle, and includes the frame’s own', () => {
    const scene = doc([box('a', { transform: { x: 100, y: 200 } })])
    const candidates = snapCandidates(scene, 0, new Set())
    // The frame's left/centre/right and the box's, in scene units.
    expect(candidates.x.map((stop) => stop.at)).toEqual([0, 500, 1000, 100, 150, 200])
    expect(candidates.y.map((stop) => stop.at)).toEqual([0, 400, 800, 200, 225, 250])
  })

  it('leaves out whatever is being moved, so a shape cannot snap to itself', () => {
    const scene = doc([box('a', { transform: { x: 100, y: 200 } })])
    const candidates = snapCandidates(scene, 0, new Set(['a']))
    expect(candidates.x.map((stop) => stop.at)).toEqual([0, 500, 1000])
  })

  it('aligns a left edge to a neighbour’s left edge and says which one', () => {
    const candidates: SnapCandidates = { x: [{ at: 300, from: frame }], y: [] }
    const result = snapDelta({ x: 297, y: 0, width: 50, height: 50 }, candidates, 5)
    expect(result.dx).toBe(3)
    expect(result.guides).toEqual([{ axis: 'x', at: 300, from: frame }])
  })

  it('takes the nearest of several stops', () => {
    const candidates: SnapCandidates = { x: [{ at: 300, from: frame }, { at: 296, from: frame }], y: [] }
    expect(snapDelta({ x: 297, y: 0, width: 50, height: 50 }, candidates, 5).dx).toBe(-1)
  })

  it('snaps a centre and a bottom as readily as a left and a top', () => {
    const candidates: SnapCandidates = { x: [{ at: 500, from: frame }], y: [{ at: 800, from: frame }] }
    // The box's own centre is at 498 and its bottom at 802.
    const result = snapDelta({ x: 448, y: 752, width: 100, height: 50 }, candidates, 5)
    expect(result.dx).toBe(2)
    expect(result.dy).toBe(-2)
  })

  it('does nothing past the threshold, which is what makes a drag feel free', () => {
    const candidates: SnapCandidates = { x: [{ at: 300, from: frame }], y: [] }
    // Left 280, centre 285, right 290 -- the nearest is 10 units from the stop at 300.
    expect(snapDelta({ x: 280, y: 0, width: 10, height: 10 }, candidates, 5)).toMatchObject({ dx: 0, guides: [] })
  })

  it('falls back to the grid only on an axis nothing else claimed', () => {
    const candidates: SnapCandidates = { x: [{ at: 300, from: frame }], y: [] }
    const result = snapDelta({ x: 297, y: 91, width: 50, height: 50 }, candidates, 5, 8)
    // x aligned to a real edge; y had no neighbour, so the grid took it to 88.
    expect(result.dx).toBe(3)
    expect(result.dy).toBe(-3)
    expect(result.guides).toHaveLength(1)
  })

  it('is off unless a grid is given', () => {
    expect(snapDelta({ x: 91, y: 91, width: 10, height: 10 }, { x: [], y: [] }, 5)).toMatchObject({ dx: 0, dy: 0 })
  })
})

describe('a selection’s own rectangle', () => {
  it('is the union of its visible leaves', () => {
    const scene = doc([box('a', { transform: { x: 0, y: 0 } }), box('b', { transform: { x: 200, y: 100 } })])
    expect(selectionBounds(scene, ['a', 'b'])).toEqual({ x: 0, y: 0, width: 300, height: 150 })
  })

  it('is undefined when nothing visible is selected', () => {
    const scene = doc([box('a', { hidden: true })])
    expect(selectionBounds(scene, ['a'])).toBeUndefined()
  })
})

describe('a rubber band', () => {
  it('takes everything it touches, at its outermost level', () => {
    const scene = doc([box('a'), group('g', [box('b', { transform: { x: 400, y: 0 } })])])
    expect(nodesInRect(scene, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual(['a', 'g'])
  })

  it('takes nothing it merely passes near', () => {
    const scene = doc([box('a', { transform: { x: 0, y: 0 } })])
    expect(nodesInRect(scene, { x: 500, y: 500, width: 10, height: 10 })).toEqual([])
  })

  it('leaves a locked node alone, as a click does', () => {
    const scene = doc([box('a', { locked: true })])
    expect(nodesInRect(scene, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual([])
  })
})

describe('ratioLockedBox', () => {
  it('follows the axis that changed more relative to its own size', () => {
    // A wide, short text: +10 in height is 42% while +20 in width is 7%, so height leads.
    const next = ratioLockedBox({ x: 0, y: 0, width: 300, height: 24, rotation: 0 }, { x: 0, y: 0, width: 320, height: 34, rotation: 0 })
    expect(next.height).toBe(34)
    expect(next.width).toBeCloseTo(425)
  })

  it('holds the ratio when width leads, and keeps the other attributes', () => {
    const next = ratioLockedBox({ x: 5, y: 6, width: 100, height: 50, rotation: 0 }, { x: 5, y: 6, width: 150, height: 55, rotation: 0 })
    expect(next).toEqual({ x: 5, y: 6, width: 150, height: 75, rotation: 0 })
  })

  it('does not flip between axes for a steady diagonal drag on a short box', () => {
    const start = { x: 0, y: 0, width: 300, height: 24, rotation: 0 }
    const scales = [1, 2, 3, 4, 5].map((step) =>
      ratioLockedBox(start, { ...start, width: 300 + step * 10, height: 24 + step * 10 }).width / 300,
    )
    for (let index = 1; index < scales.length; index += 1) expect(scales[index]!).toBeGreaterThan(scales[index - 1]!)
  })

  it('returns a degenerate box unchanged', () => {
    const next = { x: 0, y: 0, width: 40, height: 10, rotation: 0 }
    expect(ratioLockedBox({ ...next, width: 0, height: 24 }, next)).toBe(next)
  })

  it('holds the corner opposite the dragged one still, on a tilted box (the counter)', () => {
    const rotation = (3 * Math.PI) / 180
    const corner = (box: { x: number; y: number; width: number; height: number }) => ({
      x: box.x + box.width * Math.cos(rotation) - box.height * Math.sin(rotation),
      y: box.y + box.width * Math.sin(rotation) + box.height * Math.cos(rotation),
    })
    const old = { x: 100, y: 100, width: 44, height: 44, rotation }
    // Dragging the top-left handle up and left, unevenly: Konva's box keeps the bottom-right corner.
    const pointer = { x: 90, y: 80, width: 54, height: 64, rotation }
    const bottomRight = corner(pointer)
    const locked = ratioLockedBox(old, pointer, { u: 1, v: 1 })
    expect(locked.width).toBeCloseTo(locked.height)
    expect(corner(locked).x).toBeCloseTo(bottomRight.x)
    expect(corner(locked).y).toBeCloseTo(bottomRight.y)
  })
})

describe('sideAnchorsFit', () => {
  it('hides the side anchors once they would overlap the corners', () => {
    expect(sideAnchorsFit(15, 8)).toBe(false)
    expect(sideAnchorsFit(23.9, 8)).toBe(false)
    expect(sideAnchorsFit(24, 8)).toBe(true)
  })

  it('measures a mirrored box by its magnitude', () => {
    expect(sideAnchorsFit(-40, 8)).toBe(true)
  })
})

describe('liveFold', () => {
  it('returns the geometry the commit will fold to, and leaves the source alone', () => {
    const scene = doc([box('a', { strokeWidth: 6 })])
    const source = shape(scene, 'a')
    const live = liveFold(source, 1.5, 0.5)
    expect(live).toMatchObject({ width: 150, height: 25, strokeWidth: 6 })
    expect(live.transform.scaleX).toBe(1)
    expect(source).toMatchObject({ width: 100, height: 50 })
    expect(source.transform.scaleX).toBe(1)
  })

  it('keeps a mirror on the transform while the magnitude folds', () => {
    const scene = doc([box('a')])
    const live = liveFold(shape(scene, 'a'), -2, 1)
    expect(live).toMatchObject({ width: 200 })
    expect(live.transform.scaleX).toBe(-1)
  })
})

describe('inverseScale', () => {
  it('puts an ellipse centre where the committed shape will be, not scale² along', () => {
    // 100 wide, stretched ×1.5: the folded child is 150 wide with its centre at 75.
    const child = inverseScale(75, 25, 1.5, 1)
    // The group then multiplies the position back by 1.5, so the centre lands at 75 — not 112.5.
    expect(child.x * 1.5).toBeCloseTo(75)
    expect(child.scaleX * 1.5).toBeCloseTo(1)
    expect(child).toMatchObject({ y: 25, scaleY: 1 })
  })

  it('divides by the magnitude and leaves the mirror to the group', () => {
    expect(inverseScale(40, 10, -2, -0.5)).toEqual({ x: 20, y: 20, scaleX: 0.5, scaleY: 2 })
  })

  it('treats a collapsed scale as no scale rather than dividing by zero', () => {
    expect(inverseScale(10, 10, 0, 0)).toEqual({ x: 10, y: 10, scaleX: 1, scaleY: 1 })
  })
})

describe('selectionPadding', () => {
  it('puts a 1px outline wholly outside the widest stroke, in screen pixels', () => {
    // A 6-unit stroke at 50% is 3px on screen, half of it outside the geometry; the line adds half itself.
    expect(selectionPadding([2, 6], 0.5)).toBe(2)
  })

  it('still clears the geometry by half the line when nothing has a stroke', () => {
    expect(selectionPadding([], 2)).toBe(0.5)
    expect(selectionPadding([0], 2)).toBe(0.5)
  })

  it('grows with zoom, which is why it is recomputed on every camera change', () => {
    expect(selectionPadding([4], 2)).toBeGreaterThan(selectionPadding([4], 1))
  })
})

describe('expandedQuad', () => {
  it('grows an axis-aligned box outward on every side', () => {
    expect(expandedQuad(IDENTITY_MATRIX, 100, 50, 2)).toEqual([
      { x: -2, y: -2 },
      { x: 102, y: -2 },
      { x: 102, y: 52 },
      { x: -2, y: 52 },
    ])
  })

  it('grows a rotated box along its own axes before placing it', () => {
    const quad = expandedQuad(matrixOf({ x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 90 }), 100, 50, 1)
    const first = quad[0]!
    expect(first.x).toBeCloseTo(11)
    expect(first.y).toBeCloseTo(-1)
  })
})

describe('handles for every shape type (emoji: corners only, keep ratio)', () => {
  it('gives an emoji its four corners only, because a side could only stretch the glyph', () => {
    expect(anchorsFor(['emoji'])).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
  })

  it('keeps a mixed selection with an emoji to the corners, the intersection as before', () => {
    expect(anchorsFor(['rectangle', 'emoji'])).toEqual(anchorsFor(['emoji']))
    expect(anchorsFor(['text', 'emoji'])).toEqual(anchorsFor(['emoji']))
  })

  it('leaves every other type as it was', () => {
    expect(anchorsFor(['blur'])).toEqual([...BOX_ANCHORS])
    expect(anchorsFor(['text'])).toHaveLength(8)
  })

  it('holds the ratio from a corner for text and emoji, and only for them', () => {
    expect(cornersHoldRatio(['emoji'])).toBe(true)
    expect(cornersHoldRatio(['text'])).toBe(false)
    expect(cornersHoldRatio(['text', 'emoji'])).toBe(false)
    expect(cornersHoldRatio(['emoji', 'rectangle'])).toBe(false)
    expect(cornersHoldRatio(['blur'])).toBe(false)
    expect(cornersHoldRatio([])).toBe(false)
  })
})

describe('rotateAnchorOffset (marker)', () => {
  it('puts the rotate handle the same gap outside the padded outline at any padding', () => {
    // Konva places the handle at `edge - offset + padding`; the padded outline is at `edge - padding`.
    for (const padding of [1, 8.5, 32]) {
      const handle = -rotateAnchorOffset(padding) + padding
      expect(-padding - handle).toBe(ROTATE_ANCHOR_GAP)
    }
  })
})
