import { describe, expect, it } from 'vitest'
import {
  CROP_PRESETS,
  constrainDrag,
  nodeFromDrag,
  MAX_GROUP_DEPTH,
  MIN_SHAPE_SIZE,
  BLUR_SUPPORT,
  cropForRatio,
  cropRatioFor,
  defaultCrop,
  normalizeCrop,
  applyMatrix,
  blurOverlap,
  blurWindow,
  textBaselineY,
  textCharacters,
  textLineX,
  usesOpacityBuffer,
  wrapTextLines,
  contentRect,
  decompose,
  emptyDoc,
  frameRect,
  isGroupNode,
  isKnownNode,
  matrixOf,
  multiply,
  flatten,
  outputRect,
  renderRect,
  parseSceneDoc,
  planBands,
  resolveShapes,
  shapesRect,
  type GroupNode,
  type Band,
  type Rect,
  type SceneDoc,
  type SceneNode,
} from '../src/editor/scene'
import { scaledDimension } from '../src/result/export-options'

/** The chrome band's height in design units — both templates are 80. */
const BAND = 80

function doc(overrides: Partial<SceneDoc> = {}, nodes: unknown[] = []): SceneDoc {
  return { ...parseSceneDoc({ nodes }, 1000, 800), ...overrides }
}

/** A 100×50 rectangle at the given local offset, with no stroke so its bounds are exactly its box. */
function box(id: string, x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'rectangle',
    transform: { x, y },
    width: 100,
    height: 50,
    strokeWidth: 0,
    ...extra,
  }
}

function node(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'a', type: 'rectangle', transform: { x: 0, y: 0 }, width: 10, height: 10, ...overrides }
}

describe('parseSceneDoc', () => {
  it('fills a completely absent document with an empty scene over the capture', () => {
    const doc = parseSceneDoc(undefined, 800, 600, 2)
    expect(doc.capture).toEqual({ width: 800, height: 600, density: 2 })
    expect(doc.nodes).toEqual([])
    expect(doc.crop).toBeUndefined()
    expect(doc.present.on).toBe(false)
  })

  it('never throws on garbage, because losing the screenshot is worse than losing the markup', () => {
    for (const garbage of [null, 42, 'nonsense', [], { nodes: 'not an array' }]) {
      const doc = parseSceneDoc(garbage, 100, 50)
      expect(doc.capture.width).toBe(100)
      expect(doc.nodes).toEqual([])
    }
  })

  it('keeps a node whose type this build does not know, verbatim', () => {
    const future = { id: 'z', type: 'sparkle', intensity: 11, secret: { nested: true } }
    const doc = parseSceneDoc({ nodes: [future] }, 100, 100)
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0]).toEqual(future)
    expect(isKnownNode(doc.nodes[0] as SceneNode)).toBe(false)
  })

  it('drops a node with no id, because nothing can address it', () => {
    const doc = parseSceneDoc({ nodes: [node({ id: undefined }), node({ id: 'b' })] }, 100, 100)
    expect(doc.nodes.map((n) => n.id)).toEqual(['b'])
  })

  it('refuses a zero scale, which has no inverse', () => {
    const doc = parseSceneDoc({ nodes: [node({ transform: { scaleX: 0, scaleY: 0 } })] }, 100, 100)
    expect(doc.nodes[0]).toMatchObject({ transform: { scaleX: 1, scaleY: 1 } })
  })

  it('ignores a crop with no area rather than exporting a zero-pixel file', () => {
    expect(parseSceneDoc({ crop: { x: 0, y: 0, width: 0, height: 40 } }, 100, 100).crop).toBeUndefined()
    expect(parseSceneDoc({ crop: { x: 1, y: 2, width: 3, height: 4 } }, 100, 100).crop).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    })
  })

  it('round-trips a nested group with its children intact', () => {
    const doc = parseSceneDoc(
      {
        nodes: [
          {
            id: 'g',
            type: 'group',
            transform: { x: 10, y: 20 },
            children: [node({ id: 'c1' }), { id: 'g2', type: 'group', children: [node({ id: 'c2' })] }],
          },
        ],
      },
      100,
      100,
    )
    const group = doc.nodes[0] as GroupNode
    expect(isGroupNode(group)).toBe(true)
    expect(group.transform.x).toBe(10)
    expect(group.children.map((c) => c.id)).toEqual(['c1', 'g2'])
    expect((group.children[1] as GroupNode).children[0]?.id).toBe('c2')
  })

  it('keeps an over-deep group as an unknown node rather than flattening its contents away', () => {
    let deepest: Record<string, unknown> = node({ id: 'leaf' })
    for (let depth = 0; depth <= MAX_GROUP_DEPTH; depth += 1) {
      deepest = { id: `g${depth}`, type: 'group', children: [deepest] }
    }
    const doc = parseSceneDoc({ nodes: [deepest] }, 100, 100)
    // Walk down while the groups are parsed ones — a parsed group always carries a transform.
    let current: SceneNode | undefined = doc.nodes[0]
    let depth = 0
    while (current && isGroupNode(current) && 'transform' in current) {
      current = current.children[0]
      depth += 1
    }
    expect(depth).toBe(MAX_GROUP_DEPTH)
    // The node the cap bit at is kept raw, so everything below it survives a round-trip.
    expect(current?.type).toBe('group')
    expect(isKnownNode(current as SceneNode)).toBe(false)
    expect(JSON.stringify(current)).toContain('leaf')
  })

  it('seeds canvas margin and background from the present defaults', () => {
    const doc = emptyDoc(10, 10)
    expect(doc.canvas.margin).toBe(doc.present.padding)
    expect(doc.canvas.background).toBe(doc.present.background)
  })
})

