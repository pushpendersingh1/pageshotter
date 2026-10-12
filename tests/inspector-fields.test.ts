import { describe, expect, it } from 'vitest'
import {
  editSession,
  readInspectorField,
  writeInspectorField,
  type InspectorFieldKey,
} from '../src/editor/inspector-fields'
import { hasStroke, isKnownNode, parseSceneDoc, type KnownNode, type RectangleNode, type ShapeType } from '../src/editor/scene'

function rectangle(): RectangleNode {
  return {
    id: 'rectangle',
    type: 'rectangle',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    width: 100,
    height: 50,
    stroke: '#000000',
    strokeWidth: 2,
    fill: 'none',
    radius: 0,
    opacity: 0.5,
  }
}

type NodeType = ShapeType | 'group'

const FIELD_KEYS = [
  'transform.x',
  'transform.y',
  'transform.rotation',
  'opacity',
  'width',
  'height',
  'stroke',
  'strokeWidth',
  'fill',
  'radius',
  'headSize',
  'arrowSize',
  'roundness',
  'count',
  'fontSize',
  'fontWeight',
  'align',
  'color',
  'fontFamily',
  'italic',
  'marker',
  'filled',
] as const satisfies readonly InspectorFieldKey[]

const COMMON = ['transform.x', 'transform.y', 'transform.rotation', 'opacity'] as const
const BOX = ['width', 'height'] as const
const SUPPORTED_FIELDS: Record<NodeType, readonly InspectorFieldKey[]> = {
  rectangle: [...COMMON, ...BOX, 'stroke', 'strokeWidth', 'fill', 'radius'],
  ellipse: [...COMMON, ...BOX, 'stroke', 'strokeWidth', 'fill'],
  arrow: [...COMMON, 'stroke', 'strokeWidth', 'headSize', 'arrowSize'],
  line: [...COMMON, 'stroke', 'strokeWidth'],
  text: [...COMMON, ...BOX, 'fontSize', 'fontWeight', 'align', 'color', 'stroke', 'strokeWidth', 'fontFamily', 'italic', 'filled'],
  blur: [...COMMON, ...BOX, 'radius'],
  highlight: [...COMMON, ...BOX, 'color'],
  emoji: [...COMMON, ...BOX, 'fontSize'],
  counter: [...COMMON, ...BOX, 'fill', 'color', 'count'],
  freehand: [...COMMON, 'stroke', 'strokeWidth', 'marker'],
  magnifier: [...COMMON, ...BOX, 'stroke', 'strokeWidth', 'roundness'],
  image: [...COMMON, ...BOX],
  group: COMMON,
}

function parsedNode(type: NodeType): KnownNode {
  const node = parseSceneDoc({ nodes: [{ id: type, type, src: 'data:image/png;base64,AA==' }] }, 100, 100).nodes[0]
  if (!node || !isKnownNode(node)) throw new Error(`Could not parse ${type}`)
  return node
}

function writeValue(node: KnownNode, key: InspectorFieldKey): boolean {
  if (key === 'align') return writeInspectorField(node, key, 'center')
  if (key === 'italic' || key === 'marker' || key === 'filled') return writeInspectorField(node, key, true)
  if (key === 'fontFamily') return writeInspectorField(node, key, 'Georgia')
  if (key === 'stroke' || key === 'fill' || key === 'color') return writeInspectorField(node, key, '#123456')
  return writeInspectorField(node, key, key === 'opacity' ? 0.25 : 23)
}

describe('writeInspectorField', () => {
  it('refuses a value of the wrong type instead of corrupting the scene node', () => {
    const node = rectangle()

    // @ts-expect-error Runtime validation still protects scenes written by untyped callers.
    writeInspectorField(node, 'opacity', 'opaque')

    expect(node.opacity).toBe(0.5)
  })

  it('reads and writes exactly the supported fields for every node type', () => {
    for (const type of Object.keys(SUPPORTED_FIELDS) as NodeType[]) {
      const node = parsedNode(type)
      const supported = SUPPORTED_FIELDS[type]
      for (const key of FIELD_KEYS) {
        const initial = expect(readInspectorField(node, key), `${type}.${key} initial read`)
        if (supported.includes(key)) initial.not.toBeUndefined()
        else initial.toBeUndefined()
        expect(writeValue(node, key), `${type}.${key} write`).toBe(supported.includes(key))
        if (supported.includes(key)) {
          const expected = key === 'align'
            ? 'center'
            : key === 'italic' || key === 'marker' || key === 'filled'
              ? true
              : key === 'fontFamily'
                ? 'Georgia'
            : key === 'stroke' || key === 'fill' || key === 'color'
              ? '#123456'
              : key === 'opacity'
                ? 0.25
                : 23
          expect(readInspectorField(node, key), `${type}.${key} updated read`).toBe(expected)
        }
      }
    }
  })
})

