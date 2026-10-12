import { describe, expect, it } from 'vitest'

import { failureOutcome } from '../src/background/capture-outcome'

describe('failureOutcome', () => {
  it('a completion write that failed is not treated as a delivered capture', () => {
    // The defect this pins: the catch used to read the in-memory `status = 'complete'` that was set
    // before putJob ran, so a failing persistence write ended the run silently with no result tab.
    expect(failureOutcome('STORAGE_FAILED', 5, false)).toBe('mark-failed')
  })

  it('delivery failures after a persisted completion are not capture failures', () => {
    expect(failureOutcome('CANCELLED', 5, true)).toBe('already-delivered')
  })

  it('a cancel with sections taken stops and keeps them', () => {
    expect(failureOutcome('CANCELLED', 5, false)).toBe('deliver-stopped')
  })

  it('a cancel before any section is a plain cancellation', () => {
    expect(failureOutcome('CANCELLED', 0, false)).toBe('mark-cancelled')
  })

  it('any other failure is reported as failed', () => {
    expect(failureOutcome('NO_VISIBLE_CONTENT', 0, false)).toBe('mark-failed')
  })
})
