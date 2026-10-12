import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../src/shared/history'
import type { CaptureJob } from '../src/shared/messages'

const db = vi.hoisted(() => ({
  getSetting: vi.fn(),
  deleteHistoryEntries: vi.fn(),
  replaceHistoryEntry: vi.fn(),
  getHistoryTiles: vi.fn(),
}))
vi.mock('../src/shared/capture-db', () => db)

const { saveCaptureToHistory } = await import('../src/result/history-io')

const DAY = 24 * 60 * 60 * 1000
const job = { id: 'new', createdAt: Date.now(), title: 'Page', url: 'https://example.test/', segmentCount: 1 } as CaptureJob
const image = { width: 10, height: 10, scaleX: 1, scaleY: 1, tiles: [{ offsetY: 0, width: 10, height: 10, blob: new Blob(['x']) }] }
// Stored long before a one-day retention window, so retention must evict it.
const expired = { id: 'old', createdAt: Date.now() - 30 * DAY, bytes: 1 } as HistoryEntry

describe('saveCaptureToHistory', () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset()
    db.getSetting.mockResolvedValue(1)
    db.replaceHistoryEntry.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'))
  })

  it('evicts nothing when the new capture cannot be written', async () => {
    // The audit's A3: eviction used to commit in its own transaction before the write, so a quota
    // failure lost older captures and kept nothing in their place.
    await expect(saveCaptureToHistory(job, image)).rejects.toThrow('quota')
    expect(db.deleteHistoryEntries).not.toHaveBeenCalled()
  })

  it('decides evictions against the entries stored at write time, never the incoming capture', async () => {
    db.replaceHistoryEntry.mockResolvedValue(undefined)
    await expect(saveCaptureToHistory(job, image)).resolves.toBe(true)
    const [entry, tiles, , evict] = db.replaceHistoryEntry.mock.lastCall!
    expect(entry.id).toBe('new')
    expect(tiles).toHaveLength(1)
    expect(evict([expired, { ...expired, id: 'new', createdAt: Date.now() - 30 * DAY }])).toEqual(['old'])
  })
})
