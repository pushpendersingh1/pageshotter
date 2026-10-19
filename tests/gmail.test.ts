import { describe, expect, it } from 'vitest'
import manifest from '../public/manifest.json'
import { GMAIL_ATTACHMENT_LIMIT, GMAIL_ORIGIN, gmailComposeUrl, gmailSizeProblem, isGmailPage } from '../src/result/gmail'

describe('gmailComposeUrl', () => {
  it('opens a compose window with the subject and body filled in', () => {
    const url = new URL(gmailComposeUrl('Pricing & plans', 'https://example.com/pricing?a=1'))
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/')
    expect(url.searchParams.get('view')).toBe('cm')
    expect(url.searchParams.get('su')).toBe('Pricing & plans')
    expect(url.searchParams.get('body')).toBe('https://example.com/pricing?a=1')
  })

  /* A restricted page stores no address, and an empty body is better than the word "undefined". */
  it('leaves the body out when there is no address', () => {
    expect(new URL(gmailComposeUrl('Title', undefined)).searchParams.has('body')).toBe(false)
  })
})

describe('isGmailPage', () => {
  it('waits out the sign-in pages in front of Gmail', () => {
    expect(isGmailPage('https://mail.google.com/mail/u/0/?view=cm&fs=1')).toBe(true)
    expect(isGmailPage('https://accounts.google.com/ServiceLogin?continue=x')).toBe(false)
    expect(isGmailPage('https://mail.google.com.evil.example/mail/')).toBe(false)
    expect(isGmailPage(undefined)).toBe(false)
  })
})

describe('gmailSizeProblem', () => {
  it('sends anything up to Gmail’s attachment limit, and explains anything over it', () => {
    expect(gmailSizeProblem(GMAIL_ATTACHMENT_LIMIT)).toBeUndefined()
    expect(gmailSizeProblem(GMAIL_ATTACHMENT_LIMIT + 1)).toMatch(/25 MB/)
  })
})

/* Gmail access is asked for when the button is pressed, never on install. */
it('declares Gmail access as optional only', () => {
  expect(manifest.optional_host_permissions).toContain(GMAIL_ORIGIN)
  expect('host_permissions' in manifest).toBe(false)
})