describe('the resolver', () => {
  it('resolves a child through its group, and a pre-multiplied child identically', () => {
    const grouped = doc({}, [
      { id: 'g', type: 'group', transform: { x: 300, y: 200 }, children: [box('c', 10, 5)] },
    ])
    const flat = doc({}, [box('c', 310, 205)])
    expect(resolveShapes(grouped)[0]?.bounds).toEqual(resolveShapes(flat)[0]?.bounds)
  })

  it('composes rotation and scale down two levels', () => {
    const scene = doc({}, [
      {
        id: 'g',
        type: 'group',
        transform: { x: 100, y: 0, scaleX: 2, scaleY: 2 },
        children: [box('c', 0, 0, { transform: { x: 10, y: 10 } })],
      },
    ])
    const shape = resolveShapes(scene)[0]
    // The child's origin sits at 10,10 in the group, doubled and pushed right by 100.
    expect(applyMatrix(shape!.matrix, 0, 0)).toEqual({ x: 120, y: 20 })
    expect(shape!.bounds).toEqual({ x: 120, y: 20, width: 200, height: 100 })
  })

  it('multiplies opacity down the tree', () => {
    const scene = doc({}, [
      {
        id: 'g',
        type: 'group',
        opacity: 0.5,
        children: [box('c', 0, 0, { opacity: 0.5 })],
      },
    ])
    expect(resolveShapes(scene)[0]?.opacity).toBeCloseTo(0.25)
  })

  it('skips hidden nodes and everything inside a hidden group', () => {
    const scene = doc({}, [
      box('visible', 0, 0),
      box('gone', 0, 0, { hidden: true }),
      { id: 'g', type: 'group', hidden: true, children: [box('alsoGone', 0, 0)] },
    ])
    expect(resolveShapes(scene).map((shape) => shape.node.id)).toEqual(['visible'])
  })

  it('skips a node whose type it cannot read, because its bounds cannot be trusted', () => {
    const scene = doc({}, [box('known', 0, 0), { id: 'future', type: 'sparkle', width: 9000 }])
    expect(resolveShapes(scene).map((shape) => shape.node.id)).toEqual(['known'])
  })

  it("counts a shape's stroke and an arrow's head in its bounds", () => {
    const stroked = doc({}, [box('r', 0, 0, { strokeWidth: 10 })])
    expect(shapesRect(stroked)).toEqual({ x: -5, y: -5, width: 110, height: 60 })

    const arrow = doc({}, [
      { id: 'a', type: 'arrow', transform: { x: 0, y: 0 }, points: [0, 0, 100, 0], strokeWidth: 2, headSize: 20, style: 'line' },
    ])
    // A Line arrow's chevron reaches `headSize · 0.65` sideways, plus its round cap.
    expect(shapesRect(arrow)).toEqual({ x: -14, y: -14, width: 128, height: 28 })
  })

  it('grows the bounding box of a rotated shape', () => {
    const square = doc({}, [box('r', 0, 0, { width: 100, height: 100, transform: { rotation: 45 } })])
    const bounds = shapesRect(square) as Rect
    expect(bounds.width).toBeCloseTo(Math.SQRT2 * 100)
    expect(bounds.height).toBeCloseTo(Math.SQRT2 * 100)
  })
})

