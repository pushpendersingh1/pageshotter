import { describe, expect, it } from 'vitest'
import {
  COUNTER_DIAMETER,
  counterFontSize,
  counterPath,
  counterTangents,
  defaultCounterTip,
  foldScale,
  localBounds,
  MIN_SHAPE_SIZE,
  nextCount,
  nodeFromDrag,
  parseSceneDoc,
  type CounterNode,
  type CounterPathSink,
  type SceneNode,
} from '../src/editor/scene'

function counter(id: string, count: number, tip?: { x: number; y: number }): CounterNode {
  return { id, type: 'counter', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, width: 44, height: 44, count, fill: '#E11900', color: '#FFFFFF', ...(tip ? { tip } : {}), opacity: 1 }
}

/** Records what `counterPath` emits, so the shape can be asserted without a canvas. */
function recordingSink(): CounterPathSink & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    beginPath: () => void calls.push('begin'),
    arc: (x, y, r, start, end) => void calls.push(`arc ${x} ${y} ${r} ${start.toFixed(3)} ${end.toFixed(3)}`),
    lineTo: (x, y) => void calls.push(`lineTo ${x} ${y}`),
    closePath: () => void calls.push('close'),
  }
}

describe('the number the next badge gets', () => {
  it('starts at 1 in a document with no badges', () => {
    expect(nextCount([])).toBe(1)
    expect(nextCount([{ id: 'r', type: 'rectangle' } as SceneNode])).toBe(1)
  })

  it('counts one past the highest, not one past how many there are', () => {
    // The distinction is the whole point: deleting badge 2 of three must not hand the next badge a
    // 3 that already exists on the canvas.
    expect(nextCount([counter('a', 1), counter('b', 2), counter('c', 3)])).toBe(4)
    expect(nextCount([counter('a', 1), counter('c', 3)])).toBe(4)
  })

  it('sees badges inside groups, which are organisational and not a numbering scope', () => {
    const group: SceneNode = {
      id: 'g',
      type: 'group',
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      opacity: 1,
      children: [counter('a', 7)],
    }
    expect(nextCount([group])).toBe(8)
  })
})

describe('the digit size a badge wears', () => {
  it('shrinks as the number gains digits, so a 12 fits a disc sized for a 1', () => {
    const one = counterFontSize(100, 1)
    const two = counterFontSize(100, 12)
    const three = counterFontSize(100, 123)
    expect(one).toBeGreaterThan(two)
    expect(two).toBeGreaterThan(three)
  })

  it('keeps every number inside the disc at a plausible digit width', () => {
    // Digits in a sans face run about 0.55em wide. The rendered number must stay inside the circle,
    // which is the defect this function exists to prevent.
    for (const count of [1, 9, 10, 99, 100, 999]) {
      const width = String(count).length * counterFontSize(100, count) * 0.55
      expect(width).toBeLessThan(100)
    }
  })

  it('scales with the diameter, because the diameter is the only size knob', () => {
    expect(counterFontSize(200, 5)).toBeCloseTo(counterFontSize(100, 5) * 2)
  })
})

describe('placing a badge', () => {
  it('stamps a default-diameter badge centred on a plain click', () => {
    // Every other tool refuses a drag under MIN_SHAPE_SIZE. A counter is clicked, not dragged, and
    // it centres on the click because you click the thing you are numbering.
    const at = { x: 300, y: 200 }
    const node = nodeFromDrag('counter', at, at, 1)
    expect(node?.type).toBe('counter')
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.width).toBe(COUNTER_DIAMETER)
    expect(node.height).toBe(COUNTER_DIAMETER)
    expect(node.transform.x).toBeCloseTo(300 - COUNTER_DIAMETER / 2)
    expect(node.transform.y).toBeCloseTo(200 - COUNTER_DIAMETER / 2)
    // And it arrives as a pin, not a bare disc.
    expect(node.tip).toEqual(defaultCounterTip(COUNTER_DIAMETER))
  })

  it('scales the stamped diameter by the capture density', () => {
    const node = nodeFromDrag('counter', { x: 0, y: 0 }, { x: 0, y: 0 }, 2)
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.width).toBe(COUNTER_DIAMETER * 2)
  })

  it('takes its diameter from the longer side of a real drag, and stays a circle', () => {
    const node = nodeFromDrag('counter', { x: 10, y: 10 }, { x: 110, y: 50 }, 1)
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.width).toBe(100)
    expect(node.height).toBe(100)
    expect(node.transform.x).toBe(10)
    expect(node.transform.y).toBe(10)
  })

  it('is dealt a small tilt rather than sitting perfectly square', () => {
    const at = { x: 0, y: 0 }
    const tilts = Array.from({ length: 20 }, () => nodeFromDrag('counter', at, at, 1)?.transform.rotation ?? 0)
    expect(tilts.every((tilt) => Math.abs(tilt) <= 3)).toBe(true)
    expect(new Set(tilts).size).toBeGreaterThan(1)
  })

  it('never returns undefined for a click, where a rectangle would', () => {
    const at = { x: 5, y: 5 }
    const tiny = { x: 5 + MIN_SHAPE_SIZE / 2, y: 5 }
    expect(nodeFromDrag('rectangle', at, tiny, 1)).toBeUndefined()
    expect(nodeFromDrag('counter', at, tiny, 1)).toBeDefined()
  })
})

