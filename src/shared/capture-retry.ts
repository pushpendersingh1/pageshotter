export const CAPTURE_RETRY_POLICY = {
  maxAttempts: 3,
  quotaIntervalMs: 510,
  minRetryDelayMs: 50,
} as const

const CAPTURE_QUOTA_MARKER = 'max_capture_visible_tab_calls_per_second'

export function isCaptureQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes(CAPTURE_QUOTA_MARKER) && message.includes('quota')
}

export function captureRetryDelayMs(
  quotaFailureCount: number,
  lastSuccessfulCaptureAt: number | null,
  now: number,
): number {
  if (quotaFailureCount > 1 || lastSuccessfulCaptureAt === null) {
    return CAPTURE_RETRY_POLICY.quotaIntervalMs
  }

  const elapsed = Math.max(0, now - lastSuccessfulCaptureAt)
  return Math.min(
    CAPTURE_RETRY_POLICY.quotaIntervalMs,
    Math.max(CAPTURE_RETRY_POLICY.minRetryDelayMs, CAPTURE_RETRY_POLICY.quotaIntervalMs - elapsed),
  )
}