describe('decompose', () => {
  it('recovers the transform a matrix was built from', () => {
    const transform = { x: 12, y: -34, scaleX: 2, scaleY: 3, rotation: 30 }
    const back = decompose(matrixOf(transform))
    expect(back.x).toBeCloseTo(12)
    expect(back.y).toBeCloseTo(-34)
    expect(back.scaleX).toBeCloseTo(2)
    expect(back.scaleY).toBeCloseTo(3)
    expect(back.rotation).toBeCloseTo(30)
    expect(back.skewX).toBeCloseTo(0)
  })

  it('reports a shear as a shear rather than absorbing it into the scale', () => {
    // Rotating a group and then scaling a rotated child non-uniformly produces a skew that
    // position-scale-rotation alone cannot express. This is why the resolver emits a matrix.
    const outer = matrixOf({ x: 0, y: 0, scaleX: 2, scaleY: 1, rotation: 0 })
    const inner = matrixOf({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 45 })
    const skewed = decompose(multiply(outer, inner))
    expect(Math.abs(skewed.skewX)).toBeGreaterThan(0.1)
  })

  it('keeps a mirror as a negative scale rather than un-flipping it', () => {
    expect(decompose(matrixOf({ x: 0, y: 0, scaleX: 1, scaleY: -1, rotation: 0 })).scaleY).toBeCloseTo(-1)
  })
})

describe('the four derived rectangles', () => {
  it('is the capture with Present off, and the capture plus the band above it with Present on', () => {
    const plain = doc({}, [])
    expect(frameRect(plain, BAND)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })

    const presented = parseSceneDoc({ present: { on: true }, capture: { density: 2 } }, 1000, 800, 2)
    // The band is design units times capture density, with no export scale in it.
    expect(frameRect(presented, BAND)).toEqual({ x: 0, y: -160, width: 1000, height: 960 })
  })

  it('grows the output when a shape leaves the frame, and narrows it again when it goes', () => {
    const margin = { ...emptyDoc(1000, 800), canvas: { background: 'none' as const, customColor: '#fff', margin: 0 } }
    const plain = outputRect(margin, BAND)
    expect(plain).toEqual({ x: 0, y: 0, width: 1000, height: 800 })

    const escaped = { ...margin, nodes: parseSceneDoc({ nodes: [box('r', 1050, 0)] }, 1000, 800).nodes }
    expect(outputRect(escaped, BAND)).toEqual({ x: 0, y: 0, width: 1150, height: 800 })

    // Derived, never accumulated: deleting the shape returns the original bounds exactly.
    expect(outputRect({ ...escaped, nodes: [] }, BAND)).toEqual(plain)
  })

  it('excludes a hidden shape from the bounds, because a hidden shape is not in the picture', () => {
    const base = { ...emptyDoc(1000, 800), canvas: { background: 'none' as const, customColor: '#fff', margin: 0 } }
    const shown = { ...base, nodes: parseSceneDoc({ nodes: [box('r', 1050, 0)] }, 1000, 800).nodes }
    const hidden = { ...base, nodes: parseSceneDoc({ nodes: [box('r', 1050, 0, { hidden: true })] }, 1000, 800).nodes }
    expect(outputRect(shown, BAND).width).toBe(1150)
    expect(outputRect(hidden, BAND).width).toBe(1000)
  })

  it('applies the margin whether or not Present is on', () => {
    const base = parseSceneDoc({ canvas: { margin: 10 } }, 100, 100, 1)
    expect(outputRect(base, BAND)).toEqual({ x: -10, y: -10, width: 120, height: 120 })

    const presented = { ...base, present: { ...base.present, on: true } }
    expect(outputRect(presented, BAND)).toEqual({ x: -10, y: -90, width: 120, height: 200 })
  })

  it('sizes a framed export by scaling the complete scene once, as the editor does', () => {
    // Moved from the retired `presentExportSize`. Rounding the frame and the capture separately gave
    // 664 × 890 for this fractional case; the whole scene, pixel-aligned then scaled, is 665 × 891.
    const scene = parseSceneDoc({ present: { on: true }, canvas: { margin: 32 }, capture: { density: 1.3 } }, 803, 1001, 1.3)
    const output = renderRect(scene, BAND)
    expect({ width: scaledDimension(output.width, 0.75), height: scaledDimension(output.height, 0.75) }).toEqual({
      width: 665,
      height: 891,
    })
  })

  it('scales the margin by the capture density, so it is the same page-pixels at any DPR', () => {
    const retina = parseSceneDoc({ canvas: { margin: 10 }, capture: { density: 2 } }, 100, 100, 2)
    expect(outputRect(retina, BAND)).toEqual({ x: -20, y: -20, width: 140, height: 140 })
  })

  it('lets a crop win outright: contentRect is not consulted at all', () => {
    const cropped = parseSceneDoc(
      { crop: { x: 100, y: 100, width: 200, height: 200 }, canvas: { margin: 64 }, nodes: [box('r', 5000, 0)] },
      1000,
      800,
    )
    // The escaped shape still widens contentRect...
    expect(contentRect(cropped, BAND).width).toBeGreaterThan(5000)
    // ...and changes the output by nothing, and the margin is not applied over it either.
    expect(outputRect(cropped, BAND)).toEqual({ x: 100, y: 100, width: 200, height: 200 })
  })

  it('clips rather than deletes: clearing the crop brings the full picture back', () => {
    const cropped = parseSceneDoc({ crop: { x: 10, y: 10, width: 20, height: 20 }, canvas: { margin: 0 } }, 400, 300)
    expect(outputRect(cropped, BAND)).toEqual({ x: 10, y: 10, width: 20, height: 20 })
    const cleared: SceneDoc = { ...cropped }
    delete cleared.crop
    expect(outputRect(cleared, BAND)).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    // The shape a crop excluded was never removed from the document.
    expect(cropped.nodes).toEqual(cleared.nodes)
  })

  it('gives both raster renderers one pixel-aligned allocation for fractional bounds', () => {
    const scene = parseSceneDoc(
      { crop: { x: -1.2, y: 2.4, width: 10.1, height: 20.2 } },
      100,
      100,
    )
    expect(renderRect(scene, BAND)).toEqual({ x: -2, y: 2, width: 11, height: 21 })
  })
})

