import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  waitForDownloadCompletion,
  type DownloadDelta,
  type DownloadItem,
  type DownloadsApi,
} from '../src/result/download-completion'

function downloads(items: DownloadItem[] = []): {
  api: DownloadsApi
  emit: (delta: DownloadDelta) => void
  listeners: Set<(delta: DownloadDelta) => void>
} {
  const listeners = new Set<(delta: DownloadDelta) => void>()
  return {
    listeners,
    emit: (delta) => listeners.forEach((listener) => listener(delta)),
    api: {
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
      search: vi.fn().mockResolvedValue(items),
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('download completion', () => {
  it('reconciles a download that completed before its id could be watched', async () => {
    vi.useFakeTimers()
    const chromeDownloads = downloads([{ id: 7, state: 'complete' }])

    const outcome = waitForDownloadCompletion(chromeDownloads.api, 7, 1_000)
    await vi.runAllTimersAsync()

    expect(await outcome).toBe('saved')
  })

  it('resolves from a later complete event and removes its listener', async () => {
    const chromeDownloads = downloads([{ id: 7, state: 'in_progress' }])
    const outcome = waitForDownloadCompletion(chromeDownloads.api, 7)

    chromeDownloads.emit({ id: 7, state: { current: 'complete' } })

    expect(await outcome).toBe('saved')
    expect(chromeDownloads.listeners.size).toBe(0)
  })

  it('reports an interrupted download from Chrome\'s current state', async () => {
    const chromeDownloads = downloads([{ id: 7, state: 'interrupted' }])

    await expect(waitForDownloadCompletion(chromeDownloads.api, 7)).resolves.toBe('interrupted')
    expect(chromeDownloads.listeners.size).toBe(0)
  })

  it('does not mistake another download for this one', async () => {
    vi.useFakeTimers()
    const chromeDownloads = downloads([{ id: 7, state: 'in_progress' }])
    const outcome = waitForDownloadCompletion(chromeDownloads.api, 7, 1_000)

    chromeDownloads.emit({ id: 8, state: { current: 'complete' } })
    await vi.runAllTimersAsync()

    expect(await outcome).toBe('unknown')
  })
})
