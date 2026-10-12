import { describe, expect, it } from 'vitest'
import {
  foldScale,
  localBounds,
  parseSceneDoc,
  resampleStroke,
  smoothStroke,
  STROKE_MAX_POINTS,
  type FreehandNode,
} from '../src/editor/scene'

function stroke(points: number[], extra: Partial<FreehandNode> = {}): FreehandNode {
  return {
    id: 'f',
    type: 'freehand',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    points,
    stroke: '#1D6BE5',
    strokeWidth: 4,
    opacity: 1,
    ...extra,
  }
}

/** Distances between consecutive points, which is what resampling is supposed to even out. */
function gaps(points: readonly number[]): number[] {
  const out: number[] = []
  for (let index = 2; index + 1 < points.length; index += 2) {
    out.push(Math.hypot((points[index] ?? 0) - (points[index - 2] ?? 0), (points[index + 1] ?? 0) - (points[index - 1] ?? 0)))
  }
  return out
}

describe('resampling a stroke', () => {
  it('walks a long segment rather than emitting one point for it', () => {
    // The defect this guards: a fast flick arrives as two samples 100 apart, and a resampler that
    // emitted one point per input sample would leave the whole flick as a single straight jump.
    const out = resampleStroke([0, 0, 100, 0], 10)
    expect(out.length / 2).toBeGreaterThan(9)
    for (const gap of gaps(out)) expect(gap).toBeCloseTo(10, 5)
  })

  it('evens out a path sampled densely in one half and sparsely in the other', () => {
    // A slow careful curve then a fast flick: ten samples over the first 10 units, one over the next 90.
    const raw = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 100, 0]
    const out = resampleStroke(raw, 10)
    const spans = gaps(out).slice(0, -1)
    for (const gap of spans) expect(gap).toBeCloseTo(10, 5)
  })

  it('always keeps the last raw point, because that is where the pointer was lifted', () => {
    const out = resampleStroke([0, 0, 25, 0], 10)
    expect(out.slice(-2)).toEqual([25, 0])
  })

  it('survives a click and a single sample without inventing a stroke', () => {
    expect(resampleStroke([], 4)).toEqual([])
    expect(resampleStroke([7, 9], 4)).toEqual([7, 9])
  })

  it('refuses to run away on a huge path', () => {
    const out = resampleStroke([0, 0, 10_000_000, 0], 1)
    expect(out.length / 2).toBeLessThanOrEqual(STROKE_MAX_POINTS + 1)
  })
})

describe('smoothing a stroke', () => {
  it('pulls a single-sample spike back towards its neighbours', () => {
    // One point kicked off the line is the tremor this removes.
    const raw = [0, 0, 10, 0, 20, 30, 30, 0, 40, 0]
    const out = smoothStroke(raw, 10)
    const spike = out.findIndex((_value, index) => index % 2 === 1 && (out[index] ?? 0) > 15)
    const peak = spike === -1 ? 0 : (out[spike] ?? 0)
    expect(peak).toBeLessThan(30)
  })

  it('pins both ends, so a stroke still ends where the pointer was lifted', () => {
    const raw = [0, 0, 10, 20, 20, -20, 30, 20, 40, 0]
    const out = smoothStroke(raw, 10)
    expect(out.slice(0, 2)).toEqual([0, 0])
    expect(out.slice(-2)).toEqual([40, 0])
  })

  it('leaves a straight line straight', () => {
    const out = smoothStroke([0, 0, 50, 0], 10)
    for (let index = 1; index < out.length; index += 2) expect(out[index]).toBeCloseTo(0, 6)
  })

  it('does not lose a stroke too short to smooth', () => {
    expect(smoothStroke([5, 5, 6, 6], 10)).toEqual([5, 5, 6, 6])
  })
})

describe('a stroke in the scene', () => {
  it('bounds itself over every point, not just its ends, with room for the stroke width', () => {
    // A stroke's extremes are wherever the hand went. Bounding only the ends would let the export
    // clip the middle of an arc away.
    const box = localBounds(stroke([0, 0, 50, -40, 100, 0]))
    expect(box.x).toBe(-2)
    expect(box.y).toBe(-42)
    expect(box.width).toBe(104)
    expect(box.height).toBe(44)
  })

  it('has empty bounds when it has no points, rather than NaN ones', () => {
    expect(localBounds(stroke([]))).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('stretches its points on a resize, as a segment does', () => {
    const node = stroke([0, 0, 10, 20])
    node.transform.scaleX = 2
    node.transform.scaleY = 3
    foldScale(node)
    expect(node.points).toEqual([0, 0, 20, 60])
    expect(node.transform.scaleX).toBe(1)
  })

  it('round-trips the marker flag, which is the whole difference between the two tools', () => {
    const pen = parseSceneDoc({ nodes: [stroke([0, 0, 10, 10])] }, 200, 200).nodes[0]
    if (pen?.type !== 'freehand') throw new Error('expected a stroke')
    expect(pen.marker).toBeUndefined()

    const marked = parseSceneDoc({ nodes: [stroke([0, 0, 10, 10], { marker: true })] }, 200, 200).nodes[0]
    if (marked?.type !== 'freehand') throw new Error('expected a stroke')
    expect(marked.marker).toBe(true)
  })

  it('drops junk out of a stored point list instead of trusting it', () => {
    const raw = { ...(stroke([]) as unknown as Record<string, unknown>), points: [0, 0, 'over', 10, null, 20] }
    const node = parseSceneDoc({ nodes: [raw] }, 200, 200).nodes[0]
    if (node?.type !== 'freehand') throw new Error('expected a stroke')
    expect(node.points).toEqual([0, 0, 10, 20])
  })

  it('caps a hostile point list rather than chewing through it', () => {
    const huge = Array.from({ length: STROKE_MAX_POINTS * 4 }, (_value, index) => index)
    const raw = { ...(stroke([]) as unknown as Record<string, unknown>), points: huge }
    const node = parseSceneDoc({ nodes: [raw] }, 200, 200).nodes[0]
    if (node?.type !== 'freehand') throw new Error('expected a stroke')
    const points = node.points as readonly number[]
    expect(points.length).toBeLessThanOrEqual(STROKE_MAX_POINTS * 2)
    expect(points.length % 2).toBe(0)
  })
})