/** A blur node with the given local box and radius. */
function blur(id: string, y: number, radius: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'blur', transform: { x: 0, y }, width: 100, height: 100, radius, ...extra }
}

describe('the render walk', () => {
  it('emits backdrop, capture and every leaf, and never a group', () => {
    const scene = doc({}, [
      box('under', 0, 0),
      { id: 'g', type: 'group', transform: { x: 10, y: 10 }, children: [box('inside', 0, 0), box('deep', 5, 5)] },
      box('over', 0, 0),
    ])
    const ops = flatten(scene, BAND)
    expect(ops.map((op) => op.kind)).toEqual(['backdrop', 'capture', 'shape', 'shape', 'shape', 'shape'])
    // This is the scene module's actual contract: the tree ends inside scene.
    for (const op of ops) {
      if (op.kind === 'shape' || op.kind === 'blur') expect(op.shape.node.type).not.toBe('group')
    }
    expect(ops.flatMap((op) => (op.kind === 'shape' ? [op.shape.node.id] : []))).toEqual([
      'under',
      'inside',
      'deep',
      'over',
    ])
  })

  it('puts the chrome between the backdrop and the capture, and only when Present is on', () => {
    expect(flatten(doc({}, []), BAND).map((op) => op.kind)).toEqual(['backdrop', 'capture'])
    const presented = parseSceneDoc({ present: { on: true } }, 100, 100)
    expect(flatten(presented, BAND).map((op) => op.kind)).toEqual(['backdrop', 'chrome', 'capture'])
    // Both frame ops share one corner clip: the band and the shot round into the same card.
    const [chrome, capture] = flatten(presented, BAND).slice(1)
    expect(chrome?.kind === 'chrome' && chrome.clip).toEqual(capture?.kind === 'capture' && capture.clip)
    expect(chrome?.kind === 'chrome' && chrome.clip?.radius).toBe(8)
  })

  it('emits a blur as its own kind, not as a shape to draw', () => {
    const scene = doc({}, [blur('b', 0, 8)])
    const op = flatten(scene, BAND).find((entry) => entry.kind === 'blur')
    expect(op).toBeDefined()
    expect(op?.kind).toBe('blur')
    expect(flatten(scene, BAND).some((entry) => entry.kind === 'shape')).toBe(false)
  })

  it("reorders the reported case: whether the box is blurred is the list's order", () => {
    const boxOverBlur = doc({}, [blur('b', 0, 8), box('r', 0, 0)])
    const blurOverBox = doc({}, [box('r', 0, 0), blur('b', 0, 8)])
    expect(flatten(boxOverBlur, BAND).map((op) => op.kind)).toEqual(['backdrop', 'capture', 'blur', 'shape'])
    expect(flatten(blurOverBox, BAND).map((op) => op.kind)).toEqual(['backdrop', 'capture', 'shape', 'blur'])
  })

  it('walks through a group rather than around it, so a blur inside one still covers what is outside', () => {
    const scene = doc({}, [
      box('outside-and-below', 0, 0),
      { id: 'g', type: 'group', children: [blur('b', 0, 8)] },
    ])
    const kinds = flatten(scene, BAND).map((op) => op.kind)
    // The blur is emitted after the shape that sits outside its group, so it blurs it.
    expect(kinds).toEqual(['backdrop', 'capture', 'shape', 'blur'])
  })

  it("scales a blur's radius by the group it sits in", () => {
    const scene = doc({}, [
      { id: 'g', type: 'group', transform: { scaleX: 2, scaleY: 2 }, children: [blur('b', 0, 8)] },
    ])
    const op = flatten(scene, BAND).find((entry) => entry.kind === 'blur')
    expect(op?.kind === 'blur' && op.radius).toBe(16)
  })
})

