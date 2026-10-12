/**
 * What a capture's error becomes.
 *
 * The decision the failure path of `runCapture` makes, stated as a pure function so the one case
 * that was decided wrongly is pinned: **an in-memory `status = 'complete'` is not proof that the
 * write succeeded.** The completion flag this reads is set only after `putJob` resolves; a
 * persistence failure that happens before it must be reported — a failed job record and a result
 * tab — not swallowed as if the screenshot were already delivered.
 */
export type FailureOutcome =
  /** The capture persisted as complete and failed only during delivery; nothing to report. */
  | 'already-delivered'
  /** Cancelled with sections on disk: keep them and deliver what was captured. */
  | 'deliver-stopped'
  | 'mark-cancelled'
  | 'mark-failed'

export function failureOutcome(
  failureCode: string,
  segmentCount: number,
  persistedComplete: boolean,
): FailureOutcome {
  if (persistedComplete) return 'already-delivered'
  if (failureCode === 'CANCELLED' && segmentCount > 0) return 'deliver-stopped'
  return failureCode === 'CANCELLED' ? 'mark-cancelled' : 'mark-failed'
}
