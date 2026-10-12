import { describe, expect, it } from 'vitest'
import { applyToolDefaults, DEFAULT_EDITOR_DEFAULTS } from '../src/editor/editor-defaults'
import { readInspectorField, writeInspectorField } from '../src/editor/inspector-fields'
import {
  foldScale,
  resizeTextBox,
  hitTest,
  localBounds,
  nodeFromDrag,
  parseSceneDoc,
  textBubblePath,
  textInset,
  textTailShown,
  type TextNode,
  type TextBubbleSink,
} from '../src/editor/scene'

function plain(): TextNode {
  return nodeFromDrag('text', { x: 0, y: 0 }, { x: 200, y: 40 }, 1) as TextNode
}

function filled(tip?: { x: number; y: number }): TextNode {
  return { ...plain(), width: 200, height: 40, fill: '#E11900', color: '#FFFFFF', ...(tip ? { tip } : {}) }
}

/** Records the path as polygons, arcs reduced to their corner point, so windings can be compared. */
function record(node: TextNode): { x: number; y: number }[][] {
  const paths: { x: number; y: number }[][] = []
  const sink: TextBubbleSink = {
    beginPath: () => {},
    moveTo: (x, y) => paths.push([{ x, y }]),
    lineTo: (x, y) => paths.at(-1)?.push({ x, y }),
    arcTo: (x1, y1) => paths.at(-1)?.push({ x: x1, y: y1 }),
    bezierCurveTo: (_ax, _ay, _bx, _by, x, y) => paths.at(-1)?.push({ x, y }),
    arc: (x, y, r, start) => paths.at(-1)?.push({ x: x + r * Math.cos(start + Math.PI), y: y + r * Math.sin(start + Math.PI) }),
    closePath: () => {},
  }
  textBubblePath(sink, node)
  return paths
}

function area(points: readonly { x: number; y: number }[]): number {
  let sum = 0
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point
    sum += point.x * next.y - next.x * point.y
  })
  return sum / 2
}