describe('the band plan', () => {
  const tall = (height: number, nodes: unknown[] = []): SceneDoc =>
    parseSceneDoc({ canvas: { margin: 0 }, nodes }, 400, height)

  it('tiles the output exactly, with no gap and no double-count', () => {
    const bands = planBands(tall(20_000), BAND)
    expect(bands).toHaveLength(3)
    let covered = 0
    for (const band of bands) {
      expect(band.offsetY).toBe(covered)
      covered += band.height
    }
    expect(covered).toBe(20_000)
  })

  it('adds no overlap at all to a document with no blur in it', () => {
    for (const band of planBands(tall(20_000), BAND)) {
      expect(band.renderOffsetY).toBe(band.offsetY)
      expect(band.renderHeight).toBe(band.height)
    }
    expect(blurOverlap(tall(20_000))).toBe(0)
  })

  it("gives every band a blur's true support on each side", () => {
    const radius = 40
    const scene = tall(20_000, [blur('b', 8_100, radius)])
    const support = radius * BLUR_SUPPORT
    expect(blurOverlap(scene)).toBe(support)

    const middle = planBands(scene, BAND)[1] as Band
    expect(middle.renderOffsetY).toBe(middle.offsetY - support)
    expect(middle.renderOffsetY + middle.renderHeight).toBe(middle.offsetY + middle.height + support)
  })

  it('sums the supports, because a blur reading a blurred pixel reads through both', () => {
    // Overlapping blurs compound by design, so the second blur's kernel reaches
    // through the first's. A maximum would under-read by exactly the narrower blur's support.
    const scene = tall(20_000, [blur('lower', 8_100, 40), blur('upper', 8_120, 10)])
    expect(blurOverlap(scene)).toBe((40 + 10) * BLUR_SUPPORT)
  })

  it('never lets the overlap grow a render window past a whole band', () => {
    const many = Array.from({ length: 40 }, (_, index) => blur(`b${index}`, index * 10, 200))
    expect(blurOverlap(tall(20_000, many))).toBe(8_192)
  })

  it('clamps the overlap at the top and bottom of the output rather than reading past it', () => {
    const bands = planBands(tall(20_000, [blur('b', 0, 40)]), BAND)
    const first = bands[0] as (typeof bands)[number]
    const last = bands[bands.length - 1] as (typeof bands)[number]
    expect(first.renderOffsetY).toBe(0)
    expect(last.renderOffsetY + last.renderHeight).toBe(20_000)
  })

  it('gives each band every source row its own rows can read through a blur', () => {
    // A blur straddling the first boundary at 8,192. What each band needs is not the whole blur
    // region — it is every source row that any row *it owns* reads, which is its own span grown by
    // the overlap on each side. Asserting the region instead would demand a band render rows it
    // never writes.
    const straddling = tall(20_000, [blur('b', 8_150, 30)])
    const overlap = blurOverlap(straddling)
    expect(overlap).toBeGreaterThan(0)
    for (const band of planBands(straddling, BAND)) {
      const output = outputRect(straddling, BAND)
      expect(band.renderOffsetY).toBeLessThanOrEqual(Math.max(0, band.offsetY - overlap))
      expect(band.renderOffsetY + band.renderHeight).toBeGreaterThanOrEqual(
        Math.min(output.height, band.offsetY + band.height + overlap),
      )
    }
  })
})

