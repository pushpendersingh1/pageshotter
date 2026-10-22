import { describe, expect, it } from 'vitest'
import manifest from '../public/manifest.json'
import { manifestFor } from '../scripts/targets.mjs'
import { GMAIL_ATTACHMENT_LIMIT, GMAIL_COMPOSE_URL, GMAIL_ORIGIN, gmailPermissions, gmailSizeProblem, isGmailPage } from '../src/result/gmail'

describe('GMAIL_COMPOSE_URL', () => {
  /* The compose-only page (`?view=cm`) fills the tab and hides the inbox. */
  it('opens the inbox with a new message over it, and is a page the attach waits for', () => {
    const url = new URL(GMAIL_COMPOSE_URL)
    expect(url.search).toBe('')
    expect(url.hash).toBe('#inbox?compose=new')
    expect(isGmailPage(GMAIL_COMPOSE_URL)).toBe(true)
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

/* Firefox counts the hand-off as website content leaving the add-on; Chrome has no such declaration. */
describe('gmailPermissions', () => {
  it('asks Chrome for Gmail access alone', () => {
    expect(gmailPermissions(manifest as chrome.runtime.Manifest)).toEqual({ origins: [GMAIL_ORIGIN] })
  })

  it('asks Firefox for website content in the same prompt, as its manifest declares', () => {
    expect(gmailPermissions(manifestFor('firefox', manifest))).toEqual({
      origins: [GMAIL_ORIGIN],
      data_collection: ['websiteContent'],
    })
  })
})
