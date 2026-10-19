import { describe, expect, it } from 'vitest'
import { contextMenuMode } from '../src/shared/context-menu'

describe('contextMenuMode', () => {
  it('maps each right-click item to the capture the popup starts', () => {
    expect(contextMenuMode('capture-full')).toBe('full')
    expect(contextMenuMode('capture-visible')).toBe('visible')
    expect(contextMenuMode('capture-region')).toBe('region')
  })

  /* The listener sees every click on every item; anything that is not ours must start nothing. */
  it('ignores an id it did not create', () => {
    expect(contextMenuMode('capture-everything')).toBeUndefined()
    expect(contextMenuMode(0)).toBeUndefined()
  })
})
