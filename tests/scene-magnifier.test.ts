import { describe, expect, it } from 'vitest'
import {
  emptyDoc,
  framePower,
  foldScale,
  hitTest,
  lensLocalRect,
  lensRect,
  localBounds,
  magnifierConnector,
  nodeFromDrag,
  parseSceneDoc,
  placeLens,
  type MagnifierNode,
} from '../src/editor/scene'

function magnifier(extra: Partial<MagnifierNode> = {}): MagnifierNode {
  const node = nodeFromDrag('magnifier', { x: 100, y: 100 }, { x: 140, y: 120 }, 1)
  if (node?.type !== 'magnifier') throw new Error('No magnifier')
  return { ...node, ...extra }
}

describe('magnifier: a source box and a lens', () => {
  it('starts with a lens three times the source, beside it on the right, centred on it', () => {
    const node = magnifier()
    expect(lensRect(node)).toEqual({ x: 164, y: 80, width: 120, height: 60 })
  })

  it('leaves the lens where it is when the source moves', () => {
    const node = magnifier()
    const before = lensRect(node)
    node.transform = { ...node.transform, x: 20, y: 300 }
    expect(lensRect(node)).toEqual(before)
    // Its place in the node's own frame follows, so the bounds still reach it.
    expect(lensLocalRect(node).x).toBe(before.x - 20)
  })

  it('stretches the lens with the source, about its centre, keeping the zoom', () => {
    const node = magnifier()
    const before = lensRect(node)
    node.transform = { ...node.transform, scaleX: 2 }
    foldScale(node)
    const after = lensRect(node)
    // Twice as wide, the same height: widening the source used to make the lens shorter.
    expect(after.width).toBe(before.width * 2)
    expect(after.height).toBe(before.height)
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2)
  })

  it('bounds the source and the lens together, for the export and the outline', () => {
    const box = localBounds(magnifier())
    expect(box.x).toBeCloseTo(-1.5)
    expect(box.x + box.width).toBeCloseTo(184 + 1.5)
  })

  it('is pressed on the source or the lens, not on the page between them', () => {
    const doc = emptyDoc(400, 300)
    const node = magnifier({ shape: 'squircle', roundness: 0 })
    doc.nodes.push(node)
    expect(hitTest(doc, 120, 110)?.id).toBe(node.id)
    expect(hitTest(doc, 224, 110)?.id).toBe(node.id)
    expect(hitTest(doc, 152, 110)).toBeUndefined()
    // The squircle lens's empty corner misses too.
    expect(hitTest(doc, 166, 82)).toBeUndefined()
  })

  it('joins the two frames edge to edge, and not at all when they overlap', () => {
    const join = magnifierConnector({ x: 0, y: 0, width: 20, height: 20 }, { x: 60, y: 0, width: 20, height: 20 }, undefined)
    expect(join).toEqual([{ x: 20, y: 10 }, { x: 60, y: 10 }])
    expect(magnifierConnector({ x: 0, y: 0, width: 20, height: 20 }, { x: 10, y: 0, width: 20, height: 20 }, undefined)).toBeUndefined()
  })

  it('rounds a squircle from nearly square (0) to an oval (100)', () => {
    expect(framePower({ shape: 'squircle', roundness: 100 })).toBe(2)
    expect(framePower({ shape: 'squircle', roundness: 0 })).toBe(10)
    expect(framePower({ shape: 'rectangle', roundness: 100 })).toBeUndefined()
  })

  it('puts a new lens on the left when the right edge of the page would cut it off', () => {
    const node = nodeFromDrag('magnifier', { x: 200, y: 100 }, { x: 240, y: 120 }, 1) as MagnifierNode
    placeLens(node, 300, 300)
    expect(lensRect(node).x).toBe(200 - 24 - 120)
    // And no further than the page's own left edge.
    const cornered = magnifier()
    placeLens(cornered, 250, 300)
    expect(lensRect(cornered).x).toBe(0)
  })

  it('reads a saved magnifier back, the first build\'s oval as a squircle, and fills in what an older one lacks', () => {
    const doc = parseSceneDoc({ nodes: [{ id: 'm', type: 'magnifier', width: 10, height: 20, lens: { x: 5, y: 6, zoom: 4 }, shape: 'ellipse', roundness: 40 }] }, 100, 100)
    expect(doc.nodes[0]).toMatchObject({ type: 'magnifier', lens: { x: 5, y: 6, zoom: 4 }, shape: 'squircle', roundness: 40 })
    const bare = parseSceneDoc({ nodes: [{ id: 'm', type: 'magnifier', width: 10, height: 20 }] }, 100, 100)
    expect(bare.nodes[0]).toMatchObject({ shape: 'rectangle', roundness: 85, lens: { zoom: 3 } })
  })
})
