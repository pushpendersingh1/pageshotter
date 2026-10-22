import type { BatchSource } from './batch-plan'

/*
 * The popup chooses a batch; the batch page runs it. The popup cannot run one itself: a batch brings
 * each page's tab to the front, and the browser closes a popup the moment another tab does.
 *
 * The choice crosses in `localStorage`, which every extension page shares. It is written
 * synchronously, so it is complete before opening the batch tab closes the popup, and it keeps the
 * addresses out of the page's own address, where they would sit in the browser's history.
 */

export interface BatchHandoff {
  source: BatchSource
  /** The address box's text, as typed. */
  urls: string
  /** The tabs ticked in the popup. */
  tabIds: number[]
  at: number
}

const HANDOFF_KEY = 'pageshotter-batch-handoff'
const DRAFT_KEY = 'pageshotter-batch-draft'

/**
 * Long enough for a slow tab to open, short enough that a handoff left behind by a batch page that
 * never loaded cannot start a batch someone opens hours later.
 */
const HANDOFF_TTL_MS = 60_000

export function writeHandoff(storage: Storage, handoff: BatchHandoff): void {
  storage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
}

/** The waiting handoff, removed as it is read so a reload of the batch page cannot start it twice. */
export function takeHandoff(storage: Storage, now: number): BatchHandoff | undefined {
  const raw = storage.getItem(HANDOFF_KEY)
  storage.removeItem(HANDOFF_KEY)
  return readHandoff(raw, now)
}

export function readHandoff(raw: string | null, now: number): BatchHandoff | undefined {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { source, urls, tabIds, at } = parsed as Partial<Record<keyof BatchHandoff, unknown>>
  if (source !== 'urls' && source !== 'tabs') return undefined
  if (typeof at !== 'number' || now - at > HANDOFF_TTL_MS || at > now) return undefined
  return {
    source,
    urls: typeof urls === 'string' ? urls : '',
    tabIds: Array.isArray(tabIds) ? tabIds.filter((id): id is number => Number.isInteger(id)) : [],
    at,
  }
}

/**
 * The address box, kept as it is typed. Copying an address from another tab closes the popup, and
 * a list that vanished every time would have to be pasted in one go or not at all.
 */
export function readDraft(storage: Storage): string {
  return storage.getItem(DRAFT_KEY) ?? ''
}

export function writeDraft(storage: Storage, text: string): void {
  if (text.trim() === '') storage.removeItem(DRAFT_KEY)
  else storage.setItem(DRAFT_KEY, text)
}
