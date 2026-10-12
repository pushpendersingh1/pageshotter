import { SHORTCUTS_PAGE, captureShortcut } from '../shared/shortcut'
import { applyStoredTheme } from '../shared/theme'

// Chrome follows the theme; the preference is set in the popup and read by every page.
void applyStoredTheme(document.documentElement)

const shortcutTitle = requiredElement<HTMLElement>('shortcut-title')
const shortcutBody = requiredElement<HTMLElement>('shortcut-body')

requiredElement<HTMLButtonElement>('open-shortcuts').addEventListener('click', () => {
  void chrome.tabs.create({ url: SHORTCUTS_PAGE })
})
requiredElement<HTMLButtonElement>('open-settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

drawVersion()
void drawShortcut()

/**
 * From the manifest rather than a constant here: a version written in two places is a version that
 * eventually disagrees with itself.
 */
function drawVersion(): void {
  const version = requiredElement<HTMLElement>('version')
  try {
    version.textContent = `v${chrome.runtime.getManifest().version}`
  } catch {
    version.textContent = ''
  }
}

/**
 * What Chrome actually bound, not what the manifest suggested -- see `shared/shortcut.ts`. Printing
 * the suggestion on the page a person reads *at* install would promise a key that may do nothing.
 */
async function drawShortcut(): Promise<void> {
  const assigned = await captureShortcut()

  if (assigned === '') {
    shortcutTitle.textContent = 'No shortcut is assigned yet'
    shortcutBody.replaceChildren(
      'Chrome could not take the suggested combination, most likely because another extension ' +
        'already had it. Pick your own and full-page capture works without opening the popup.',
    )
    return
  }

  shortcutTitle.textContent = 'Capture the full page without the popup'
  const key = document.createElement('kbd')
  key.className = 'key'
  key.textContent = assigned
  shortcutBody.replaceChildren('Press ', key, ' on any page. Change it whenever you like.')
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element as T
}
