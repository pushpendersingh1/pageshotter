/**
 * What history keeps and what it drops, as pure functions over numbers.
 *
 * All of it lives here rather than beside the IndexedDB calls for the reason every measurable part
 * of this codebase does: vitest runs in plain Node with no DOM and no IndexedDB, so a rule that is
 * expressed as a database query cannot be tested at all, while a rule expressed as a function over a
 * list of {id, createdAt, bytes} can be tested exhaustively. Retention is exactly the kind of rule
 * that must not be wrong quietly — the failure is either a disk filling up or someone's screenshot
 * disappearing earlier than they were told.
 */

export interface HistorySummary {
  id: string
  createdAt: number
  bytes: number
}

export interface HistoryLimits {
  /** How long an entry may live. */
  maxAgeMs: number
  /** How many entries may exist, newest kept. */
  maxEntries: number
  /** How many bytes the whole history may occupy, newest kept. */
  maxBytes: number
}

/**
 * The default is deliberately short.
 *
 * Their retention exists to serve a history *feature* people paid for; ours exists so a result tab
 * survives a reload and a capture can be found again the same afternoon. Seven days covers that
 * without quietly accumulating a month of every page the user photographed, which is a thing we
 * would then have to describe on the privacy page and defend in review.
 */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * High enough that the *chosen* retention period is what actually decides how much is kept. A
   * tight count cap would quietly overrule a long period -- someone who picks a year and finds forty
   * screenshots has been told one thing and given another -- so size is the real guard and this is
   * only a backstop against an unbounded row count.
   */
  maxEntries: 500,
  maxBytes: 512 * 1024 * 1024,
}

/**
 * Retention periods offered in settings. `0` days means forever, which is the absence of an age
 * rule rather than a very long one -- the count and size caps still apply, and always did.
 */
export const HISTORY_RETENTION_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 1, label: '1 day' },
  { days: 7, label: 'Week' },
  { days: 30, label: '30 days' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: 'Year' },
  { days: 0, label: 'Forever' },
]

/**
 * Which entries must go, given everything currently stored.
 *
 * Age is applied first and on its own terms: an expired entry is dropped whether or not there is
 * room, because the promise made about a retention period is the one thing here a user actually
 * relies on. Only then do the count and size caps trim from the oldest end, so a burst of very large
 * captures cannot evict something the user was told would still be there tomorrow -- it evicts the
 * next-oldest thing instead.
 *
 * `maxAgeMs` of 0 or less disables expiry, which is how "keep until I delete it" is expressed. The
 * count and size caps still apply: they are the storage safety net, not a preference.
 */
export function expiredHistoryIds(
  entries: HistorySummary[],
  now: number,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): string[] {
  const newestFirst = [...entries].sort((a, b) => b.createdAt - a.createdAt)
  const doomed = new Set<string>()

  if (limits.maxAgeMs > 0) {
    const cutoff = now - limits.maxAgeMs
    for (const entry of newestFirst) if (entry.createdAt < cutoff) doomed.add(entry.id)
  }

  let kept = 0
  let bytes = 0
  for (const entry of newestFirst) {
    if (doomed.has(entry.id)) continue
    kept += 1
    bytes += Math.max(0, entry.bytes)
    if (kept > limits.maxEntries || bytes > limits.maxBytes) doomed.add(entry.id)
  }

  return newestFirst.filter((entry) => doomed.has(entry.id)).map((entry) => entry.id)
}

/**
 * Whether a capture of this size can be admitted at all.
 *
 * A single capture larger than the whole budget would otherwise be written and then immediately
 * evicted by its own size cap, which spends the write and the disk churn to arrive back where it
 * started. Refusing up front lets the caller say so plainly instead.
 */
export function fitsHistoryBudget(bytes: number, limits: HistoryLimits = DEFAULT_HISTORY_LIMITS): boolean {
  return bytes > 0 && bytes <= limits.maxBytes
}

/** Bytes as something a person reads, e.g. `4.2 MB`. Used on the history page's storage line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * How long ago, in the coarse terms a list wants.
 *
 * Deliberately vague past a day: the exact minute a screenshot was taken is never what someone
 * scanning a list needs, and a precise timestamp reads as more significant than it is.
 */
export function formatAge(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

/** The host alone, which is what a list wants; falls back to the raw string for anything unparseable. */
export function formatSource(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Whether an entry matches what was typed in the search box.
 *
 * Title, URL, and the page's own words together, because people remember a screenshot by any of the
 * three -- "the pricing page", "that github issue", or a phrase they know was on it. Searching only
 * titles would miss every page whose `<title>` is a brand name, and it is the text in the picture
 * that a person is usually trying to find again.
 *
 * Every whitespace-separated term must match somewhere, so terms narrow rather than widen: two words
 * a person types are two things they remember, not an alternative.
 */
export function matchesHistoryQuery(
  haystack: { title: string; url?: string; searchText?: string },
  query: string,
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return true
  const target = `${haystack.title} ${haystack.url ?? ''} ${haystack.searchText ?? ''}`.toLowerCase()
  return terms.every((term) => target.includes(term))
}

/**
 * The day part of a timestamp, relative to now.
 *
 * Separated from the time part so it can be tested without depending on the machine's locale or
 * clock format: this returns a decision, `toLocaleTimeString` returns a rendering.
 */
export function dayLabel(createdAt: number, now: number): string {
  const then = new Date(createdAt)
  const today = new Date(now)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfThatDay = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()
  const daysApart = Math.round((midnight - startOfThatDay) / (24 * 60 * 60 * 1000))

  if (daysApart === 0) return 'Today'
  if (daysApart === 1) return 'Yesterday'
  const day = then.getDate()
  const month = MONTHS[then.getMonth()]
  return then.getFullYear() === today.getFullYear() ? `${day} ${month}` : `${day} ${month} ${then.getFullYear()}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Today, 14:03` — the day decided here, the time rendered by the browser in the user's own format. */
export function formatTimestamp(createdAt: number, now: number): string {
  const time = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${dayLabel(createdAt, now)}, ${time}`
}

/** `Delete selected` while nothing is picked; `Delete 3 selected` once something is. */
export function deleteSelectedLabel(count: number): string {
  return count === 0 ? 'Delete selected' : `Delete ${count} selected`
}
