import { describe, expect, it } from 'vitest'
import {
  LAYER_ROW_HEIGHT,
  hitTest,
  invert,
  nodeBounds,
  MAX_GROUP_DEPTH,
  canDrop,
  depthOf,
  duplicateNodesInPlace,
  dropPositionFor,
  findNode,
  groupNodes,
  isGroupNode,
  countAnnotations,
  layerNames,
  layerRows,
  moveNode,
  outermostOf,
  parentOf,
  parseSceneDoc,
  reorderNodes,
  resolveShapes,
  subtreeDepth,
  ungroupNode,
  type SceneDoc,
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

function ids(scene: SceneDoc, collapsed = new Set<string>()): string[] {
  return layerRows(scene, collapsed).map((row) => row.id)
}

describe('drop bands', () => {
  it('splits a group row into 8px before, 14px inside and 8px after', () => {
    expect(LAYER_ROW_HEIGHT).toBe(30)
    expect(dropPositionFor(0, true)).toBe('before')
    expect(dropPositionFor(7.9, true)).toBe('before')
    expect(dropPositionFor(8, true)).toBe('inside')
    expect(dropPositionFor(21.9, true)).toBe('inside')
    expect(dropPositionFor(22, true)).toBe('after')
    expect(dropPositionFor(29.9, true)).toBe('after')
  })

  it('gives a non-group row no middle band at all', () => {
    expect(dropPositionFor(14.9, false)).toBe('before')
    expect(dropPositionFor(15, false)).toBe('after')
  })
})

describe('layer rows', () => {
  it('lists the top-most node first, which is the reverse of document order', () => {
    expect(ids(doc([box('bottom'), box('middle'), box('top')]))).toEqual(['top', 'middle', 'bottom'])
  })

  it('places a group above its own children and reverses those too', () => {
    expect(ids(doc([group('g', [box('a'), box('b')])]))).toEqual(['g', 'b', 'a'])
  })

  it('drops a collapsed group’s children without dropping the group', () => {
    expect(ids(doc([group('g', [box('a')])]), new Set(['g']))).toEqual(['g'])
  })

  it('carries the depth the panel indents by', () => {
    const rows = layerRows(doc([group('g', [group('h', [box('a')])])]))
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['g', 0],
      ['h', 1],
      ['a', 2],
    ])
  })

  it('names the parent of every nested row', () => {
    const rows = layerRows(doc([group('g', [box('a')])]))
    expect(rows.map((row) => row.parentId)).toEqual([undefined, 'g'])
  })

  it('puts every row a blur paints over below the blur’s own row', () => {
    // A subtree is contiguous in document order, so "below in the panel" is exactly "earlier in the
    // render walk". The layers panel once drew this relationship as a wash; the fact
    // outlives the wash, and export order depends on it, so it stays pinned here.
    const scene = doc([box('a'), group('g', [box('c0'), box('blur', { type: 'blur', radius: 4 }), box('c2')]), box('b')])
    const rows = ids(scene)
    const painted = resolveShapes(scene)
      .slice(
        0,
        resolveShapes(scene).findIndex((shape) => shape.node.id === 'blur'),
      )
      .map((shape) => shape.node.id)
    expect(rows.slice(rows.indexOf('blur') + 1)).toEqual([...painted].reverse())
  })
})

describe('annotation count', () => {
  it('counts nested children but not the groups holding them', () => {
    // 4 shapes in 2 groups, one nested: layerNames(doc).size would say 6.
    const scene = doc([box('a'), group('g', [box('b'), group('h', [box('c'), box('d')])])])
    expect(countAnnotations(scene)).toBe(4)
    expect(layerNames(scene).size).toBe(6)
  })

  it('is zero for a document with nothing on it, and 1 for one shape', () => {
    expect(countAnnotations(doc([]))).toBe(0)
    expect(countAnnotations(doc([box('a')]))).toBe(1)
  })

  it('does not count an empty group', () => {
    expect(countAnnotations(doc([group('g', [])]))).toBe(0)
  })
})

