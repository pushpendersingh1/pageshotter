import { describe, expect, it } from 'vitest'
import { readDraft, readHandoff, takeHandoff, writeDraft, writeHandoff } from '../src/batch/batch-handoff'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

describe('batch handoff', () => {
  it('carries the popup choice to the batch page once', () => {
    const storage = memoryStorage()
    writeHandoff(storage, { source: 'tabs', urls: '', tabIds: [4, 9], at: 1_000 })
    expect(takeHandoff(storage, 2_000)).toEqual({ source: 'tabs', urls: '', tabIds: [4, 9], at: 1_000 })
    // A reload of the batch page must not start the same batch again.
    expect(takeHandoff(storage, 2_000)).toBeUndefined()
  })

  it('ignores a handoff left behind by a batch page that never opened', () => {
    const raw = JSON.stringify({ source: 'urls', urls: 'example.com', tabIds: [], at: 1_000 })
    expect(readHandoff(raw, 1_000 + 60_000)?.urls).toBe('example.com')
    expect(readHandoff(raw, 1_000 + 60_001)).toBeUndefined()
  })

  it('rejects anything it did not write', () => {
    expect(readHandoff(null, 0)).toBeUndefined()
    expect(readHandoff('not json', 0)).toBeUndefined()
    expect(readHandoff(JSON.stringify({ source: 'files', at: 0 }), 0)).toBeUndefined()
    expect(readHandoff(JSON.stringify({ source: 'urls' }), 0)).toBeUndefined()
    expect(readHandoff(JSON.stringify({ source: 'urls', at: 5 }), 0)).toBeUndefined()
  })

  it('keeps only whole tab ids', () => {
    const raw = JSON.stringify({ source: 'tabs', tabIds: [3, '7', 2.5, null, 8], at: 0 })
    expect(readHandoff(raw, 0)?.tabIds).toEqual([3, 8])
  })
})

describe('address draft', () => {
  it('survives the popup closing, and clears when emptied', () => {
    const storage = memoryStorage()
    expect(readDraft(storage)).toBe('')
    writeDraft(storage, 'example.com\n')
    expect(readDraft(storage)).toBe('example.com\n')
    writeDraft(storage, '  \n')
    expect(storage.length).toBe(0)
  })
})
