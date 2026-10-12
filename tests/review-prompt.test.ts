import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  EMPTY_REVIEW_STATE,
  REVIEW_RULES,
  onCaptureFailedState,
  readReviewState,
  recordExportAndCheck,
  respondToReviewPrompt,
  reviewShouldAsk,
  type ReviewState,
} from '../src/shared/review-prompt'

/** A state that has just crossed every threshold, so single-condition tests need only one change. */
function earned(over: Partial<ReviewState> = {}): ReviewState {
  return {
    ...EMPTY_REVIEW_STATE,
    installedAt: -REVIEW_RULES.minDaysInstalled * DAY_MS,
    exports: REVIEW_RULES.minExports,
    lastFailAt: 0,
    asks: 0,
    snoozeUntil: 0,
    done: false,
    ...over,
  }
}

describe('reviewShouldAsk', () => {
  it('is false below each threshold, one condition at a time', () => {
    expect(reviewShouldAsk(earned({ exports: REVIEW_RULES.minExports - 1 }), 0)).toBe(false)
    expect(reviewShouldAsk(earned({ installedAt: -1 }), 0)).toBe(false)
    expect(reviewShouldAsk(earned({ snoozeUntil: 1 }), 0)).toBe(false)
    expect(reviewShouldAsk(earned({ asks: REVIEW_RULES.maxAsks }), 0)).toBe(false)
    expect(reviewShouldAsk(earned({ lastFailAt: -1 }), 0)).toBe(false)
    expect(reviewShouldAsk(earned({ done: true }), 0)).toBe(false)
  })

  it('is true at every threshold, exactly', () => {
    // A real timestamp rather than 0, whose only job in this state is "no failure ever recorded".
    expect(reviewShouldAsk(earned(), 10 * DAY_MS)).toBe(true)
  })

  it('counts installed days from the recorded install date', () => {
    const threeDays = REVIEW_RULES.minDaysInstalled * DAY_MS
    expect(reviewShouldAsk(earned({ installedAt: 100 }), 100 + threeDays)).toBe(true)
    expect(reviewShouldAsk(earned({ installedAt: 100 }), 100 + threeDays - 1)).toBe(false)
  })

  it('stays quiet for a day after a failed capture', () => {
    const state = earned({ lastFailAt: 1_000 })
    expect(reviewShouldAsk(state, 1_000 + DAY_MS + 1)).toBe(true)
    expect(reviewShouldAsk(state, 1_000 + DAY_MS)).toBe(false)
  })
})

describe('recordExportAndCheck', () => {
  // A real timestamp: the "never failed" sentinel is `0`, and every rule compares against it.
  const now = 100 * DAY_MS

  it('counts the export and does not ask below the thresholds', () => {
    const { state, ask } = recordExportAndCheck(earned({ exports: REVIEW_RULES.minExports - 2 }), now)
    expect(state.exports).toBe(REVIEW_RULES.minExports - 1)
    expect(state.asks).toBe(0)
    expect(ask).toBe(false)
  })

  it('spends one ask when the thresholds are met', () => {
    const { state, ask } = recordExportAndCheck(earned(), now)
    expect(ask).toBe(true)
    expect(state.asks).toBe(1)
  })

  it('never exceeds the ask cap: the third ask is the last', () => {
    const second = earned({ asks: REVIEW_RULES.maxAsks - 1 })
    const third = recordExportAndCheck(second, now)
    expect(third.ask).toBe(true)
    expect(third.state.asks).toBe(REVIEW_RULES.maxAsks)
    const fourth = recordExportAndCheck(third.state, now)
    expect(fourth.ask).toBe(false)
    expect(fourth.state.asks).toBe(REVIEW_RULES.maxAsks)
  })

  it('never asks once done, whatever the counters say', () => {
    expect(recordExportAndCheck(earned({ done: true }), now).ask).toBe(false)
  })
})

describe('respondToReviewPrompt', () => {
  const now = 10_000

  it('finishes permanently after a rating and after Don\u2019t ask again', () => {
    for (const answer of ['rate', 'never'] as const) {
      expect(respondToReviewPrompt(earned(), answer, now).done).toBe(true)
    }
  })

  it('snoozes "Not now" for the rule\u2019s fourteen days', () => {
    const snoozed = respondToReviewPrompt(earned(), 'later', now)
    expect(snoozed.snoozeUntil).toBe(now + REVIEW_RULES.snoozeDays * DAY_MS)
    expect(snoozed.done).toBe(false)
  })

  it('snoozes the private-feedback path the same way', () => {
    expect(respondToReviewPrompt(earned(), 'feedback', now).snoozeUntil).toBe(
      now + REVIEW_RULES.snoozeDays * DAY_MS,
    )
  })
})

describe('onCaptureFailedState', () => {
  it('stamps the failure time and changes nothing else', () => {
    expect(onCaptureFailedState(earned(), 7_000)).toEqual(earned({ lastFailAt: 7_000 }))
  })
})

describe('readReviewState', () => {
  it('accepts the shape it wrote', () => {
    const written = respondToReviewPrompt(recordExportAndCheck(earned(), 5).state, 'later', 6)
    expect(readReviewState(written)).toEqual(written)
  })

  it('starts over on anything it cannot trust', () => {
    for (const stored of [undefined, null, 'reviewPrompt', 42, {}]) {
      expect(readReviewState(stored)).toEqual(EMPTY_REVIEW_STATE)
    }
  })

  it('repairs a stored state field by field, never trusting a bad value', () => {
    expect(readReviewState({ exports: 'many', done: true })).toEqual({ ...EMPTY_REVIEW_STATE, done: true })
    expect(readReviewState({ exports: 9, done: 'yes' }).exports).toBe(9)
    expect(readReviewState({ exports: 9, done: 'yes' }).done).toBe(false)
  })
})
