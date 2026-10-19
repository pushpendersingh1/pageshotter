import { formatBytes } from './export-options'

/**
 * Send to Gmail: a new compose window in the user's own Gmail with the export already attached.
 *
 * There is no Gmail API, OAuth client or SDK here, and the extension still makes no network request
 * of its own. It opens Gmail's compose address in a tab, waits for Gmail to load there -- through
 * Google's sign-in first, if need be -- and hands the file to the compose window's attachment input,
 * which is what choosing it from the paperclip does. Google receives the file from the user's Gmail,
 * because they asked to email it.
 *
 * The one permission this needs, `https://mail.google.com/*`, is optional and asked for on the first
 * press of the button. Nothing else may depend on it.
 */

export const GMAIL_ORIGIN = 'https://mail.google.com/*'

/**
 * Gmail's attachment limit. A larger file would be offered to Google Drive instead, which is a
 * different destination from the one the user picked, so it is refused here with a way to fit.
 */
export const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024

/** Long enough to sign in, two-factor prompt included; after that nobody is still waiting. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** How long the compose window has to appear once Gmail itself has loaded. */
const COMPOSE_TIMEOUT_MS = 30_000

export type GmailOutcome = 'attached' | 'no-compose' | 'closed' | 'timeout'

/** Gmail's own compose-only address. `fs=1` fills the tab with it, rather than a box over the inbox. */
export function gmailComposeUrl(subject: string, body: string | undefined): string {
  const params = new URLSearchParams({ view: 'cm', fs: '1', su: subject })
  if (body) params.set('body', body)
  return `https://mail.google.com/mail/?${params.toString()}`
}

/** Gmail proper, as opposed to the sign-in pages and redirects in front of it. */
export function isGmailPage(url: string | undefined): boolean {
  return url !== undefined && /^https:\/\/mail\.google\.com\/mail\//.test(url)
}

/** Why a file cannot be sent, or `undefined` when it can. */
export function gmailSizeProblem(bytes: number): string | undefined {
  if (bytes <= GMAIL_ATTACHMENT_LIMIT) return undefined
  return (
    `This file is ${formatBytes(bytes)}, and Gmail attaches files up to 25 MB. ` +
    'Choose JPEG or a smaller scale in the export options, or download it instead.'
  )
}

/** What the page tells the user when the file did not arrive in Gmail. */
export function gmailOutcomeMessage(outcome: Exclude<GmailOutcome, 'attached'>): string {
  switch (outcome) {
    case 'no-compose':
      return 'Gmail opened, but its compose window did not appear, so nothing was attached. Download the file and attach it there.'
    case 'closed':
      return 'The Gmail tab was closed before the screenshot could be attached.'
    case 'timeout':
      return 'Gmail did not finish loading, so nothing was attached. Download the file and attach it there.'
  }
}

/**
 * Ask for Gmail access. Call this first in the click handler, before any `await`: both browsers
 * refuse a permission request that is no longer inside the user's gesture.
 */
export function requestGmailAccess(): Promise<boolean> {
  try {
    return chrome.permissions.request({ origins: [GMAIL_ORIGIN] })
  } catch {
    return Promise.resolve(false)
  }
}

/** Open a compose window and attach `file` to it once Gmail has loaded. */
export async function sendToGmail(file: Blob, filename: string, subject: string, body?: string): Promise<GmailOutcome> {
  // Encoded before the tab opens, so the wait for Gmail is not also a wait for this.
  const base64 = await toBase64(file)
  const tab = await chrome.tabs.create({ url: gmailComposeUrl(subject, body) })
  if (tab.id === undefined) return 'closed'
  const tabId = tab.id

  return await new Promise<GmailOutcome>((resolve) => {
    let attaching = false
    const finish = (outcome: GmailOutcome): void => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      window.clearTimeout(timer)
      resolve(outcome)
    }
    const onRemoved = (closed: number): void => {
      if (closed === tabId) finish('closed')
    }
    // The address is visible here only on pages the permission covers, which is exactly Gmail: the
    // sign-in pages in front of it report nothing, and this simply waits them out.
    const onUpdated = (updated: number, change: { status?: string }, current: chrome.tabs.Tab): void => {
      if (updated !== tabId || change.status !== 'complete' || attaching || !isGmailPage(current.url)) return
      attaching = true
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: attachToCompose,
          args: [base64, filename, file.type, COMPOSE_TIMEOUT_MS],
        })
        .then(([result]) => finish(result?.result === true ? 'attached' : 'no-compose'))
        // The page navigated away under the script, as Gmail does once more while it starts. The
        // next load gets its own attempt.
        .catch(() => {
          attaching = false
        })
    }
    const timer = window.setTimeout(() => finish('timeout'), SIGN_IN_TIMEOUT_MS)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
  })
}

async function toBase64(file: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/**
 * Runs inside the Gmail tab, so it is serialised on its own and may use nothing from this module.
 *
 * The file goes in through the compose window's attachment input -- present in the compose window
 * whether or not the paperclip has been pressed -- rather than by a simulated drop, because Gmail
 * puts a dropped image inline in the message body, and a full-page screenshot is an attachment.
 * Resolves false if no compose window appears in time.
 */
async function attachToCompose(base64: string, filename: string, type: string, timeoutMs: number): Promise<boolean> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const file = new File([bytes], filename, { type })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"][name="Filedata"]') ??
      document.querySelector<HTMLInputElement>('input[type="file"]')
    if (input) {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