describe('layer names', () => {
  it('numbers each type in document order, so deleting above a shape does not renumber it', () => {
    const names = layerNames(doc([box('a'), box('b'), group('g', [box('c')])]))
    expect(names.get('a')).toBe('Rectangle 1')
    expect(names.get('b')).toBe('Rectangle 2')
    expect(names.get('c')).toBe('Rectangle 3')
    expect(names.get('g')).toBe('Group 1')
  })

  it('lets a typed name win over the ordinal', () => {
    expect(layerNames(doc([box('a', { name: 'Callout' })])).get('a')).toBe('Callout')
  })

  it('names text and emoji after their own content', () => {
    const scene = doc([
      box('t', { type: 'text', text: '  Watch this field  ' }),
      box('e', { type: 'emoji', char: '\u{1F525}' }),
    ])
    const names = layerNames(scene)
    expect(names.get('t')).toBe('Watch this field')
    expect(names.get('e')).toBe('\u{1F525}')
  })

  it('truncates a long text node rather than letting it run the column over', () => {
    const names = layerNames(doc([box('t', { type: 'text', text: 'a'.repeat(40) })]))
    expect(names.get('t')).toBe(`${'a'.repeat(20)}…`)
  })

  it('falls back to the ordinal for empty text', () => {
    expect(layerNames(doc([box('t', { type: 'text', text: '   ' })])).get('t')).toBe('Text 1')
  })
})

describe('finding a node', () => {
  const scene = doc([group('g', [group('h', [box('a')])]), box('b')])

  it('selects the outermost ancestor for a canvas click, and the node itself in the panel', () => {
    expect(outermostOf(scene.nodes, 'a')?.id).toBe('g')
    expect(findNode(scene.nodes, 'a')?.id).toBe('a')
    expect(outermostOf(scene.nodes, 'b')?.id).toBe('b')
  })

  it('ascends one level at a time, and stops at the root', () => {
    expect(parentOf(scene.nodes, 'a')?.id).toBe('h')
    expect(parentOf(scene.nodes, 'h')?.id).toBe('g')
    expect(parentOf(scene.nodes, 'g')).toBeUndefined()
  })

  it('reports depth and subtree depth', () => {
    expect(depthOf(scene.nodes, 'a')).toBe(2)
    expect(subtreeDepth(scene.nodes[0] as never)).toBe(2)
    expect(subtreeDepth(scene.nodes[1] as never)).toBe(0)
  })
})

describe('dropping', () => {
  it('refuses a drop into itself or into its own descendants, with no indicator to retract', () => {
    const scene = doc([group('g', [box('a')]), box('b')])
    expect(canDrop(scene.nodes, 'g', 'g', 'inside')).toBe(false)
    expect(canDrop(scene.nodes, 'g', 'a', 'inside')).toBe(false)
    expect(canDrop(scene.nodes, 'g', 'a', 'before')).toBe(false)
    expect(canDrop(scene.nodes, 'b', 'g', 'inside')).toBe(true)
  })

  it('refuses a drop that would push any part of the dragged subtree past the depth cap', () => {
    // Groups live at depths 0…4, which is what `parseNode` will read back, so their children may sit
    // at depth 5 and a leaf can always land. `pair` is a group and cannot land at depth 5.
    const deep = doc([
      group('g1', [group('g2', [group('g3', [group('g4', [group('g5', [box('a')])])])])]),
      group('pair', [box('x')]),
      box('leaf'),
    ])
    expect(MAX_GROUP_DEPTH).toBe(5)
    expect(canDrop(deep.nodes, 'pair', 'g5', 'inside')).toBe(false)
    expect(canDrop(deep.nodes, 'pair', 'g4', 'inside')).toBe(true)
    expect(canDrop(deep.nodes, 'leaf', 'g5', 'inside')).toBe(true)
  })

  it('refuses "inside" on a row that cannot hold children', () => {
    const scene = doc([box('a'), box('b')])
    expect(canDrop(scene.nodes, 'a', 'b', 'inside')).toBe(false)
  })
})

