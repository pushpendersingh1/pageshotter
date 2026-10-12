import { describe, expect, it } from 'vitest'

import { CaptureOwnership } from '../src/background/capture-ownership'

describe('CaptureOwnership', () => {
  it('refuses a second capture for a tab the first capture still holds', () => {
    const ownership = new CaptureOwnership()

    expect(ownership.reserve(7, 'job-a')).toBe(true)
    // The concurrent-start defect: the reservation used to land after putJob's await, so a second
    // request for the same tab that arrived inside that await was served too.
    expect(ownership.reserve(7, 'job-b')).toBe(false)
    expect(ownership.owner(7)).toBe('job-a')
  })

  it('releases a tab only for the capture that reserved it', () => {
    const ownership = new CaptureOwnership()
    ownership.reserve(7, 'job-a')

    ownership.release(7, 'job-b')
    expect(ownership.owner(7)).toBe('job-a')

    ownership.release(7, 'job-a')
    expect(ownership.owner(7)).toBeUndefined()
  })

  it('lets a later capture take the tab once the first has released it', () => {
    const ownership = new CaptureOwnership()
    ownership.reserve(7, 'job-a')
    ownership.release(7, 'job-a')

    expect(ownership.reserve(7, 'job-b')).toBe(true)
  })

  it('tracks tabs independently', () => {
    const ownership = new CaptureOwnership()
    expect(ownership.reserve(1, 'job-a')).toBe(true)
    expect(ownership.reserve(2, 'job-b')).toBe(true)
    expect(ownership.owner(1)).toBe('job-a')
    expect(ownership.owner(2)).toBe('job-b')
  })
})
