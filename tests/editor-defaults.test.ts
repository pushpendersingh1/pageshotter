import { describe, expect, it } from 'vitest'
import {
  applyToolDefaults,
  DEFAULT_EDITOR_DEFAULTS,
  extractToolDefault,
  readEditorDefaults,
  DEFAULTABLE_KEYS,
} from '../src/editor/editor-defaults'
import { nodeFromDrag, parseSceneDoc, textFontFamily, type RectangleNode, type ShapeType, type TextNode } from '../src/editor/scene'

function rect(): RectangleNode {
  return {
    id: 'r1',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    type: 'rectangle',
    width: 100,
    height: 60,
    stroke: '#E11900',
    strokeWidth: 6,
    fill: 'none',
    radius: 0,
    opacity: 1,
  }
}

function text(): TextNode {
  return {
    id: 't1',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    type: 'text',
    width: 360,
    height: 48,
    text: 'Enter text here',
    fontSize: 40,
    fontWeight: 500,
    align: 'left',
    color: '#E11900',
    stroke: 'none',
    strokeWidth: 4,
    opacity: 1,
  }
}

describe('saving a tool default', () => {
  it('keeps the inspector-editable appearance values and nothing else', () => {
    const saved = extractToolDefault(rect(), 2)
    expect(saved).toEqual({ stroke: '#E11900', strokeWidth: 3, fill: 'none', radius: 0, opacity: 1 })
  })

  it('stores density-scaled values density-free', () => {
    // Created at 6 scene units on a 2× capture; the default is the 3 scene units it means.
    expect(extractToolDefault(rect(), 2).strokeWidth).toBe(3)
    expect(extractToolDefault(text(), 2)).toMatchObject({ fontSize: 20, strokeWidth: 2 })
  })

  it('survives a density of 0 or worse without dividing by it', () => {
    expect(extractToolDefault(rect(), 0).strokeWidth).toBe(6)
  })
})

describe('applying a tool default', () => {
  it("scales saved values back up by the new document's density", () => {
    const node = rect()
    applyToolDefaults(node, { strokeWidth: 3, fill: '#204E8A' }, 2)
    expect(node.strokeWidth).toBe(6)
    expect(node.fill).toBe('#204E8A')
    // Geometry and anything not saved is left as the constructor built it.
    expect(node.width).toBe(100)
  })

  it('ignores keys the tool does not carry', () => {
    const node = rect()
    applyToolDefaults(node, { fontSize: 40, headSize: 9 } as never, 2)
    expect('fontSize' in node).toBe(false)
    expect('headSize' in node).toBe(false)
  })

  it('round-trips a saved default back onto a node of the same density', () => {
    const original = rect()
    const node = rect()
    applyToolDefaults(node, extractToolDefault(original, 2), 2)
    expect(node.strokeWidth).toBe(original.strokeWidth)
    expect(node.fill).toBe(original.fill)
    expect(node.opacity).toBe(original.opacity)
  })

  it('does nothing when nothing was saved', () => {
    const node = rect()
    applyToolDefaults(node, undefined, 2)
    expect(node.stroke).toBe('#E11900')
  })
})

describe('validating a stored value', () => {
  it('reads garbage as factory defaults', () => {
    expect(readEditorDefaults(undefined)).toEqual(DEFAULT_EDITOR_DEFAULTS)
    expect(readEditorDefaults('nope')).toEqual(DEFAULT_EDITOR_DEFAULTS)
    expect(readEditorDefaults(null)).toEqual(DEFAULT_EDITOR_DEFAULTS)
  })

  it('keeps valid overrides and fills every other value from the factory model', () => {
    const defaults = readEditorDefaults({
      tools: {
        rectangle: { fill: '#204E8A', headSize: 9, transformX: 12, opacity: 'bad' },
        emoji: { fontSize: 10 },
      },
      present: { frame: 'mac' },
      canvas: { background: 'ocean', margin: 12 },
    })
    expect(defaults.tools.rectangle).toEqual({
      ...DEFAULT_EDITOR_DEFAULTS.tools.rectangle,
      fill: '#204E8A',
    })
    expect(defaults.tools.ellipse).toEqual(DEFAULT_EDITOR_DEFAULTS.tools.ellipse)
    expect(defaults.tools.emoji.fontSize).toBe(10)
    expect(defaults.present.frame).toBe('mac')
    expect(defaults.canvas.background).toBe('ocean')
    expect(defaults.canvas.margin).toBe(12)
  })

  it('repairs a canvas default that is not one', () => {
    expect(readEditorDefaults({ canvas: { background: 'martian', margin: -5, customColor: 9 } }).canvas).toEqual({
      background: 'indigo',
      customColor: '#FFFFFF',
      margin: 64,
    })
  })

  it('fills a saved Present default out to a complete one', () => {
    const defaults = readEditorDefaults({ present: { frame: 'windows' } })
    expect(defaults.present.frame).toBe('windows')
    expect(defaults.present.chrome).toBeDefined()
    expect(defaults.present.background).toBeDefined()
  })

  it('keeps invalid types, colours and alignments at their factory values', () => {
    const defaults = readEditorDefaults({
      tools: {
        text: { color: 'red', align: 'justify', italic: 'yes', opacity: 8 },
      },
    })
    expect(defaults.tools.text.color).toBe(DEFAULT_EDITOR_DEFAULTS.tools.text.color)
    expect(defaults.tools.text.align).toBe('left')
    expect(defaults.tools.text.italic).toBe(false)
    expect(defaults.tools.text.opacity).toBe(1)
  })
})

