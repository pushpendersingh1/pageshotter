import { getSetting, putSetting } from './capture-db'

/**
 * The store-review invitation: when it may appear, and what the user answered.
 *
 * The rules: the ask may open only after five successful exports, installed at least three days, at most three
 * asks in total, never within a day of a failed capture, and "Not now" buys fourteen days of
 * silence. Rating and "Don't ask again" stop it permanently. The counters live in the settings
 * store beside every other preference — no `storage` permission, nothing leaves the machine.
 */
export const REVIEW_PROMPT_KEY = 'reviewPrompt'
export const REVIEW_INSTALLED_AT_KEY = 'reviewInstalledAt'

export const REVIEW_RULES = {
  minExports: 5,
  minDaysInstalled: 3,
  snoozeDays: 14,
  maxAsks: 3,
} as const

export const DAY_MS = 24 * 60 * 60 * 1000

export type ReviewAnswer = 'later' | 'never' | 'rate' | 'feedback'

export interface ReviewState {
  /** When the extension was installed; 0 means "never recorded", which the first read fills in. */
  installedAt: number
  /** Successful exports — a completed download or a resolved clipboard write, never a click. */
  exports: number
  /** The last time a capture failed, so the ask keeps its distance from a bad first impression. */
  lastFailAt: number
  asks: number
  snoozeUntil: number
  /** A rated extension is never asked again; so is one whose user chose "Don't ask again". */
  done: boolean
}

export const EMPTY_REVIEW_STATE: ReviewState = {
  installedAt: 0,
  exports: 0,
  lastFailAt: 0,
  asks: 0,
  snoozeUntil: 0,
  done: false,
}

/** The store's own reviews view, deep-linked; verified to resolve. */
export const REVIEW_STORE_URL = 'https://chromewebstore.google.com/detail/ndinpmhlpgieahdpmkibnngijihalclf/reviews'
/** The extension's own support page — "Tell us safely" — not a mailto placeholder. */
export const REVIEW_FEEDBACK_URL = 'https://www.pageshotter.com/support'

/** Pure eligibility, exactly as `recordExportAndCheck` applies it. */
export function reviewShouldAsk(state: ReviewState, now: number): boolean {
  return (
    !state.done &&
    state.exports >= REVIEW_RULES.minExports &&
    now - state.installedAt >= REVIEW_RULES.minDaysInstalled * DAY_MS &&
    now >= state.snoozeUntil &&
    state.asks < REVIEW_RULES.maxAsks &&
    now - state.lastFailAt > DAY_MS
  )
}

/**
 * One more successful export, and whether this export is the one that gets the ask.
 *
 * Counting and eligibility are one step: an ask consumes one of the three, so a user who snoozes
 * three times never sees a fourth card.
 */
export function recordExportAndCheck(
  state: ReviewState,
  now: number,
): { state: ReviewState; ask: boolean } {
  const counted = { ...state, exports: state.exports + 1 }
  if (!reviewShouldAsk(counted, now)) return { state: counted, ask: false }
  return { state: { ...counted, asks: counted.asks + 1 }, ask: true }
}

/** The state after an answer. Only "later" and "feedback" carry a snooze; the others are final. */
export function respondToReviewPrompt(state: ReviewState, answer: ReviewAnswer, now: number): ReviewState {
  if (answer === 'rate' || answer === 'never') return { ...state, done: true }
  return { ...state, snoozeUntil: now + REVIEW_RULES.snoozeDays * DAY_MS }
}

/** A failed capture keeps the ask away for a day — the capture, not the export, is what failed. */
export function onCaptureFailedState(state: ReviewState, now: number): ReviewState {
  return { ...state, lastFailAt: now }
}

/** A stored value only counts when it is the shape we still read; anything else starts over. */
export function readReviewState(stored: unknown): ReviewState {
  if (typeof stored !== 'object' || stored === null) return EMPTY_REVIEW_STATE
  const candidate = stored as Partial<ReviewState>
  const finite = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    installedAt: finite(candidate.installedAt),
    exports: finite(candidate.exports),
    lastFailAt: finite(candidate.lastFailAt),
    asks: finite(candidate.asks),
    snoozeUntil: finite(candidate.snoozeUntil),
    done: candidate.done === true,
  }
}

export async function getReviewState(): Promise<ReviewState> {
  try {
    return readReviewState(await getSetting<unknown>(REVIEW_PROMPT_KEY))
  } catch {
    // A database that will not open means no invitation this time — which is also the answer
    // "not yet", and the only safe one for a feature that must never cost an export.
    return EMPTY_REVIEW_STATE
  }
}

export async function putReviewState(state: ReviewState): Promise<void> {
  await putSetting(REVIEW_PROMPT_KEY, state)
}

/**
 * The install date, written by the worker's `onInstalled` when Chrome reports a fresh install.
 *
 * Deliberately not written on `update`: an updated install keeps the day it was installed, which
 * is the honest reading of "installed at least three days ago". A state saved before this key
 * existed falls back to "now" on its first read, which only ever delays an ask, never causes one.
 */
export async function getReviewInstalledAt(): Promise<number> {
  try {
    return (await getSetting<number>(REVIEW_INSTALLED_AT_KEY)) ?? 0
  } catch {
    return 0
  }
}

export async function putReviewInstalledAt(installedAt: number): Promise<void> {
  await putSetting(REVIEW_INSTALLED_AT_KEY, installedAt)
}

/**
 * Notes a failed capture, best-effort: the ask must never cost the user anything, and a counter
 * write that fails changes nothing they can see.
 */
export async function recordCaptureFailed(): Promise<void> {
  try {
    const state = await getReviewState()
    await putReviewState(onCaptureFailedState(state, Date.now()))
  } catch {
    // A counter write that fails changes nothing.
  }
}