describe('filled text: geometry', () => {
  it('insets the text only when filled, in proportion to the font', () => {
    expect(textInset(plain())).toEqual({ x: 0, y: 0 })
    expect(textInset({ fontSize: 20, fill: 'red' })).toEqual({ x: 9, y: 4 })
  })

  it('draws the pointer only from outside the box', () => {
    expect(textTailShown(filled({ x: 60, y: 90 }))).toBe(true)
    expect(textTailShown(filled({ x: 60, y: 20 }))).toBe(false)
    expect(textTailShown(filled())).toBe(false)
  })

  it('is one box, plus a wedge wound the same way so the non-zero fill joins them', () => {
    expect(record(filled({ x: 60, y: 20 }))).toHaveLength(1)
    for (const tip of [{ x: 60, y: 90 }, { x: 260, y: 20 }, { x: -50, y: -40 }, { x: 100, y: -60 }]) {
      const [box = [], wedge = []] = record(filled(tip))
      expect(wedge, JSON.stringify(tip)).toHaveLength(4)
      expect(Math.sign(area(wedge)), JSON.stringify(tip)).toBe(Math.sign(area(box)))
    }
  })

  it('has no corner anywhere: tangent to the box where it leaves, tangent into the round tip', () => {
    const tip = { x: 60, y: 90 }
    const curves: number[][] = []
    const arcs: { x: number; y: number; r: number; start: number; anticlockwise?: boolean }[] = []
    let start = { x: 0, y: 0 }
    const sink: TextBubbleSink = {
      beginPath: () => {},
      moveTo: (x, y) => { start = { x, y } },
      lineTo: () => {},
      arcTo: () => {},
      bezierCurveTo: (...args) => { curves.push(args) },
      arc: (x, y, r, from, _to, anticlockwise) => { arcs.push({ x, y, r, start: from, anticlockwise }) },
      closePath: () => {},
    }
    textBubblePath(sink, filled(tip))
    const [first = [], last = []] = curves
    const [round] = arcs
    if (!round) throw new Error('no round tip')
    // Leaving the bottom edge: the control point next to each base point is on it.
    expect(start.y).toBe(40)
    expect(first[1]).toBe(40)
    expect(last[3]).toBe(40)
    expect(last[5]).toBe(40)

    // Into the round: each side arrives along the axis, i.e. square to the round's radius there.
    const [, , ax = 0, ay = 0, ex = 0, ey = 0] = first
    const radial = { x: ex - round.x, y: ey - round.y }
    expect((ex - ax) * radial.x + (ey - ay) * radial.y).toBeCloseTo(0)
    expect(Math.hypot(radial.x, radial.y)).toBeCloseTo(round.r)

    // The middle of the sweep is the tip itself.
    const mid = round.start + (round.anticlockwise ? -Math.PI / 2 : Math.PI / 2)
    expect(round.x + round.r * Math.cos(mid)).toBeCloseTo(tip.x)
    expect(round.y + round.r * Math.sin(mid)).toBeCloseTo(tip.y)
  })

  it('keeps a full base when the tip is off a corner', () => {
    const [, wedge = []] = record(filled({ x: 400, y: 200 }))
    const [a = { x: 0, y: 0 }, , , b = { x: 0, y: 0 }] = wedge
    // The near side alone is a fifth of how far the tip reaches (200 across, 160 down), far over the
    // font's 10; the far side adds to that.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(Math.hypot(200, 160) * 0.2 * 2)
  })

  it('bounds the pointer, so the export does not skip the band it reaches into', () => {
    expect(localBounds(filled({ x: 60, y: 90 }))).toEqual({ x: 0, y: 0, width: 200, height: 90 })
    expect(localBounds({ ...plain(), tip: { x: 60, y: 900 } })).toEqual({ x: 0, y: 0, width: 200, height: 24 })
  })

  it('carries a pointer below with the bottom edge when the box is made taller from the bottom', () => {
    // Drag the bottom handle down 40 and the pointer comes down 40, keeping its shape.
    const node = filled({ x: 60, y: 90 })
    node.transform.scaleY = 2
    foldScale(node)
    expect(node.height).toBe(80)
    expect(node.tip).toEqual({ x: 60, y: 130 })
  })

  it('leaves a pointer below where it points when the box is made taller from the top', () => {
    // The top handle moves the box's origin up by 40 as it doubles; the tip keeps its page position.
    const node = filled({ x: 60, y: 90 })
    node.transform = { ...node.transform, y: 100 - 40, scaleY: 2 }
    foldScale(node)
    expect(node.transform.y + (node.tip?.y ?? 0)).toBe(100 + 90)
  })
})

describe('filled text: stored documents', () => {
  it('reads an old text node as plain, and keeps a stored fill and pointer', () => {
    const [old, none, kept] = parseSceneDoc({
      nodes: [
        { id: 'a', type: 'text', text: 'old' },
        { id: 'b', type: 'text', text: 'none', fill: 'none' },
        { id: 'c', type: 'text', text: 'kept', fill: '#E11900', tip: { x: 5, y: 80 } },
      ],
    }, 100, 100).nodes as TextNode[]
    expect(old?.fill).toBeUndefined()
    expect(none?.fill).toBeUndefined()
    expect(kept).toMatchObject({ fill: '#E11900', tip: { x: 5, y: 80 } })
  })
})

describe('filled text: one colour between the two styles', () => {
  it('turns the text colour into the box and whitens the letters, then hands it back', () => {
    const node = plain()
    node.color = '#1D6BE5'
    expect(writeInspectorField(node, 'filled', true)).toBe(true)
    expect(node).toMatchObject({ fill: '#1D6BE5', color: '#FFFFFF' })
    const tip = node.tip
    expect(tip).toBeDefined()

    expect(writeInspectorField(node, 'filled', false)).toBe(true)
    expect(node.fill).toBeUndefined()
    expect(node.color).toBe('#1D6BE5')
    // Refilling keeps the pointer where it was.
    writeInspectorField(node, 'filled', true)
    expect(node.tip).toEqual(tip)
  })

  it('has no Box colour while plain, and refuses one: filling is the switch`s job', () => {
    const node = plain()
    expect(readInspectorField(node, 'fill')).toBeUndefined()
    expect(writeInspectorField(node, 'fill', '#00AA00')).toBe(false)
    expect(node.fill).toBeUndefined()
    const box = filled({ x: 60, y: 90 })
    expect(writeInspectorField(box, 'fill', '#00AA00')).toBe(true)
    expect(box.fill).toBe('#00AA00')
  })
})

