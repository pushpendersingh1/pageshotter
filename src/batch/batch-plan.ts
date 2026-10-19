import { getSetting, putSetting } from '../shared/capture-db'
import { EXPORT_FORMATS, type ExportFormat } from '../result/export-options'

/*
 * Batch capture: a list of URLs, each opened, captured and saved in turn -- or the tabs already open
 * in a window, each captured where it is.
 *
 * Everything here is pure except the two storage calls at the bottom, so the rules a batch lives by
 * -- which lines are URLs, what a file is called, where it goes -- can be proved in Node.
 */

/** A line that was not used, and why, so the page can say so instead of dropping it silently. */
export interface RejectedLine {
  line: string
  reason: string
}

export interface ParsedBatch {
  urls: string[]
  rejected: RejectedLine[]
}

/**
 * The URLs in what the user pasted.
 *
 * Whitespace of any kind separates entries, so a list copied from a spreadsheet column, a chat
 * message or a single line all work. A bare host gets `https://`, as FireShot does, because that is
 * what someone typing `example.com` means. Anything that is not then a real http or https address
 * is reported rather than guessed at: a batch that silently skipped half the list would look like
 * it had captured everything.
 *
 * Duplicates are dropped after normalising, so `example.com` and `https://example.com/` are one
 * page. Repeating a page in a batch only ever produces the same file twice.
 */
export function parseBatchUrls(text: string): ParsedBatch {
  const urls: string[] = []
  const seen = new Set<string>()
  const rejected: RejectedLine[] = []
  for (const entry of text.split(/\s+/)) {
    if (entry === '') continue
    // `host:8080` is a port, not a scheme: a scheme is never followed by a digit.
    const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(entry) ? entry : `https://${entry}`
    let url: URL
    try {
      url = new URL(withScheme)
    } catch {
      rejected.push({ line: entry, reason: 'not a web address' })
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      rejected.push({ line: entry, reason: 'only http and https pages can be batch captured' })
      continue
    }
    // `new URL('https://foo')` succeeds, so a host with no dot is checked by hand. `localhost` is the
    // one dotless name anyone means on purpose.
    if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[')) {
      rejected.push({ line: entry, reason: 'not a web address' })
      continue
    }
    if (seen.has(url.href)) continue
    seen.add(url.href)
    urls.push(url.href)
  }
  return { urls, rejected }
}

/** Where a batch's pages come from: addresses typed in, or the tabs already open in this window. */
export type BatchSource = 'urls' | 'tabs'

/** The popup's "All tabs" opens the page with `?source=tabs`; anything else is the address list. */
export function batchSource(search: string): BatchSource {
  return new URLSearchParams(search).get('source') === 'tabs' ? 'tabs' : 'urls'
}

/**
 * Whether an open tab is worth offering. The browser's own pages, other extensions' pages and the
 * store refuse extensions outright; a tab whose address PageShotter cannot even read is one of them.
 * A local file is offered: it can be captured once file access is allowed for the extension, and
 * the capture says so when it is not.
 */
export function tabCapturable(url: string | undefined): boolean {
  return url !== undefined && /^(https?|file):/i.test(url)
}

/** How many distinct sites a list touches, for the summary under the box. */
export function siteCount(urls: readonly string[]): number {
  return new Set(urls.map((url) => new URL(url).host)).size
}

/**
 * A batch file's name: its place in the list, then the name a single capture would get.
 *
 * The number comes first so a folder sorted by name is in list order -- every file in a batch is
 * captured within minutes, so the date the ordinary name starts with cannot order them. It is
 * padded to the width of the largest number, so 9 sorts before 10.
 */
export function batchFilename(position: number, total: number, filename: string): string {
  const width = String(Math.max(1, total)).length
  return `${String(position).padStart(width, '0')}-${filename}`
}

