import type { BatchSource } from './batch-plan'

/*
 * A running batch, as the popup sees it. The Batch page runs the batch from a tab nobody is looking
 * at, so it writes where it has got to here, and the popup -- opened over whichever page is being
 * captured -- reads it, follows it as it changes, and can ask the Batch page to stop.
 *
 * `localStorage` rather than a message, for the same reasons as the handoff: every extension page
 * shares it, a write is synchronous, and a `storage` event reaches every other page as it lands, so
 * neither side has to be listening at the moment the other one speaks.
 */

export interface BatchStatus {
  /** The Batch page's tab, so the popup can bring it to the front, and tell when it has gone. */
  tabId: number
  source: BatchSource
  total: number
  /** Pages finished, saved or not. */
  done: number
  /** The page being worked on: its title, or its address while it has none. */
  current: string
  /** Its number in the list while it can be skipped, and `0` while it cannot. */
  currentPosition: number
  stopping: boolean
}

export const BATCH_STATUS_KEY = 'pageshotter-batch-status'
export const BATCH_STOP_KEY = 'pageshotter-batch-stop'
export const BATCH_SKIP_KEY = 'pageshotter-batch-skip'

export function writeStatus(storage: Storage, status: BatchStatus): void {
  storage.setItem(BATCH_STATUS_KEY, JSON.stringify(status))
}

export function clearStatus(storage: Storage): void {
  storage.removeItem(BATCH_STATUS_KEY)
}

export function readStatus(raw: string | null): BatchStatus | undefined {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { tabId, source, total, done, current, currentPosition, stopping } = parsed as Partial<Record<keyof BatchStatus, unknown>>
  if (!Number.isInteger(tabId) || (source !== 'urls' && source !== 'tabs')) return undefined
  if (!Number.isInteger(total) || !Number.isInteger(done) || (total as number) < 1 || (done as number) < 0) return undefined
  return {
    tabId: tabId as number,
    source,
    total: total as number,
    done: Math.min(done as number, total as number),
    current: typeof current === 'string' ? current : '',
    currentPosition: Number.isInteger(currentPosition) && (currentPosition as number) > 0 ? (currentPosition as number) : 0,
    stopping: stopping === true,
  }
}

/**
 * Asks the Batch page to stop. The value changes every time, because a `storage` event only fires
 * when a value does -- a second press with the same value would never arrive.
 */
export function requestStop(storage: Storage, now: number): void {
  storage.setItem(BATCH_STOP_KEY, String(now))
}

/**
 * Asks the Batch page to skip one page, named by its number in the list. A skip that arrives after
 * that page finished must not be spent on the next one, so the Batch page checks the number against
 * the page in hand. The time makes each press a new value, as for Stop.
 */
export function requestSkip(storage: Storage, position: number, now: number): void {
  storage.setItem(BATCH_SKIP_KEY, `${position}:${now}`)
}

/** The page a skip was meant for, or `undefined` for anything else. */
export function readSkip(raw: string | null): number | undefined {
  const position = Number(raw?.split(':')[0])
  return Number.isInteger(position) && position > 0 ? position : undefined
}

/**
 * The toolbar badge: pages finished out of the total while that fits, the finished count alone once
 * it does not. A badge shows about four characters, and `12/150` cut to `12/1` would read as a
 * different, wrong number.
 */
export function badgeText(done: number, total: number): string {
  const both = `${done}/${total}`
  return both.length <= 4 ? both : String(done)
}
