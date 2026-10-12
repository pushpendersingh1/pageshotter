import { describe, expect, it } from 'vitest'
import { cornersHoldRatio, isImageSource, isKnownNode, localBounds, parseSceneDoc } from '../src/editor/scene'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('image node', () => {
  it('parses a raster data URL with its box', () => {
    const [node] = parseSceneDoc({ nodes: [{ id: 'a', type: 'image', src: PNG, width: 40, height: 20, opacity: 0.5 }] }, 100, 100).nodes
    expect(node).toMatchObject({ type: 'image', src: PNG, width: 40, height: 20, opacity: 0.5 })
    if (!node || !isKnownNode(node) || node.type !== 'image') throw new Error('not an image')
    expect(localBounds(node)).toEqual({ x: 0, y: 0, width: 40, height: 20 })
  })

  it('keeps a source a canvas must not draw verbatim, as an unknown node', () => {
    for (const src of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 42]) {
      const [node] = parseSceneDoc({ nodes: [{ id: 'a', type: 'image', src }] }, 100, 100).nodes
      expect(node && isKnownNode(node)).toBe(false)
      expect(node).toMatchObject({ id: 'a', src })
    }
  })

  it('only accepts png, jpeg, webp and gif', () => {
    expect(['png', 'jpeg', 'webp', 'gif'].every((kind) => isImageSource(`data:image/${kind};base64,AA==`))).toBe(true)
    expect(isImageSource('data:text/html;base64,AA==')).toBe(false)
  })

  it('holds its ratio from a corner', () => {
    expect(cornersHoldRatio(['image'])).toBe(true)
    expect(cornersHoldRatio(['image', 'rectangle'])).toBe(false)
  })
})
