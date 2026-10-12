import { describe, expect, it } from 'vitest'
import { arrowWeights, arrowCurve, arrowMiddle, arrowPath, arrowShapeHit, localBounds, parseSceneDoc, type ArrowNode, type ArrowSink } from '../src/editor/scene'

const arrow = (extra: Partial<ArrowNode> = {}): ArrowNode => ({
  id: 'a',
  type: 'arrow',
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  points: [0, 0, 200, 0],
  stroke: '#E11900',
  strokeWidth: 10,
  headSize: 30,
  opacity: 1,
  style: 'solid',
  size: 100,
  ...extra,
})

/** Every point the path visits, in order, and whether it closed. */
function trace(node: ArrowNode): { points: Array<{ x: number; y: number }>; closed: boolean; moves: number } {
  const points: Array<{ x: number; y: number }> = []
  let closed = false
  let moves = 0
  const sink: ArrowSink = {
    beginPath: () => undefined,
    moveTo: (x, y) => {
      moves += 1
      points.push({ x, y })
    },
    lineTo: (x, y) => points.push({ x, y }),
    quadraticCurveTo: (_cx, _cy, x, y) => points.push({ x, y }),
    closePath: () => {
      closed = true
    },
  }
  arrowPath(sink, node)
  return { points, closed, moves }
}

describe('arrow: three styles and a bend handle', () => {
  it('puts the middle handle on the curve, halfway between the ends', () => {
    const node = arrow({ bend: { x: 0, y: 40 } })
    const [start, control, end] = arrowCurve(node)
    const halfway = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }
    expect(arrowMiddle(node)).toEqual(halfway)
  })

  it('bounds a bent arrow by where the curve goes, not by its control point', () => {
    const box = localBounds(arrow({ bend: { x: 0, y: 40 } }))
    // The curve peaks at the handle, y = 40, plus half the head (48, from a 200-long arrow); the
    // control point is at 80.
    expect(box.y + box.height).toBeCloseTo(40 + 24)
  })

  it('draws a solid arrow as one closed polygon: narrow tail, wide neck, tip on the end point', () => {
    // 200 long at Size 100: a 16 neck (8% of the length) and a 48 head (three necks).
    const { points, closed, moves } = trace(arrow())
    expect(closed).toBe(true)
    expect(moves).toBe(1)
    expect(points).toContainEqual({ x: 200, y: 0 })
    const tail = Math.abs(points[0]?.y ?? 0)
    expect(tail).toBeCloseTo(4.8)
    // The neck, full weight, and the head's shoulders share the base line x = 152.
    const base = points.filter((point) => Math.abs(point.x - 152) < 1e-9).map((point) => Math.abs(point.y))
    expect(base.sort((a, b) => a - b)).toEqual([8, 8, 24, 24])
  })

  it('makes a solid arrow bolder as it gets longer, and Size scales that', () => {
    expect(arrowWeights(arrow({ points: [0, 0, 100, 0] })).strokeWidth).toBeCloseTo(8)
    expect(arrowWeights(arrow({ points: [0, 0, 300, 0] })).strokeWidth).toBeCloseTo(24)
    expect(arrowWeights(arrow({ points: [0, 0, 300, 0], size: 50 })).strokeWidth).toBeCloseTo(12)
    // Clamped at both ends, and a Line arrow keeps its own weight.
    expect(arrowWeights(arrow({ points: [0, 0, 5, 0] })).strokeWidth).toBe(2)
    expect(arrowWeights(arrow({ points: [0, 0, 9000, 0] })).strokeWidth).toBe(120)
    expect(arrowWeights(arrow({ style: 'line' }))).toEqual({ strokeWidth: 10, headSize: 30 })
  })

  it('gives a line arrow one chevron and a double arrow two, both open', () => {
    expect(trace(arrow({ style: 'line' }))).toMatchObject({ closed: false, moves: 2 })
    expect(trace(arrow({ style: 'double' }))).toMatchObject({ closed: false, moves: 3 })
  })

  it('reads an arrow saved before styles as solid and straight, at the Size that keeps its weight', () => {
    const doc = parseSceneDoc({ nodes: [{ id: 'a', type: 'arrow', points: [0, 0, 100, 0], strokeWidth: 12 }] }, 100, 100)
    expect(doc.nodes[0]).toMatchObject({ style: 'solid', size: 150 })
    expect(doc.nodes[0]).not.toHaveProperty('bend')
  })
})

describe('arrowShapeHit: a click in the empty part of the box misses', () => {
  it('hits the curve and the head, and misses the empty corner of a bent arrow\'s box', () => {
    const node = arrow({ points: [0, 0, 200, 100], bend: { x: -40, y: 40 } })
    const middle = arrowMiddle(node)
    expect(arrowShapeHit(node, middle.x, middle.y)).toBe(true)
    expect(arrowShapeHit(node, 195, 98)).toBe(true)
    expect(arrowShapeHit(node, 190, 5)).toBe(false)
  })

  it('reads a head at the tail only on a double arrow', () => {
    expect(arrowShapeHit(arrow({ style: 'double' }), -10, 8)).toBe(true)
    expect(arrowShapeHit(arrow({ style: 'line' }), -10, 8)).toBe(false)
  })
})
