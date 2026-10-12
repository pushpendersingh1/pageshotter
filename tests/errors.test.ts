import { describe, expect, it, vi } from 'vitest'
import {
  captureError,
  fileAccessMessage,
  isFileUrl,
  isRestrictedPageError,
  PageShotterError,
  visibleAreaFallbackAvailable,
} from '../src/shared/errors'

/**
 * Real Chrome error strings. The Web Store one is what a user hit on the developer console while
 * filling in the extension's own listing, and it used to reach the UI verbatim.
 */
const CHROME_RESTRICTED_ERRORS = [
  'The extensions gallery cannot be scripted.',
  'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
  'Cannot access a chrome:// URL',
  'Cannot access contents of url "chrome-extension://abc/popup.html".',
  'Cannot access contents of url "https://chromewebstore.google.com/".',
  'Cannot access contents of url "https://chrome.google.com/webstore/devconsole/x".',
  'Cannot access contents of url "view-source:https://example.com".',
  'Cannot access contents of url "devtools://devtools/bundled/x.html".',
]

describe('captureError', () => {
  it('maps every known Chrome restricted-page phrasing to RESTRICTED_PAGE', () => {
    for (const message of CHROME_RESTRICTED_ERRORS) {
      expect(isRestrictedPageError(message), message).toBe(true)
      expect(captureError(new Error(message)).code, message).toBe('RESTRICTED_PAGE')
    }
  })

  it('never leaks raw Chrome text for a restricted page', () => {
    const result = captureError(new Error('The extensions gallery cannot be scripted.'))
    expect(result.message).not.toContain('gallery')
    expect(result.message).not.toContain('scripted')
    expect(result.message).toMatch(/cannot be captured in full/)
  })

  it('replaces unmapped errors with a generic message instead of passing them through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = captureError(new Error('Frame with ID 0 was removed. [internal]'))
    expect(result.code).toBe('CAPTURE_FAILED')
    expect(result.message).toBe('The page could not be captured.')
    expect(result.message).not.toContain('Frame with ID')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('passes our own human-written messages through unchanged', () => {
    const result = captureError(new PageShotterError('TAB_CHANGED', 'The tab changed during capture.'))
    expect(result).toEqual({ code: 'TAB_CHANGED', message: 'The tab changed during capture.' })
  })

  it('handles non-Error throws', () => {
    expect(captureError('boom')).toEqual({
      code: 'CAPTURE_FAILED',
      message: 'The page could not be captured.',
    })
  })

  it('does not treat an ordinary capture failure as restricted', () => {
    expect(isRestrictedPageError('The page stopped scrolling.')).toBe(false)
  })
})

describe('visibleAreaFallbackAvailable', () => {
  it('selects the fallback when a full-page capture hits a restricted page', () => {
    const error = captureError(new Error('The extensions gallery cannot be scripted.'))
    expect(visibleAreaFallbackAvailable(error, 'full')).toBe(true)
  })

  it('does not select it when the visible-area capture is what failed', () => {
    const error = captureError(new Error('The extensions gallery cannot be scripted.'))
    expect(visibleAreaFallbackAvailable(error, 'visible')).toBe(false)
  })

  it('does not select it for unrelated failures', () => {
    expect(visibleAreaFallbackAvailable({ code: 'CAPTURE_FAILED', message: 'x' }, 'full')).toBe(false)
  })
})

describe('isFileUrl', () => {
  it('recognises a local file whatever its case', () => {
    expect(isFileUrl('file:///Users/someone/page.html')).toBe(true)
    expect(isFileUrl('FILE:///C:/page.html')).toBe(true)
  })

  it('is not fooled by a file scheme appearing later in the URL', () => {
    expect(isFileUrl('https://example.com/?next=file:///etc/passwd')).toBe(false)
  })

  it('rejects everything that is not a local file, including nothing at all', () => {
    expect(isFileUrl('https://example.com/')).toBe(false)
    expect(isFileUrl('chrome://extensions')).toBe(false)
    // `tab.url` is absent when activeTab has not been granted, which must not read as a file.
    expect(isFileUrl(undefined)).toBe(false)
  })
})

describe('fileAccessMessage', () => {
  /*
   * The message this replaces was false in a specific way: it told the user Chrome does not allow
   * extensions to run on the page, when the truth is a toggle they own and can turn on. Both
   * wordings are held to naming that toggle, and to never making the old claim.
   */
  it('names the toggle in both outcomes', () => {
    for (const captured of [true, false]) {
      expect(fileAccessMessage(captured)).toContain('Allow access to file URLs')
      expect(fileAccessMessage(captured)).toContain('chrome://extensions')
    }
  })

  it('never repeats the false claim it replaces', () => {
    for (const captured of [true, false]) {
      expect(fileAccessMessage(captured)).not.toContain('does not allow')
    }
  })

  it('admits the screenshot is partial only when there is a screenshot', () => {
    expect(fileAccessMessage(true)).toContain('visible area')
    expect(fileAccessMessage(false)).not.toContain('visible area')
  })
})
