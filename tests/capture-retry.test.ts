import { describe, expect, it } from 'vitest'
import {
  CAPTURE_RETRY_POLICY,
  captureRetryDelayMs,
  isCaptureQuotaError,
} from '../src/shared/capture-retry'

describe('isCaptureQuotaError', () => {
  it('recognises Chrome captureVisibleTab quota failures', () => {
    expect(
      isCaptureQuotaError(
        new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'),
      ),
    ).toBe(true)
  })

  it('does not retry unrelated Chrome or generic quota failures', () => {
    expect(isCaptureQuotaError(new Error('The active tab changed.'))).toBe(false)
    expect(isCaptureQuotaError(new Error('Storage quota exceeded.'))).toBe(false)
    expect(isCaptureQuotaError('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota')).toBe(false)
  })
})

describe('captureRetryDelayMs', () => {
  it('waits only for the remainder of Chrome\'s capture interval after the first failure', () => {
    expect(captureRetryDelayMs(1, 1_000, 1_100)).toBe(410)
    expect(captureRetryDelayMs(1, 1_000, 1_500)).toBe(CAPTURE_RETRY_POLICY.minRetryDelayMs)
  })

  it('uses the full bounded interval when capture history is unavailable', () => {
    expect(captureRetryDelayMs(1, null, 1_100)).toBe(CAPTURE_RETRY_POLICY.quotaIntervalMs)
  })

  it('uses the full interval after a repeated quota failure', () => {
    expect(captureRetryDelayMs(2, 1_000, 1_500)).toBe(CAPTURE_RETRY_POLICY.quotaIntervalMs)
  })

  it('bounds clock rollback at the full interval', () => {
    expect(captureRetryDelayMs(1, 1_000, 900)).toBe(CAPTURE_RETRY_POLICY.quotaIntervalMs)
  })
})
