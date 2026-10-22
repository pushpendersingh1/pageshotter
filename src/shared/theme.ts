import { getSetting, putSetting } from './capture-db'
import { THEME_MIRROR_KEY } from './theme-key'

/**
 * Which palette the extension's own chrome uses.
 *
 * `system` is not a third palette -- it is the absence of a choice, which lets the stylesheets fall
 * through to `prefers-color-scheme`. That distinction is why this is three values rather than a
 * boolean: someone who has never touched the setting should keep following their OS when they change
 * it, and a boolean would silently freeze them to whatever the OS happened to say the first time.
 */
export type Theme = 'system' | 'light' | 'dark'

/**
 * The order the pages' theme buttons cycle through, starting from the default, and the order the
 * settings page lists them in. Kept as data rather than a chain of conditionals so the cycle and the
 * labels cannot drift apart.
 */
export const THEME_CHOICES: ReadonlyArray<{ theme: Theme; label: string }> = [
  { theme: 'system', label: 'Match the system' },
  { theme: 'light', label: 'Light' },
  { theme: 'dark', label: 'Dark' },
]

/**
 * Stored in IndexedDB beside the captures, not in `chrome.storage.local`, for the same reason the
 * history settings are: `chrome.storage` needs the `storage` permission, and the permission list is
 * an invariant rather than a preference.
 */
const THEME_KEY = 'theme'

/**
 * Writes the mirror `theme-boot.ts` reads before the first paint. IndexedDB remains the record; this
 * is a cache that exists solely because a paint cannot wait for an async read.
 * `system` clears it rather than storing the word, so a browser that has never
 * seen this extension and one following the OS both read the same nothing.
 */
function mirrorTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_MIRROR_KEY)
    else localStorage.setItem(THEME_MIRROR_KEY, theme)
  } catch {
    // A blocked or full store costs the next page load a flash, nothing more.
  }
}

/** The next theme in the cycle, wrapping. Anything unrecognised restarts at the default. */
export function nextTheme(current: Theme): Theme {
  const index = THEME_CHOICES.findIndex((choice) => choice.theme === current)
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length]?.theme ?? 'system'
}

export function themeLabel(theme: Theme): string {
  return THEME_CHOICES.find((choice) => choice.theme === theme)?.label ?? 'Match the system'
}

/** A stored value only counts if it is one we still offer; anything else falls back to the default. */
export function readTheme(stored: unknown): Theme {
  return THEME_CHOICES.some((choice) => choice.theme === stored) ? (stored as Theme) : 'system'
}

export async function getTheme(): Promise<Theme> {
  try {
    return readTheme(await getSetting<string>(THEME_KEY))
  } catch {
    // A database that will not open should still render something legible, and the system palette is
    // the best guess available without it.
    return 'system'
  }
}

export async function setTheme(theme: Theme): Promise<void> {
  // The mirror first, synchronously: it is what the *next* page load reads, and it must be correct
  // even if the database write below is slow or fails.
  mirrorTheme(theme)
  await putSetting(THEME_KEY, theme)
}

/**
 * Stamps the choice on the document, which is what the stylesheets key off.
 *
 * `system` removes the attribute rather than setting it to anything, because the whole point of that
 * value is to let the `prefers-color-scheme` rules apply -- an attribute reading "system" would still
 * have to be excluded by every one of them.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

/**
 * Reads the stored choice and applies it. Every extension page calls this on load.
 *
 * By the time this resolves the page has usually already been stamped by `theme-boot.ts`, which read
 * the synchronous mirror before the first paint. This is the authoritative pass: it re-applies from
 * IndexedDB, which is the record, and repairs the mirror if the two ever disagree -- a database
 * written by an older version, a mirror cleared by the browser, a second profile.
 */
export async function applyStoredTheme(root: HTMLElement): Promise<Theme> {
  const theme = await getTheme()
  applyTheme(theme, root)
  mirrorTheme(theme)
  return theme
}

/**
 * Wires one button to cycle the palette, for any page that wants to offer the control.
 *
 * This lives here rather than in a page because two copies of it would drift: every page with the
 * button has to agree on the cycle order, on which icon means which state, and on what the
 * label says -- and a control that cycles has to announce *where it goes next*, which is the part
 * that is easy to get subtly wrong twice.
 *
 * The button is expected to hold one `[data-theme-icon]` element per choice; all but the current one
 * are hidden.
 */
export async function wireThemeButton(button: HTMLElement, root: HTMLElement): Promise<void> {
  let theme = await applyStoredTheme(root)
  draw()
  button.addEventListener('click', () => {
    theme = nextTheme(theme)
    applyTheme(theme, root)
    draw()
    // Stored after it is applied: the change must show immediately whether or not the write lands,
    // and a failed write is a preference that does not persist, not a broken page.
    void setTheme(theme).catch(() => undefined)
  })

  function draw(): void {
    for (const icon of button.querySelectorAll<SVGElement>('[data-theme-icon]')) {
      icon.toggleAttribute('hidden', icon.dataset.themeIcon !== theme)
    }
    const label = `Theme: ${themeLabel(theme).toLowerCase()}. Switch to ${themeLabel(nextTheme(theme)).toLowerCase()}`
    button.title = label
    button.setAttribute('aria-label', label)
  }
}