describe('reading a badge back from a stored document', () => {
  it('round-trips through the parser', () => {
    const doc = parseSceneDoc({ nodes: [counter('a', 12)] }, 500, 500)
    const node = doc.nodes[0]
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.count).toBe(12)
    expect(node.fill).toBe('#E11900')
    expect(node.color).toBe('#FFFFFF')
  })

  it('clamps a count written by something else to a whole number at or above zero', () => {
    const raw = { ...(counter('a', 1) as unknown as Record<string, unknown>), count: -4.6 }
    const doc = parseSceneDoc({ nodes: [raw] }, 500, 500)
    const node = doc.nodes[0]
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.count).toBe(0)
  })
})

describe('the pin tail', () => {
  it('leaves the disc at the two tangent angles, so it meets the circle smoothly', () => {
    // Tip straight below the centre of a 100-wide badge, 100 below it. The tangents must sit
    // symmetrically about that direction, which is a quarter turn (PI/2) in canvas coordinates.
    const tangents = counterTangents(100, { x: 50, y: 150 })
    if (!tangents) throw new Error('expected a tail')
    const spread = Math.acos(50 / 100)
    expect(tangents.from).toBeCloseTo(Math.PI / 2 + spread)
    expect(tangents.to).toBeCloseTo(Math.PI / 2 - spread)
  })

  it('has no tail when the tip is inside the disc, which is how the user takes it off', () => {
    expect(counterTangents(100, { x: 50, y: 50 })).toBeUndefined()
    expect(counterTangents(100, { x: 50, y: 70 })).toBeUndefined()
    expect(counterTangents(100, undefined)).toBeUndefined()
  })

  it('has no tail for a tip just outside the edge, where the tangents would collapse to a spike', () => {
    expect(counterTangents(100, { x: 50, y: 101 })).toBeUndefined()
    expect(counterTangents(100, { x: 50, y: 120 })).toBeDefined()
  })

  it('draws a closed teardrop when there is a tail, and a plain circle when there is not', () => {
    const withTail = recordingSink()
    counterPath(withTail, 100, { x: 50, y: 150 })
    expect(withTail.calls[0]).toBe('begin')
    expect(withTail.calls[1]).toMatch(/^arc 50 50 50 /)
    expect(withTail.calls[2]).toBe('lineTo 50 150')
    expect(withTail.calls[3]).toBe('close')

    const plain = recordingSink()
    counterPath(plain, 100, undefined)
    expect(plain.calls).toEqual(['begin', `arc 50 50 50 0.000 ${(Math.PI * 2).toFixed(3)}`])
  })

  it('sweeps the major arc, leaving the near side of the circle open for the tail', () => {
    // From the far tangent round to the near one the long way: more than half a turn, or the tail
    // would close across the wrong side and cut a bite out of the disc.
    const tangents = counterTangents(100, { x: 50, y: 150 })
    if (!tangents) throw new Error('expected a tail')
    const sweep = (tangents.to - tangents.from + Math.PI * 4) % (Math.PI * 2)
    expect(sweep).toBeGreaterThan(Math.PI)
  })

  it('points a fresh pin down and to the right, clear of the disc', () => {
    const tip = defaultCounterTip(100)
    expect(tip.x).toBeGreaterThan(50)
    expect(tip.y).toBeGreaterThan(100)
    expect(counterTangents(100, tip)).toBeDefined()
  })
})

describe('the tail and the rest of the editor', () => {
  it('grows the local bounds, so the export cannot clip the point off', () => {
    const plain = localBounds(counter('a', 1))
    expect(plain).toEqual({ x: 0, y: 0, width: 44, height: 44 })

    const pinned = localBounds(counter('a', 1, { x: 22, y: 120 }))
    expect(pinned.height).toBe(120)
    expect(pinned.y).toBe(0)
  })

  it('reaches above and left too, when the tip is dragged back over the badge', () => {
    const box = localBounds(counter('a', 1, { x: -30, y: -50 }))
    expect(box.x).toBe(-30)
    expect(box.y).toBe(-50)
    expect(box.width).toBe(74)
    expect(box.height).toBe(94)
  })

  it('scales the tip with the disc, so a resize does not leave the point behind', () => {
    const node: CounterNode = counter('a', 1, { x: 22, y: 120 })
    node.transform.scaleX = 2
    node.transform.scaleY = 2
    foldScale(node)
    expect(node.width).toBe(88)
    expect(node.tip).toEqual({ x: 44, y: 240 })
  })

  it('leaves a badge stored before the tail existed as a plain disc', () => {
    const doc = parseSceneDoc({ nodes: [counter('a', 1)] }, 500, 500)
    const node = doc.nodes[0]
    if (node?.type !== 'counter') throw new Error('expected a counter')
    expect(node.tip).toBeUndefined()
  })

  it('round-trips a tip, and refuses a malformed one rather than inventing a point', () => {
    const kept = parseSceneDoc({ nodes: [counter('a', 1, { x: 22, y: 120 })] }, 500, 500).nodes[0]
    if (kept?.type !== 'counter') throw new Error('expected a counter')
    expect(kept.tip).toEqual({ x: 22, y: 120 })

    const raw = { ...(counter('a', 1) as unknown as Record<string, unknown>), tip: { x: 'over there' } }
    const broken = parseSceneDoc({ nodes: [raw] }, 500, 500).nodes[0]
    if (broken?.type !== 'counter') throw new Error('expected a counter')
    expect(broken.tip).toBeUndefined()
  })
})