describe('filled text: the default', () => {
  it('makes a new text a blue box with white letters and a pointer', () => {
    const node = plain()
    applyToolDefaults(node, DEFAULT_EDITOR_DEFAULTS.tools.text, 1)
    expect(node).toMatchObject({ fill: '#1D6BE5', color: '#FFFFFF' })
    expect(textTailShown(node)).toBe(true)
  })

  it('keeps a saved plain default plain, in its own colour', () => {
    const node = plain()
    applyToolDefaults(node, { ...DEFAULT_EDITOR_DEFAULTS.tools.text, filled: false, color: '#1D6BE5' }, 1)
    expect(node.fill).toBeUndefined()
    expect(node.color).toBe('#1D6BE5')
  })

  it('lands a saved text colour after the fill swap, whatever order the bag was stored in', () => {
    const node = plain()
    applyToolDefaults(node, { color: '#111111', fill: '#00AA00', filled: true }, 1)
    expect(node).toMatchObject({ fill: '#00AA00', color: '#111111' })
  })
})

describe('pointer hit testing', () => {
  const doc = (node: object) => parseSceneDoc({ nodes: [node] }, 1000, 1000)

  it('misses the empty corner between a filled text and its tip, and hits the box and the pointer', () => {
    const scene = doc({ id: 't', type: 'text', text: 'hi', width: 200, height: 40, fill: '#E11900', tip: { x: 300, y: 200 } })
    expect(hitTest(scene, 280, 30)).toBeUndefined()
    expect(hitTest(scene, 20, 150)).toBeUndefined()
    expect(hitTest(scene, 100, 20)?.id).toBe('t')
    expect(hitTest(scene, 190, 60)?.id).toBe('t')
  })

  it('misses the empty corner between a counter and its tip', () => {
    const scene = doc({ id: 'c', type: 'counter', count: 1, width: 44, height: 44, tip: { x: 150, y: 150 } })
    expect(hitTest(scene, 140, 10)).toBeUndefined()
    expect(hitTest(scene, 22, 22)?.id).toBe('c')
    expect(hitTest(scene, 140, 140)?.id).toBe('c')
  })
})

describe('the pointer keeps its shape as the box changes', () => {
  it('moves a tip below the box down with a new line, and leaves one above where it is', () => {
    const below = filled({ x: 60, y: 90 })
    resizeTextBox(below, 200, 64)
    expect(below.tip).toEqual({ x: 60, y: 114 })
    const above = filled({ x: -40, y: -60 })
    resizeTextBox(above, 200, 64)
    expect(above.tip).toEqual({ x: -40, y: -60 })
  })

  it('draws the same pointer for a tip above the box whatever the box height', () => {
    const one = record(filled({ x: -40, y: -60 }))[1]
    const two = record({ ...filled({ x: -40, y: -60 }), height: 64 })[1]
    expect(two).toEqual(one)
  })

  it('sizes the base by the font, not by how many lines the box has', () => {
    const base = (height: number) => {
      const [a = { x: 0, y: 0 }, , , b = { x: 0, y: 0 }] = record({ ...filled({ x: 60, y: height + 50 }), height })[1] ?? []
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    expect(base(88)).toBeCloseTo(base(40))
  })
})

describe('a far pointer is a wedge, not a line', () => {
  it('widens its base with its reach, and never below half the font', () => {
    const base = (tip: { x: number; y: number }) => {
      const [a = { x: 0, y: 0 }, , , b = { x: 0, y: 0 }] = record(filled(tip))[1] ?? []
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    // A short pointer: half the font near (10), 0.6 x its reach of 20 far (12).
    expect(base({ x: 100, y: 60 })).toBeCloseTo(22)
    expect(base({ x: -200, y: -150 })).toBeGreaterThan(base({ x: -60, y: -40 }))
  })

  it('reaches its far side on past the middle of the edge, away from the tip (a long sweep)', () => {
    // Tip far up-left of a 200-wide box: the far base point is right of centre.
    const [a = { x: 0, y: 0 }, , , b = { x: 0, y: 0 }] = record(filled({ x: -300, y: -200 }))[1] ?? []
    expect(Math.max(a.x, b.x)).toBeGreaterThan(100 + 200 * 0.15)
    expect(Math.min(a.x, b.x)).toBeLessThan(100)
  })
})
