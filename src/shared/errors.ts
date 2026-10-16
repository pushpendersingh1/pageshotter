import { BROWSER } from './browser'
import type { CaptureError } from './messages'

export class PageShotterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PageShotterError'
  }
}

/**
 * Chrome refuses to inject scripts into its own surfaces. The wording differs per surface — the Web
 * Store says "The extensions gallery cannot be scripted", `chrome://` pages say "Cannot access" —
 * so match on every phrasing we know rather than the two that were originally covered. A page we
 * fail to recognise here degrades to a generic error, never to Chrome's raw internal text.
 */
const RESTRICTED_PAGE_PATTERNS = [
  'cannot be scripted',
  'extensions gallery',
  'cannot access',
  'chrome://',
  'chrome-extension://',
  'chromewebstore.google.com',
  'chrome.google.com/webstore',
  // Edge's equivalents. Matching raw error text, so every build can carry every browser's.
  'edge://',
  'microsoftedge.microsoft.com',
  // Firefox's. Its refusal does not name the page, so `isRestrictedPageUrl` below carries the rest.
  'missing host permission for the tab',
  'moz-extension://',
  'addons.mozilla.org',
  'devtools://',
  'view-source:',
  'extension manifest must request permission',
] as const

export function isRestrictedPageError(message: string): boolean {
  const haystack = message.toLowerCase()
  return RESTRICTED_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

/**
 * Pages the browser keeps extensions out of, known from the tab's own address. Firefox words every
 * refusal the same way whatever the page, so once a capture has failed the address is what says
 * whether this is a page no extension may touch or a fault of ours. Only consulted after a failure:
 * it never stops a capture the browser would have allowed.
 */
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'moz-extension://',
  'view-source:',
  'devtools://',
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore',
  'https://microsoftedge.microsoft.com/',
  'https://addons.mozilla.org/',
] as const

export function isRestrictedPageUrl(url: string | undefined): boolean {
  if (typeof url !== 'string') return false
  const address = url.toLowerCase()
  return RESTRICTED_URL_PREFIXES.some((prefix) => address.startsWith(prefix)) || isPdfUrl(address)
}

/**
 * A PDF is shown in the browser's own viewer, which no extension may script -- in Chrome and Edge as
 * much as in Firefox, and whether or not the file is local. So a local PDF is a restricted page, not a
 * file-access problem: turning file access on would not let it scroll.
 */
function isPdfUrl(address: string): boolean {
  return (address.split(/[?#]/)[0] ?? '').endsWith('.pdf')
}

const RESTRICTED_PAGE_MESSAGE =
  `${BROWSER.name} does not allow extensions to run on this page, so it cannot be captured in full.`

const GENERIC_FAILURE_MESSAGE = 'The page could not be captured.'

/**
 * Maps any thrown value to a message that is safe to show a user.
 *
 * `PageShotterError` messages are ours and are written for humans, so they pass through. Anything
 * else may be raw Chrome API text, which reads like a stack trace in the UI and can name internal
 * surfaces — those are replaced with a generic message and the original is logged for debugging.
 */
export function captureError(error: unknown, pageUrl?: string): CaptureError {
  if (error instanceof PageShotterError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error) {
    if (isRestrictedPageError(error.message) || isRestrictedPageUrl(pageUrl)) {
      return { code: 'RESTRICTED_PAGE', message: RESTRICTED_PAGE_MESSAGE }
    }
    console.warn('PageShotter: unmapped capture error', error)
    return { code: 'CAPTURE_FAILED', message: GENERIC_FAILURE_MESSAGE }
  }

  return { code: 'CAPTURE_FAILED', message: GENERIC_FAILURE_MESSAGE }
}

/**
 * Whether a failed full-page capture should automatically fall back to a visible-area capture.
 * Visible-area capture only calls `chrome.tabs.captureVisibleTab`, which Chrome permits on
 * restricted pages — only script injection is blocked there.
 */
export function visibleAreaFallbackAvailable(error: CaptureError, mode: string): boolean {
  return error.code === 'RESTRICTED_PAGE' && mode === 'full'
}

/**
 * Whether a URL is a local file the user opened in Chrome.
 *
 * Kept as a pure predicate over the tab's own URL rather than a pattern over Chrome's error text.
 * The text route is what produced the message this replaces: Chrome's refusal on a `file://` page
 * reads "Cannot access contents of url ... Extension manifest must request permission", which
 * matches two `RESTRICTED_PAGE_PATTERNS` entries, so the page was classified as one Chrome forbids
 * extensions on. It is not. There is a per-extension "Allow access to file URLs" toggle, and the
 * user can turn it on.
 */
export function isFileUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith('file://')
}

/**
 * What to say when a capture of a local file was refused because the toggle is off.
 *
 * Two wordings rather than one, because the outcomes genuinely differ: sometimes Chrome still
 * permits the visible-area screenshot and the user has a picture in hand, sometimes it permits
 * nothing. Both name the toggle, because in either case that is the thing that fixes it — and
 * neither claims Chrome disallows extensions here, which was the false part.
 */
export function fileAccessMessage(visibleAreaCaptured: boolean): string {
  return fileAccessMessageFor(BROWSER.name, BROWSER.fileAccessRemedy, visibleAreaCaptured)
}

/**
 * The same, for any browser. Where the browser has no setting to offer (`remedy` null) the message
 * says so plainly rather than asking for a permission nobody can grant.
 */
export function fileAccessMessageFor(browserName: string, remedy: string | null, visibleAreaCaptured: boolean): string {
  const partial = visibleAreaCaptured ? ' Content outside the viewport is not included.' : ''
  if (remedy === null) {
    return visibleAreaCaptured
      ? `PageShotter can't read local files in ${browserName}, so it captured only the visible area.${partial}`
      : `PageShotter can't read local files in ${browserName}.`
  }
  return visibleAreaCaptured
    ? `PageShotter needs your permission to read local files, so it captured only the visible area.${partial} ${remedy}`
    : `PageShotter needs your permission to read local files. ${remedy}`
}
