import { afterEach, describe, expect, it, vi } from 'vitest'
import { putJob } from '../src/shared/capture-db'
import type { CaptureJob } from '../src/shared/messages'

/** Just enough of IndexedDB to open a connection whose one transaction aborts. */
function abortingDatabase() {
  const transaction = {
    error: new DOMException('quota', 'QuotaExceededError'),
    onabort: null as null | (() => void),
    objectStore: () => ({ put: () => setTimeout(() => transaction.onabort?.()) }),
  }
  const database = { close: vi.fn(), transaction: () => transaction }
  const factory = {
    open: () => {
      const request = { result: database, onsuccess: null as null | (() => void) }
      setTimeout(() => request.onsuccess?.())
      return request
    },
  }
  return { database, factory }
}

describe('capture-db connection lifetime', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('closes the connection when the transaction fails', async () => {
    // The audit's A3: every operation awaited its work and closed afterwards with no `finally`, so a
    // rejected write left the connection open -- and an open connection blocks the next upgrade.
    const { database, factory } = abortingDatabase()
    vi.stubGlobal('indexedDB', factory)
    await expect(putJob({ id: 'job' } as CaptureJob)).rejects.toThrow('quota')
    expect(database.close).toHaveBeenCalledOnce()
  })
})
