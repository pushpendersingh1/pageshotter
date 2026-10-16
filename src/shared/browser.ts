/**
 * The browser this build is for: its name in copy, its own extensions page, and its store.
 *
 * `scripts/build.mjs` defines `__BROWSER__` once per target, so the choice is made when the bundle
 * is built and never by sniffing the browser at runtime. Tests run without the define and get
 * Chrome, which is also what a plain `npm run build` produces.
 */

import profiles from './browsers.json'

declare const __BROWSER__: string | undefined

export interface BrowserProfile {
  /** As it appears in user-facing copy: "Chrome could not save to ...". */
  name: string
  /**
   * The browser's own page for managing extensions. Shortcuts and the file-access toggle both live
   * under it, and nothing else can change either, so every link to them derives from this.
   */
  extensionsPage: string
  /** The store's name in copy: "Rate on the Chrome Web Store". */
  storeName: string
  /**
   * The store's reviews view, deep-linked. Null until the listing exists, which turns the review
   * invitation off rather than sending a rating to a page that does not resolve. Edge's stays null
   * until its Add-ons listing exists.
   */
  reviewUrl: string | null
  /** How to keep the toolbar button visible: Chrome pins an extension, Edge shows it with an eye. */
  pinHint: string
}

/** Shared with `scripts/targets.mjs`, which also uses it for the HTML the build writes. */
const PROFILES: Record<BrowserTarget, BrowserProfile> = profiles

export type BrowserTarget = keyof typeof profiles

export const BROWSER: BrowserProfile =
  PROFILES[(typeof __BROWSER__ === 'string' ? __BROWSER__ : 'chrome') as BrowserTarget]

/** Where extension shortcuts are rebound. */
export const SHORTCUTS_PAGE = `${BROWSER.extensionsPage}/shortcuts`

/**
 * PageShotter's own details page, where the file-access toggle is. `?id=` lands there directly
 * rather than on a list the reader then has to search for their own extension.
 */
export function extensionDetailsPage(): string {
  return `${BROWSER.extensionsPage}/?id=${chrome.runtime.id}`
}
