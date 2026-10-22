import { describe, expect, it } from 'vitest'
import { badgeText, readStatus } from '../src/batch/batch-status'

describe('readStatus', () => {
  const status = { tabId: 7, source: 'tabs', total: 10, done: 3, current: 'Hacker News', stopping: false }

  it('reads what the Batch page wrote', () => {
    expect(readStatus(JSON.stringify(status))).toEqual(status)
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
