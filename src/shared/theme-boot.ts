/**
 * Stamps the stored palette on the document **before the first paint**.
 *
 * The preference itself lives in IndexedDB, which can only be read asynchronously -- so by the time
 * `applyStoredTheme` answers, the page has already painted once using `prefers-color-scheme`. For
 * anyone whose OS says dark and who has chosen light, every navigation between extension pages
 * flashed dark and then repainted white. The old comment in `theme.ts` called this "confined to
 * people who have deliberately chosen otherwise", which understated it: those are exactly the people
 * who notice, because they see it on every page load.
 *
 * `localStorage` is the only synchronous store available -- `chrome.storage` needs a permission the
 * extension does not take, and taking one for a colour would be absurd. So the choice is *mirrored*
 * there and IndexedDB stays the record: this file reads the mirror, and `applyStoredTheme` corrects
 * both the document and the mirror a moment later if they ever disagree.
 *
 * Loaded from `<head>` as an ordinary blocking script -- no `defer`, no `type="module"`, and not
 * inline, since the extension's CSP allows `script-src 'self'` and nothing else. Keep it dependency
 * free: it is its own bundle, and every byte of it is in front of the first paint of every page.
 * `theme-key.ts` exists precisely so the one constant it shares with `theme.ts` costs nothing.
 */

import { THEME_MIRROR_KEY } from './theme-key'

try {
  const stored = localStorage.getItem(THEME_MIRROR_KEY)
  // Only an explicit choice is stamped. "system" is the absence of the attribute, and an unreadable
  // or empty mirror means the same thing: fall through to `prefers-color-scheme`, which is already
  // right at first paint for everyone who has not overridden it.
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored
} catch {
  // Storage can throw outright when the browser is set to block site data. A page that renders in
  // the system palette is a far better outcome than a page that does not render.
}