/**
 * The defaults sheet has no controls of its own: it builds a sample with the same factory drawing
 * uses, writes the saved default over it, and reads whatever the inspector edited back out. If a key
 * cannot survive that round trip, editing it in the sheet silently discards it.
 */
describe('the defaults sheet round-trips every key through a sample shape', () => {
  const types = (Object.keys(DEFAULTABLE_KEYS) as ShapeType[]).filter((type) => DEFAULTABLE_KEYS[type].length > 0)

  it('builds a sample for every type that has defaults', () => {
    for (const type of types) {
      expect(nodeFromDrag(type, { x: 40, y: 32 }, { x: 260, y: 152 }, 1), type).toBeDefined()
    }
  })

  it('reads back exactly what was written, for every type', () => {
    for (const type of types) {
      const node = nodeFromDrag(type, { x: 40, y: 32 }, { x: 260, y: 152 }, 1)
      if (!node) throw new Error(`No sample for ${type}`)
      const saved = DEFAULT_EDITOR_DEFAULTS.tools[type]
      applyToolDefaults(node, saved, 1)
      expect(extractToolDefault(node, 1), type).toEqual(saved)
    }
  })

  it('carries an edit back out, so the sheet saves what the inspector changed', () => {
    const node = nodeFromDrag('rectangle', { x: 40, y: 32 }, { x: 260, y: 152 }, 1)
    if (!node || node.type !== 'rectangle') throw new Error('No rectangle sample')
    applyToolDefaults(node, DEFAULT_EDITOR_DEFAULTS.tools.rectangle, 1)
    node.radius = 12
    node.stroke = '#1D6BE5'
    expect(extractToolDefault(node, 1)).toMatchObject({ radius: 12, stroke: '#1D6BE5' })
  })
})

describe('Pen and Marker keep separate defaults', () => {
  const pen = DEFAULT_EDITOR_DEFAULTS.tools.freehand
  const marker = DEFAULT_EDITOR_DEFAULTS.tools.marker

  it('gives the two tools visibly different factory values', () => {
    /*
     * The bug this locks: both tools make a `freehand` node, so keying defaults by node type gave
     * Marker the pen's thin blue. A thin blue `multiply` stroke over a white page is pixel-identical
     * to a thin blue normal one, so the two tools were indistinguishable in normal use.
     */
    expect(marker.stroke).not.toBe(pen.stroke)
    expect(Number(marker.strokeWidth)).toBeGreaterThan(Number(pen.strokeWidth) * 3)
    expect(Number(marker.opacity)).toBeLessThan(1)
    expect(Number(pen.opacity)).toBe(1)
  })

  it('does not let a saved default decide the composite, because the tool does', () => {
    // A defaultable `marker` key put a checkbox on the Pen defaults page that the commit then
    // overrode. A dead control is worse than no control.
    expect(DEFAULTABLE_KEYS.freehand).not.toContain('marker')
  })

  it('restores both bags from storage, not just the one with a node type', () => {
    const restored = readEditorDefaults({})
    expect(restored.tools.marker).toMatchObject(marker)
    expect(restored.tools.freehand).toMatchObject(pen)
  })

  it('keeps a stored marker default separate from the pen one', () => {
    const restored = readEditorDefaults({ tools: { marker: { strokeWidth: 40 } } })
    expect(restored.tools.marker.strokeWidth).toBe(40)
    expect(restored.tools.freehand.strokeWidth).toBe(pen.strokeWidth)
  })
})

describe('Handlee is the text default', () => {
  it('gives a new text box the bundled font, and leaves a stored one without a family on the system font', () => {
    const fresh = nodeFromDrag('text', { x: 0, y: 0 }, { x: 200, y: 40 }, 1) as TextNode
    applyToolDefaults(fresh, DEFAULT_EDITOR_DEFAULTS.tools.text, 1)
    expect(fresh.fontFamily).toBe('Handlee')
    expect(textFontFamily(fresh)).toMatch(/^"Handlee", /)

    // An existing document is not restyled: absent still means the system font.
    const stored = parseSceneDoc({ nodes: [{ id: 't', type: 'text', text: 'hi' }] }, 100, 100).nodes[0] as TextNode
    expect(stored.fontFamily).toBeUndefined()
  })
})