describe('moving', () => {
  it('reads "before" as the panel does — above the target row, later in document order', () => {
    const scene = doc([box('a'), box('b'), box('c')])
    expect(ids(scene)).toEqual(['c', 'b', 'a'])
    expect(moveNode(scene.nodes, 'a', 'c', 'before')).toBe(true)
    expect(ids(scene)).toEqual(['a', 'c', 'b'])
  })

  it('reads "after" as below the target row', () => {
    const scene = doc([box('a'), box('b'), box('c')])
    expect(moveNode(scene.nodes, 'c', 'a', 'after')).toBe(true)
    expect(ids(scene)).toEqual(['b', 'a', 'c'])
  })

  it('drops into a group at the top of its children', () => {
    const scene = doc([group('g', [box('a')]), box('b')])
    expect(moveNode(scene.nodes, 'b', 'g', 'inside')).toBe(true)
    expect(ids(scene)).toEqual(['g', 'b', 'a'])
  })

  it('takes a group’s children with it in one move', () => {
    const scene = doc([box('a'), group('g', [box('c1'), box('c2')])])
    expect(moveNode(scene.nodes, 'g', 'a', 'after')).toBe(true)
    expect(ids(scene)).toEqual(['a', 'g', 'c2', 'c1'])
  })

  it('changes nothing when the drop is refused', () => {
    const scene = doc([group('g', [box('a')])])
    const before = ids(scene)
    expect(moveNode(scene.nodes, 'g', 'a', 'inside')).toBe(false)
    expect(ids(scene)).toEqual(before)
  })
})

