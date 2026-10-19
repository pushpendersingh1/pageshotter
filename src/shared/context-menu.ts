import { getContextMenu } from './history-settings'
import type { CaptureMode } from './messages'

/**
 * The capture items in the page's right-click menu.
 *
 * Three fixed items rather than one that repeats the last mode: a label that changes with history
 * is a label that has to be read every time. With more than one item the browser nests them under
 * the extension's name, so the page's own menu gains a single line.
 *
 * A click grants `activeTab` for the tab that was right-clicked, exactly as the toolbar button does,
 * which is why the menu needs no access to any page of its own.
 */
const ITEMS: readonly { id: string; mode: CaptureMode; title: string }[] = [
  { id: 'capture-full', mode: 'full', title: 'Capture full page' },
  { id: 'capture-visible', mode: 'visible', title: 'Capture visible part' },
  { id: 'capture-region', mode: 'region', title: 'Select a region' },
]

/**
 * Every context a right-click on a page can open in. Not `all`, which in Chrome also covers the
 * toolbar button's own menu, where these items would duplicate the popup one click away.
 */
const CONTEXTS: [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]] = [
  'page',
  'frame',
  'selection',
  'link',
  'editable',
  'image',
  'video',
  'audio',
]

export function contextMenuMode(menuItemId: string | number): CaptureMode | undefined {
  return ITEMS.find((item) => item.id === menuItemId)?.mode
}

/**
 * Replaces whatever is in the menu with what the setting says. Remove-then-create makes it safe to
 * call from both install and startup, and from Settings whenever the switch moves.
 */
export async function showContextMenu(on: boolean): Promise<void> {
  await chrome.contextMenus.removeAll()
  if (!on) return
  for (const { id, title } of ITEMS) {
    // A callback only to read `lastError`: two overlapping refreshes can race one item's creation,
    // and the loser's duplicate-id error would otherwise surface as an unchecked one.
    chrome.contextMenus.create({ id, title, contexts: CONTEXTS }, () => void chrome.runtime.lastError)
  }
}

export async function refreshContextMenu(): Promise<void> {
  await showContextMenu(await getContextMenu())
}