describe('blurWindow', () => {
  const output: Rect = { x: 0, y: 0, width: 100, height: 100 }
  const support = 3 * 18

  it('grows the region by the kernel support and clips to the output', () => {
    // A support small enough that growth is visible unclipped.
    expect(blurWindow({ x: 50, y: 50, width: 20, height: 10 }, output, 6)).toEqual({
      x: 44,
      y: 44,
      width: 32,
      height: 22,
    })
    // The audit-diagnostic shape with the preview's real support: the grown window covers the
    // whole output rather than escaping past it.
    expect(blurWindow({ x: 50, y: 50, width: 20, height: 10 }, output, support)).toEqual(output)
  })

  it('is undefined for a blur entirely outside the output', () => {
    // The audit's diagnostic: a committed 100 × 100 crop and a distant blur used to produce a
    // negative-size window, and an OffscreenCanvas that refuses to exist threw the render away.
    expect(blurWindow({ x: 300, y: 300, width: 50, height: 50 }, output, support)).toBeUndefined()
    expect(blurWindow({ x: -200, y: 40, width: 50, height: 50 }, output, support)).toBeUndefined()
  })

  it('stays positive for a blur hanging over the edge', () => {
    const window = blurWindow({ x: 90, y: 40, width: 50, height: 20 }, output, support)
    expect(window).toBeDefined()
    expect(window!.width).toBeGreaterThan(0)
    expect(window!.height).toBeGreaterThan(0)
    // The region's own left edge is 36 scene units into the grown window; the clip happens at the
    // output's right edge, which the blur hangs over.
    expect(window!.x).toBe(90 - support)
    expect(window!.x + window!.width).toBe(100)
  })
})