/** The subfolder one batch saves into: `pageshotter-batch-2026-10-19-1405`, in local time. */
export function batchFolderName(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `pageshotter-batch-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  )
}

/** The folder a batch writes into: the Settings save folder, then the batch's own, either optional. */
export function batchFolder(saveFolder: string, subfolder: string | undefined): string {
  return [saveFolder, subfolder].filter((part) => part !== undefined && part !== '').join('/')
}

export type BatchMode = 'full' | 'visible'

/** `0` means no limit: the page is waited on for as long as it takes, and Stop is the way out. */
export const LOAD_TIMEOUT_CHOICES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 10_000, label: '10 seconds' },
  { ms: 30_000, label: '30 seconds' },
  { ms: 60_000, label: '60 seconds' },
  { ms: 0, label: 'No limit' },
]

/**
 * Time after the page reports itself loaded, before capture starts.
 *
 * A single capture never needed this: the user has already looked at the page, so it has rendered.
 * A batch opens the page itself, and an application that draws after its load event would otherwise
 * be photographed as a spinner. The capture's own adaptive waiting starts with the first scroll, too
 * late to help the first screen.
 */
export const RENDER_WAIT_CHOICES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 0, label: 'None' },
  { ms: 5_000, label: '5 seconds' },
  { ms: 10_000, label: '10 seconds' },
  { ms: 30_000, label: '30 seconds' },
  { ms: 60_000, label: '60 seconds' },
]

export interface BatchOptions {
  mode: BatchMode
  /** Absent until chosen here, so the batch starts on the Settings file type rather than its own. */
  format?: ExportFormat
  loadTimeoutMs: number
  renderWaitMs: number
  subfolder: boolean
  showFolder: boolean
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  mode: 'full',
  loadTimeoutMs: 30_000,
  renderWaitMs: 5_000,
  subfolder: true,
  showFolder: true,
}

function offered(choices: ReadonlyArray<{ ms: number }>, value: unknown, fallback: number): number {
  return typeof value === 'number' && choices.some((choice) => choice.ms === value) ? value : fallback
}

/** Whatever was stored, as options the page can show: anything unrecognised falls back to its default. */
export function readBatchOptions(stored: unknown): BatchOptions {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Partial<Record<keyof BatchOptions, unknown>>) : {}
  const options: BatchOptions = {
    mode: raw.mode === 'visible' ? 'visible' : 'full',
    loadTimeoutMs: offered(LOAD_TIMEOUT_CHOICES, raw.loadTimeoutMs, DEFAULT_BATCH_OPTIONS.loadTimeoutMs),
    renderWaitMs: offered(RENDER_WAIT_CHOICES, raw.renderWaitMs, DEFAULT_BATCH_OPTIONS.renderWaitMs),
    subfolder: typeof raw.subfolder === 'boolean' ? raw.subfolder : DEFAULT_BATCH_OPTIONS.subfolder,
    showFolder: typeof raw.showFolder === 'boolean' ? raw.showFolder : DEFAULT_BATCH_OPTIONS.showFolder,
  }
  if (EXPORT_FORMATS.includes(raw.format as ExportFormat)) options.format = raw.format as ExportFormat
  return options
}

/**
 * What a batch needs from the browser before it can start.
 *
 * `<all_urls>` because `tabs.captureVisibleTab` accepts nothing narrower: a grant for the listed
 * sites alone is refused before the page's origin is even looked at. `downloads` because a batch
 * saves a file per page, into its own folder, without the browser asking about each one.
 */
export const BATCH_PERMISSIONS: chrome.permissions.Permissions = { permissions: ['downloads'], origins: ['<all_urls>'] }

const BATCH_OPTIONS_KEY = 'batchOptions'

export async function getBatchOptions(): Promise<BatchOptions> {
  return readBatchOptions(await getSetting<unknown>(BATCH_OPTIONS_KEY))
}

export async function setBatchOptions(options: BatchOptions): Promise<void> {
  await putSetting(BATCH_OPTIONS_KEY, readBatchOptions(options))
}