describe('keyboard ordering', () => {
  it('moves a selection one sibling forward or backward', () => {
    const scene = doc([box('a'), box('b'), box('c')])

    expect(reorderNodes(scene.nodes, ['b'], 'forward')).toBe(true)
    expect(ids(scene)).toEqual(['b', 'c', 'a'])
    expect(reorderNodes(scene.nodes, ['b'], 'forward')).toBe(false)
    expect(reorderNodes(scene.nodes, ['b'], 'backward')).toBe(true)
    expect(ids(scene)).toEqual(['c', 'b', 'a'])

    const pair = doc([box('a'), box('b'), box('c')])
    expect(reorderNodes(pair.nodes, ['a', 'b'], 'forward')).toBe(true)
    expect(ids(pair)).toEqual(['b', 'a', 'c'])
  })

  it('moves to a sibling edge without reversing a multi-selection', () => {
    const scene = doc([box('a'), box('b'), box('c'), box('d')])

    expect(reorderNodes(scene.nodes, ['a', 'c'], 'front')).toBe(true)
    expect(ids(scene)).toEqual(['c', 'a', 'd', 'b'])
    expect(reorderNodes(scene.nodes, ['a', 'c'], 'front')).toBe(false)
    expect(reorderNodes(scene.nodes, ['a', 'c'], 'back')).toBe(true)
    expect(ids(scene)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('keeps a child inside its parent and moves a selected group as one subtree', () => {
    const scene = doc([group('g', [box('a'), box('b')]), box('root')])

    expect(reorderNodes(scene.nodes, ['a'], 'front')).toBe(true)
    expect(ids(scene)).toEqual(['root', 'g', 'a', 'b'])
    expect(reorderNodes(scene.nodes, ['g'], 'front')).toBe(true)
    expect(ids(scene)).toEqual(['g', 'a', 'b', 'root'])

    const nestedSelection = doc([group('g', [box('a'), box('b')]), box('root')])
    expect(reorderNodes(nestedSelection.nodes, ['g', 'a'], 'front')).toBe(true)
    expect(ids(nestedSelection)).toEqual(['g', 'b', 'a', 'root'])
  })

  it('does not reorder a locked node or anything inside a locked group', () => {
    const scene = doc([
      box('a'),
      box('locked', { locked: true }),
      group('g', [box('child'), box('sibling')], { locked: true }),
    ])
    const before = ids(scene)

    expect(reorderNodes(scene.nodes, ['locked'], 'front')).toBe(false)
    expect(reorderNodes(scene.nodes, ['child'], 'front')).toBe(false)
    expect(ids(scene)).toEqual(before)
  })

  it('changes which shapes are beneath a blur by changing document order', () => {
    const scene = doc([box('below'), box('blur', { type: 'blur', radius: 4 }), box('above')])

    expect(reorderNodes(scene.nodes, ['blur'], 'front')).toBe(true)
    const order = resolveShapes(scene).map((shape) => shape.node.id)
    expect(order.slice(0, order.indexOf('blur'))).toEqual(['below', 'above'])
  })
})

describe('drag duplication', () => {
  it('leaves a fresh-id copy beside the selected node in the same parent', () => {
    const scene = doc([group('g', [box('a'), box('b')]), box('root')])

    expect(duplicateNodesInPlace(scene.nodes, ['a'])).toBe(true)
    const parent = findNode(scene.nodes, 'g')
    expect(parent && isGroupNode(parent) ? parent.children.map((node) => node.id) : []).toEqual([
      expect.not.stringMatching(/^(a|b)$/),
      'a',
      'b',
    ])
  })

  it('copies a selected group once with fresh descendant ids', () => {
    const scene = doc([group('g', [box('a'), box('b')]), box('root')])

    expect(duplicateNodesInPlace(scene.nodes, ['g', 'a'])).toBe(true)
    const copy = scene.nodes[0]
    expect(copy?.id).not.toBe('g')
    expect(scene.nodes.map((node) => node.id)).toEqual([copy?.id, 'g', 'root'])
    expect(copy && isGroupNode(copy) ? copy.children.map((node) => node.id) : []).toEqual([
      expect.not.stringMatching(/^(a|b)$/),
      expect.not.stringMatching(/^(a|b)$/),
    ])
    const original = findNode(scene.nodes, 'g')
    expect(original && isGroupNode(original) ? original.children.map((node) => node.id) : []).toEqual(['a', 'b'])
  })

  it('does not copy a locked node or anything inside a locked group', () => {
    const scene = doc([box('locked', { locked: true }), group('g', [box('child')], { locked: true })])
    const before = structuredClone(scene.nodes)

    expect(duplicateNodesInPlace(scene.nodes, ['locked', 'child'])).toBe(false)
    expect(scene.nodes).toEqual(before)
  })
})

describe('grouping', () => {
  it('groups siblings where the top-most of them sat', () => {
    const scene = doc([box('a'), box('b'), box('c')])
    const made = groupNodes(scene.nodes, ['a', 'c'], 'g')
    expect(made?.id).toBe('g')
    expect(ids(scene)).toEqual(['g', 'c', 'a', 'b'])
  })

  it('refuses to group across two parents, or to group one node', () => {
    const scene = doc([group('g', [box('a')]), box('b')])
    expect(groupNodes(scene.nodes, ['a', 'b'], 'new')).toBeUndefined()
    expect(groupNodes(scene.nodes, ['b'], 'new')).toBeUndefined()
  })

  it('refuses a group that would exceed the depth cap', () => {
    const deep = doc([group('g1', [group('g2', [group('g3', [group('g4', [group('g5', [box('a'), box('b')])])])])])])
    expect(groupNodes(deep.nodes, ['a', 'b'], 'new')).toBeUndefined()
    const shallow = doc([group('g1', [group('g2', [group('g3', [group('g4', [box('a'), box('b')])])])])])
    expect(groupNodes(shallow.nodes, ['a', 'b'], 'new')?.id).toBe('new')
  })

  it('ungroups back into the same order', () => {
    const scene = doc([box('a'), box('b'), box('c')])
    groupNodes(scene.nodes, ['a', 'c'], 'g')
    expect(ungroupNode(scene.nodes, 'g')).toEqual(['a', 'c'])
    expect(ids(scene)).toEqual(['c', 'a', 'b'])
  })

  it('folds the group’s transform into each child so nothing moves', () => {
    const scene = doc([group('g', [box('a', { transform: { x: 5, y: 7 } })], { transform: { x: 100, y: 20, scaleX: 2, scaleY: 2 } })])
    const before = resolveShapes(scene)[0]?.bounds
    ungroupNode(scene.nodes, 'g')
    const after = resolveShapes(scene)[0]?.bounds
    expect(after?.x).toBeCloseTo(before?.x ?? NaN, 6)
    expect(after?.y).toBeCloseTo(before?.y ?? NaN, 6)
    expect(after?.width).toBeCloseTo(before?.width ?? NaN, 6)
  })

  it('folds the group’s opacity into each child too', () => {
    const scene = doc([group('g', [box('a', { opacity: 0.5 })], { opacity: 0.5 })])
    ungroupNode(scene.nodes, 'g')
    const child = findNode(scene.nodes, 'a')
    expect(child && !isGroupNode(child) ? child.opacity : 0).toBeCloseTo(0.25, 6)
  })
})

describe('picking on the canvas', () => {
  it('returns the top-most shape under the point, and nothing outside every shape', () => {
    const scene = doc([box('under'), box('over', { transform: { x: 20, y: 10 } })])
    expect(hitTest(scene, 30, 20)?.id).toBe('over')
    expect(hitTest(scene, 5, 5)?.id).toBe('under')
    expect(hitTest(scene, 400, 400)).toBeUndefined()
  })

  it('skips a locked node, and a node locked by an ancestor group', () => {
    // Locking exists so a node stops swallowing canvas clicks; the panel still selects it.
    const scene = doc([box('under'), box('over', { locked: true })])
    expect(hitTest(scene, 10, 10)?.id).toBe('under')
    const nested = doc([box('under'), group('g', [box('over')], { locked: true })])
    expect(hitTest(nested, 10, 10)?.id).toBe('under')
  })

  it('skips a hidden node, which is not in the picture at all', () => {
    const scene = doc([box('under'), box('over', { hidden: true })])
    expect(hitTest(scene, 10, 10)?.id).toBe('under')
  })

  it('hits a rotated shape where it is drawn, not anywhere in the box it spans', () => {
    const scene = doc([box('r', { transform: { x: 0, y: 0, rotation: 45 } })])
    // The rotated 100×50 box runs down-right from the origin; its top-right corner is empty.
    expect(hitTest(scene, 40, 40)?.id).toBe('r')
    expect(hitTest(scene, 60, 2)).toBeUndefined()
  })

  it('takes a group transform into account through its children', () => {
    const scene = doc([group('g', [box('a')], { transform: { x: 500, y: 400 } })])
    expect(hitTest(scene, 10, 10)).toBeUndefined()
    expect(hitTest(scene, 520, 420)?.id).toBe('a')
  })
})

describe('a node’s own rectangle', () => {
  it('gives a leaf its own bounds and a group the union of its children’s', () => {
    const scene = doc([group('g', [box('a'), box('b', { transform: { x: 200, y: 100 } })])])
    expect(nodeBounds(scene, 'a')).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(nodeBounds(scene, 'g')).toEqual({ x: 0, y: 0, width: 300, height: 150 })
  })

  it('leaves a hidden child out of a group’s box, and reports nothing for an empty group', () => {
    const scene = doc([group('g', [box('a'), box('b', { transform: { x: 200, y: 100 }, hidden: true })])])
    expect(nodeBounds(scene, 'g')).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(nodeBounds(doc([group('empty', [])]), 'empty')).toBeUndefined()
    expect(nodeBounds(scene, 'nope')).toBeUndefined()
  })

  it('inverts a matrix, and refuses one that has collapsed', () => {
    const inverse = invert([2, 0, 0, 2, 10, 20]) ?? []
    expect([...inverse].map((value) => value + 0)).toEqual([0.5, 0, 0, 0.5, -5, -10])
    expect(invert([0, 0, 0, 0, 0, 0])).toBeUndefined()
  })
})