describe('crop, as a mode', () => {
  it('opens on the whole picture, which is the content rather than the crop', () => {
    const scene = doc({}, [box('a', 2000, 100)])
    // A shape past the capture's right edge grows `contentRect`, and the mode must open on all of it.
    expect(defaultCrop(scene, BAND)).toEqual(contentRect(scene, BAND))
    expect(defaultCrop(scene, BAND).width).toBe(2100)
  })

  it('opens on the whole picture even when a crop is already set', () => {
    // `outputRect` *is* the crop once one exists, so an implementation reading it could never get
    // back to the whole picture — `Free` after a crop would be a no-op.
    const scene = doc({ crop: { x: 10, y: 10, width: 20, height: 20 } })
    expect(defaultCrop(scene, BAND)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })

  it("reads `original` off the capture, not off an output a stray arrow has grown", () => {
    const scene = doc({}, [box('a', 5000, 0)])
    expect(cropRatioFor('original', scene)).toBeCloseTo(1000 / 800)
    expect(cropRatioFor('free', scene)).toBeUndefined()
    expect(cropRatioFor('16:9', scene)).toBeCloseTo(16 / 9)
    // Every preset the inspector offers resolves; `free` is the only one with no ratio.
    const ratios = CROP_PRESETS.map((preset) => cropRatioFor(preset, scene))
    expect(ratios.filter((ratio) => ratio === undefined)).toHaveLength(1)
  })

  it('fits a ratio inside the rectangle and centres it, rather than growing off the picture', () => {
    // 16:9 on a tall crop must lose height, not gain width.
    const fitted = cropForRatio({ x: 0, y: 0, width: 400, height: 1000 }, 16 / 9)
    expect(fitted.width).toBe(400)
    expect(fitted.height).toBeCloseTo(225)
    expect(fitted.x).toBe(0)
    expect(fitted.y).toBeCloseTo(387.5)
  })

  it('loses width instead when the rectangle is the wide one', () => {
    const fitted = cropForRatio({ x: 100, y: 50, width: 1000, height: 200 }, 1)
    expect(fitted).toEqual({ x: 500, y: 50, width: 200, height: 200 })
  })

  it('leaves the rectangle alone for a free crop', () => {
    const rect = { x: 3, y: 4, width: 5, height: 6 }
    expect(cropForRatio(rect, undefined)).toEqual(rect)
  })

  it('resolves a handle dragged past the opposite edge into the origin', () => {
    // A shape would keep the mirror; a crop has nothing to mirror.
    expect(normalizeCrop({ x: 300, y: 200, width: -100, height: -50 })).toEqual({
      x: 200,
      y: 150,
      width: 100,
      height: 50,
    })
  })

  it('refuses to produce a crop with no area, which `parseCrop` would then discard', () => {
    const tiny = normalizeCrop({ x: 0, y: 0, width: 0, height: 1 })
    expect(tiny.width).toBe(MIN_SHAPE_SIZE)
    expect(tiny.height).toBe(MIN_SHAPE_SIZE)
    expect(parseSceneDoc({ crop: tiny }, 100, 100).crop).toEqual(tiny)
  })
})

describe('text and arrow layout shared by both renderers', () => {
  // A monospace stand-in for measureText: every character is 10 units wide.
  const measure = (run: string): number => [...run].length * 10

  it('keeps a paragraph that fits verbatim, repeated spaces included', () => {
    expect(wrapTextLines('a  b', 100, measure)).toEqual([{ text: 'a  b', width: 40 }])
  })

  it('breaks at the last space that fits and trims the break', () => {
    expect(wrapTextLines('hello big world', 100, measure).map((line) => line.text)).toEqual(['hello big', 'world'])
  })

  it('breaks after a dash as Konva does', () => {
    expect(wrapTextLines('well-known', 60, measure).map((line) => line.text)).toEqual(['well-', 'known'])
  })

  it('breaks a single word wider than the box mid-word, where the old export overflowed', () => {
    expect(wrapTextLines('abcdefghij', 40, measure).map((line) => line.text)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('keeps each newline as its own paragraph', () => {
    expect(wrapTextLines('one\ntwo', 100, measure).map((line) => line.text)).toEqual(['one', 'two'])
  })

  it('keeps an emoji with its skin-tone modifier as one character', () => {
    expect(textCharacters('a👍🏽b')).toEqual(['a', '👍🏽', 'b'])
  })

  it('places baselines from the font box, one line height apart', () => {
    expect(textBaselineY(0, 24, 18, 6)).toBe(18)
    expect(textBaselineY(2, 24, 18, 6)).toBe(66)
  })

  it('offsets a line for centre and right alignment', () => {
    expect(textLineX('left', 100, 40)).toBe(0)
    expect(textLineX('center', 100, 40)).toBe(30)
    expect(textLineX('right', 100, 40)).toBe(60)
  })

})

describe('usesOpacityBuffer: Konva draws a semi-transparent fill-and-stroke shape once', () => {
  const box = { id: 'b', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, width: 10, height: 10, stroke: '#E11900', strokeWidth: 4, radius: 0, opacity: 1 }

  it('buffers a stroked arrow below full opacity, whose curve and chevron overlap; a solid one is one polygon', () => {
    const arrow = { id: 'a', type: 'arrow', transform: box.transform, points: [0, 0, 50, 0], stroke: '#E11900', strokeWidth: 4, headSize: 12, opacity: 0.5, style: 'line', size: 100 } as const
    expect(usesOpacityBuffer(arrow, 0.5)).toBe(true)
    expect(usesOpacityBuffer(arrow, 1)).toBe(false)
    expect(usesOpacityBuffer({ ...arrow, style: 'solid' }, 0.5)).toBe(false)
  })

  it('buffers a rectangle or ellipse only when it both fills and strokes', () => {
    expect(usesOpacityBuffer({ ...box, type: 'rectangle', fill: '#2a7fff' }, 0.5)).toBe(true)
    expect(usesOpacityBuffer({ ...box, type: 'rectangle', fill: 'none' }, 0.5)).toBe(false)
    expect(usesOpacityBuffer({ ...box, type: 'ellipse', fill: '#2a7fff', stroke: 'none' }, 0.5)).toBe(false)
    expect(usesOpacityBuffer({ ...box, type: 'ellipse', fill: '#2a7fff' }, 0.5)).toBe(true)
  })

  it('never buffers a line, text or highlight, which Konva draws with one of fill or stroke', () => {
    const line = { id: 'l', type: 'line', transform: box.transform, points: [0, 0, 50, 0], stroke: '#E11900', strokeWidth: 4, opacity: 0.5 } as const
    expect(usesOpacityBuffer(line, 0.5)).toBe(false)
  })
})

/**
 * Shift constrains the drag, Alt draws from the centre. The
 * editor applies this to the draft and again to the commit, so a defect here draws one shape and
 * saves a different one.
 */
describe('the modifiers held while drawing', () => {
  const free = { shift: false, alt: false }
  const shift = { shift: true, alt: false }
  const at = (x: number, y: number) => ({ x, y })

  it('leaves an unmodified drag exactly as it was', () => {
    expect(constrainDrag('rectangle', at(10, 10), at(90, 40), free)).toEqual({
      start: at(10, 10),
      end: at(90, 40),
    })
  })

  it('squares a box tool off the longer axis, in whichever direction it was drawn', () => {
    expect(constrainDrag('rectangle', at(10, 10), at(90, 40), shift).end).toEqual(at(90, 90))
    // Up and to the left: the square has to follow the pointer, not flip across the press.
    expect(constrainDrag('ellipse', at(100, 100), at(20, 60), shift).end).toEqual(at(20, 20))
  })

  it('steps a line or an arrow in 45s, keeping the length the pointer asked for', () => {
    // 20 degrees rounds down to 0: a flat line of the same length.
    const flat = constrainDrag('line', at(0, 0), at(93.97, 34.2), shift).end
    expect(flat.x).toBeCloseTo(100)
    expect(flat.y).toBeCloseTo(0)
    // 50 degrees rounds up to 45.
    const diagonal = constrainDrag('arrow', at(0, 0), at(64.28, 76.6), shift).end
    expect(diagonal.x).toBeCloseTo(diagonal.y)
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(100)
  })

  it('draws from the centre under Alt, so the press point is the middle', () => {
    const drag = constrainDrag('rectangle', at(50, 50), at(80, 70), { shift: false, alt: true })
    expect(drag.start).toEqual(at(20, 30))
    expect(drag.end).toEqual(at(80, 70))
  })

  it('combines the two: a square centred on the press', () => {
    const drag = constrainDrag('ellipse', at(50, 50), at(80, 70), { shift: true, alt: true })
    expect(drag.end).toEqual(at(80, 80))
    expect(drag.start).toEqual(at(20, 20))
  })

  it('steps an endpoint about the other end, wherever that end happens to be', () => {
    // The endpoint handles drag one end about the other, so the anchor is rarely the origin. Same
    // function, so the angles a line can be dragged to are the angles it can be drawn at.
    const anchor = at(100, 100)
    const dragged = constrainDrag('line', anchor, at(160, 145), shift).end
    expect(dragged.x - anchor.x).toBeCloseTo(dragged.y - anchor.y)
    expect(Math.hypot(dragged.x - anchor.x, dragged.y - anchor.y)).toBeCloseTo(75)
    // Dragged back past the anchor, it steps about the anchor rather than flipping to the origin:
    // flat at y 100, and keeping the 80.4 the pointer asked for rather than the 80 of its x alone.
    const behind = constrainDrag('line', anchor, at(20, 92), shift).end
    expect(behind.y).toBeCloseTo(100)
    expect(behind.x).toBeCloseTo(100 - Math.hypot(80, 8))
  })

  it('leaves text alone, because its size comes from its content', () => {
    expect(constrainDrag('text', at(0, 0), at(200, 10), { shift: true, alt: true })).toEqual({
      start: at(0, 0),
      end: at(200, 10),
    })
  })

  it('feeds nodeFromDrag a square a squared drag actually makes', () => {
    const drag = constrainDrag('rectangle', at(10, 10), at(90, 40), shift)
    const node = nodeFromDrag('rectangle', drag.start, drag.end, 1)
    expect(node).toMatchObject({ type: 'rectangle', width: 80, height: 80 })
  })
})
