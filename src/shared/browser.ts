/**
 * The browser this build is for: its name in copy, its own extensions page, and its store.
 *
 * `scripts/build.mjs` defines `__BROWSER_PROFILE__` once per target, so the choice is made when the
 * bundle is built and never by sniffing the browser at runtime. The whole profile is defined, not a
 * name to look one up by, so a bundle carries its own browser's strings and no other's. Tests get
 * Chrome's from `vitest.config.mjs`, which is also what a plain `npm run build` produces.
 */

declare const __BROWSER_PROFILE__: BrowserProfile

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
  /**
   * Whether an extension may open `extensionsPage` in a tab. Chrome and Edge allow it; Firefox
   * refuses `about:addons` from `tabs.create`, so there the page is named in words instead of linked.
   */
  extensionsPageOpenable: boolean
  /** What the extensions page calls the control that opens one extension's own page. */
  detailsLabel: string
  /**
   * The steps to the local-file setting, which each browser names and places differently. Null in
   * Firefox: since 153 it offers "Access local files on your computer" only to an extension that
   * requests file access, and PageShotter requests `activeTab` alone, so there is no setting to send
   * anyone to -- and an extension may not open `about:addons` to look.
   */
  fileAccessRemedy: string | null
}

/**
 * Every profile in `browsers.json` carries every field. A type-level check, so it costs the bundles
 * nothing; `scripts/targets.mjs` reads the same file for the HTML the build writes.
 */
type Profiles = Omit<typeof import('./browsers.json'), 'default'>
const everyProfileComplete: Profiles extends Record<string, BrowserProfile> ? true : never = true
void everyProfileComplete

export const BROWSER: BrowserProfile = __BROWSER_PROFILE__

/** Where extension shortcuts are rebound, in the browsers that let an extension open it in a tab. */
export const SHORTCUTS_PAGE = `${BROWSER.extensionsPage}/shortcuts`

/**
 * Opens the browser's shortcut settings. Firefox has an API for exactly this and refuses the tab
 * route; Chrome has no such API and accepts the tab.
 */
export function openShortcutSettings(): void {
  // `@types/chrome` describes Chrome, which lacks the function, so it is reached through a cast.
  const commands = chrome.commands as typeof chrome.commands & { openShortcutSettings?: () => Promise<void> }
  if (commands.openShortcutSettings) void commands.openShortcutSettings()
  else void chrome.tabs.create({ url: SHORTCUTS_PAGE })
}

/**
 * PageShotter's own details page, where the file-access toggle is. `?id=` lands there directly
 * rather than on a list the reader then has to search for their own extension.
 */
export function extensionDetailsPage(): string | null {
  if (!BROWSER.extensionsPageOpenable) return null
  return `${BROWSER.extensionsPage}/?id=${chrome.runtime.id}`
}
