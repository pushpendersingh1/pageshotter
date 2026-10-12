/** The two terminal states the result page cares about. */
export type DownloadOutcome = 'saved' | 'interrupted' | 'unknown'

export interface DownloadDelta {
  id: number
  state?: { current?: string }
}

export interface DownloadItem {
  id: number
  state: string
}

export interface DownloadsApi {
  onChanged: {
    addListener(listener: (delta: DownloadDelta) => void): void
    removeListener(listener: (delta: DownloadDelta) => void): void
  }
  search(query: { id: number }): Promise<DownloadItem[]>
}

/**
 * Waits for Chrome to report a terminal state for one download.
 *
 * The listener catches future changes. The immediate search reconciles the state Chrome already
 * has, which closes the race where a small blob reaches `complete` before `download()` returns its
 * id and the caller can start watching that id.
 */
export function waitForDownloadCompletion(
  downloads: DownloadsApi,
  id: number,
  timeoutMs = 90_000,
): Promise<DownloadOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const done = (outcome: DownloadOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(backstop)
      downloads.onChanged.removeListener(listener)
      resolve(outcome)
    }
    const listener = (delta: DownloadDelta): void => {
      if (delta.id !== id) return
      if (delta.state?.current === 'complete') done('saved')
      else if (delta.state?.current === 'interrupted') done('interrupted')
    }
    const backstop = setTimeout(() => done('unknown'), timeoutMs)
    downloads.onChanged.addListener(listener)
    void downloads
      .search({ id })
      .then((items) => {
        const item = items.find((candidate) => candidate.id === id)
        if (item?.state === 'complete') done('saved')
        else if (item?.state === 'interrupted') done('interrupted')
      })
      .catch(() => undefined)
  })
}
