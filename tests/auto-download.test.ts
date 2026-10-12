import { describe, expect, it } from 'vitest'
import { canSaveUnattended } from '../src/shared/auto-download'

describe('deciding whether a capture can save itself', () => {
  it('does nothing unattended unless the setting is on', () => {
    expect(canSaveUnattended(false, '', true)).toBe(false)
    expect(canSaveUnattended(false, 'PageShotter', true)).toBe(false)
  })

  it('needs no permission to save straight into Downloads, because an anchor needs none', () => {
    expect(canSaveUnattended(true, '', false)).toBe(true)
  })

  it('refuses a folder save without the optional permission, since nothing here can request it', () => {
    expect(canSaveUnattended(true, 'PageShotter', false)).toBe(false)
    expect(canSaveUnattended(true, 'PageShotter', true)).toBe(true)
  })
})