describe('Auto height', () => {
  it('reads auto for a new text box and nothing for any other type', () => {
    expect(readInspectorField(parsedNode('text'), 'autoHeight')).toBe(true)
    expect(readInspectorField(parsedNode('rectangle'), 'autoHeight')).toBeUndefined()
    expect(writeInspectorField(parsedNode('rectangle'), 'autoHeight', false)).toBe(false)
  })

  it('fixes the box when unticked and hands the height back to measurement when ticked', () => {
    const node = parsedNode('text')
    expect(writeInspectorField(node, 'autoHeight', false)).toBe(true)
    expect(node).toMatchObject({ fixedHeight: true })
    expect(writeInspectorField(node, 'autoHeight', true)).toBe(true)
    expect(node).not.toHaveProperty('fixedHeight')
  })

  it('fixes a text box when H is typed, as a handle does', () => {
    const node = parsedNode('text')
    writeInspectorField(node, 'height', 40)
    expect(readInspectorField(node, 'autoHeight')).toBe(false)
  })
})

describe('editSession', () => {
  it('snapshots on the first write of a focus and never again inside it', () => {
    const session = editSession()
    expect([session.change(), session.change(), session.change()]).toEqual([true, false, false])
  })

  it('starts a new undo step once the focus has finished', () => {
    const session = editSession()
    session.change()
    session.finish()
    expect(session.change()).toBe(true)
  })

  it('leaves nothing to drop when Esc comes before any write', () => {
    expect(editSession().cancel()).toBe(false)
  })

  it('drops the snapshot when Esc follows a write, and the next write snapshots again', () => {
    const session = editSession()
    session.change()
    expect(session.cancel()).toBe(true)
    expect(session.change()).toBe(true)
  })
})

describe('hasStroke', () => {
  it('draws a stroke only with a colour and a weight', () => {
    expect(hasStroke(rectangle())).toBe(true)
    expect(hasStroke({ ...rectangle(), stroke: 'none' })).toBe(false)
    expect(hasStroke({ ...rectangle(), strokeWidth: 0 })).toBe(false)
  })

  it('is false for a shape that has no stroke at all', () => {
    const highlight = parsedNode('highlight')
    if (isKnownNode(highlight) && highlight.type === 'highlight') expect(hasStroke(highlight)).toBe(false)
  })
})

describe('segmentAngle: R for an arrow or line', () => {
  const line = (points: readonly number[], rotation = 0): KnownNode => ({
    id: 'line',
    type: 'line',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation },
    points,
    stroke: '#000000',
    strokeWidth: 2,
    opacity: 1,
  })

  it('reads the angle the points make, which is what `transform.rotation` cannot see', () => {
    // The bug this exists for: a sloping line reports rotation 0, because its slope is in its points.
    expect(readInspectorField(line([0, 0, 100, 100]), 'transform.rotation')).toBe(0)
    expect(readInspectorField(line([0, 0, 100, 100]), 'segmentAngle')).toBe(45)
    expect(readInspectorField(line([0, 0, 100, 0]), 'segmentAngle')).toBe(0)
    expect(readInspectorField(line([0, 0, 0, -100]), 'segmentAngle')).toBe(-90)
  })

  it('adds the transform`s own rotation, and reports one turn as itself', () => {
    expect(readInspectorField(line([0, 0, 100, 0], 30), 'segmentAngle')).toBe(30)
    expect(readInspectorField(line([0, 0, 100, 100], 315), 'segmentAngle')).toBe(0)
  })

  it('swings both ends about the midpoint, keeping the length and the centre', () => {
    const node = line([0, 0, 100, 0])
    expect(writeInspectorField(node, 'segmentAngle', 90)).toBe(true)
    const points = 'points' in node ? node.points : []
    expect(points.map(Math.round)).toEqual([50, -50, 50, 50])
    expect(readInspectorField(node, 'segmentAngle')).toBe(90)
  })

  it('is not a field a rectangle has', () => {
    expect(readInspectorField(rectangle(), 'segmentAngle')).toBeUndefined()
    expect(writeInspectorField(rectangle(), 'segmentAngle', 45)).toBe(false)
  })
})
