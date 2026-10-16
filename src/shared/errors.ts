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
  'devtools://',
  'view-source:',
  'extension manifest must request permission',
] as const

export function isRestrictedPageError(message: string): boolean {
  const haystack = message.toLowerCase()
  return RESTRICTED_PAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
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
export function captureError(error: unknown): CaptureError {
  if (error instanceof PageShotterError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error) {
    if (isRestrictedPageError(error.message)) {
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

const FILE_ACCESS_REMEDY =
  `Open ${BROWSER.extensionsPage}, click Details on PageShotter, and turn on "Allow access to file URLs".`

/**
 * What to say when a capture of a local file was refused because the toggle is off.
 *
 * Two wordings rather than one, because the outcomes genuinely differ: sometimes Chrome still
 * permits the visible-area screenshot and the user has a picture in hand, sometimes it permits
 * nothing. Both name the toggle, because in either case that is the thing that fixes it — and
 * neither claims Chrome disallows extensions here, which was the false part.
 */
export function fileAccessMessage(visibleAreaCaptured: boolean): string {
  return visibleAreaCaptured
    ? 'PageShotter needs your permission to read local files, so it captured only the visible area. ' +
        `Content outside the viewport is not included. ${FILE_ACCESS_REMEDY}`
    : `PageShotter needs your permission to read local files. ${FILE_ACCESS_REMEDY}`
}
