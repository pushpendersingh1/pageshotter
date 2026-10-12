import { describe, expect, it } from 'vitest'

import { captureEtaLabel } from '../src/shared/capture-eta'

describe('captureEtaLabel', () => {
  it('says nothing until a second section has landed', () => {
    // One sample is dominated by preparation and settling, so it would overestimate badly.
    expect(captureEtaLabel(0, 10, 1_000)).toBe('')
    expect(captureEtaLabel(1, 10, 1_000)).toBe('')
  })

  it('projects the mean section time over the sections still expected', () => {
    // 4 sections in 8s is 2s each; 6 remain, so ~12s.
    expect(captureEtaLabel(4, 10, 8_000)).toBe('about 12s left')
  })

  it('switches to minutes once the estimate passes a minute', () => {
    // 2 sections in 60s is 30s each; 6 remain, so 180s.
    expect(captureEtaLabel(2, 8, 60_000)).toBe('about 3 min left')
  })

  it('says nothing when the expected total stops exceeding what is done', () => {
    // Routine on lazy pages: `estimatedTotal` is clamped to `current` until more content loads, and
    // claiming "0s left" there would be a countdown to a finish that has not been reached.
    expect(captureEtaLabel(9, 9, 20_000)).toBe('')
    expect(captureEtaLabel(12, 9, 20_000)).toBe('')
  })

  it('reports almost done rather than a zero countdown', () => {
    expect(captureEtaLabel(500, 501, 100)).toBe('almost done')
  })

  it('says nothing before any time has been measured', () => {
    expect(captureEtaLabel(4, 10, 0)).toBe('')
  })
})

describe('captureEtaLabel on a growing page', () => {
  /*
   * The estimate used to be at its most confident exactly when it was most wrong. On a page that
   * appends as it is scrolled the total grows with the count, so `estimatedTotal > current` stays
   * true forever, the existing guard never fires, and the label counts *up*.
   */
  it('says nothing while the page is still growing', () => {
    expect(captureEtaLabel(10, 60, 30_000, true)).toBe('')
    expect(captureEtaLabel(20, 120, 60_000, true)).toBe('')
  })

  it('still speaks on an ordinary page', () => {
    expect(captureEtaLabel(10, 20, 10_000)).not.toBe('')
    expect(captureEtaLabel(10, 20, 10_000, false)).not.toBe('')
  })

  it('would otherwise have counted upward, which is what the flag prevents', () => {
    const earlier = captureEtaLabel(10, 60, 30_000)
    const later = captureEtaLabel(20, 120, 60_000)
    expect(earlier).not.toBe('')
    expect(later).not.toBe('')
    // Same growth rate, twice the work done, and the estimate is no closer to zero.
    expect(later).not.toBe('almost done')
  })
})
