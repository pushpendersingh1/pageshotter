import { describe, expect, it } from 'vitest'
import { badgeText, readSkip, readStatus, requestSkip } from '../src/batch/batch-status'

describe('readStatus', () => {
  const status = { tabId: 7, source: 'tabs', total: 10, done: 3, current: 'Hacker News', currentPosition: 4, stopping: false }

  it('reads what the Batch page wrote', () => {
    expect(readStatus(JSON.stringify(status))).toEqual(status)
  })

  it('offers no page to skip unless it names one', () => {
    expect(readStatus(JSON.stringify({ ...status, currentPosition: undefined }))?.currentPosition).toBe(0)
  })

  it('never reports more pages done than the batch has', () => {
    expect(readStatus(JSON.stringify({ ...status, done: 12 }))?.done).toBe(10)
  })

  it('rejects anything it did not write', () => {
    expect(readStatus(null)).toBeUndefined()
    expect(readStatus('{')).toBeUndefined()
    expect(readStatus(JSON.stringify({ ...status, tabId: 'x' }))).toBeUndefined()
    expect(readStatus(JSON.stringify({ ...status, source: 'files' }))).toBeUndefined()
    expect(readStatus(JSON.stringify({ ...status, total: 0 }))).toBeUndefined()
    expect(readStatus(JSON.stringify({ ...status, done: -1 }))).toBeUndefined()
  })
})

describe('skip requests', () => {
  it('name the page they were pressed for, and change on every press', () => {
    const written: string[] = []
    const storage = { setItem: (_key: string, value: string) => void written.push(value) } as Storage
    requestSkip(storage, 4, 1_000)
    requestSkip(storage, 4, 1_001)
    expect(written[0]).not.toBe(written[1])
    expect(written.map(readSkip)).toEqual([4, 4])
  })

  it('name no page when they are not ours', () => {
    expect(readSkip(null)).toBeUndefined()
    expect(readSkip('soon')).toBeUndefined()
    expect(readSkip('0:5')).toBeUndefined()
  })
})

describe('badgeText', () => {
  it('shows done out of total while it fits a badge', () => {
    expect(badgeText(3, 10)).toBe('3/10')
    expect(badgeText(0, 9)).toBe('0/9')
  })

  it('falls back to the finished count rather than a cut-off fraction', () => {
    expect(badgeText(12, 150)).toBe('12')
    expect(badgeText(10, 10)).toBe('10')
  })
})
