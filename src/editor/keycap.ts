import { isWindowsAgent, keycaps, type Keycap } from './shortcuts'

const SVG = 'http://www.w3.org/2000/svg'

/** One drawn cap: a character, a word, or a stroked glyph carrying its own name for a screen reader. */
export function keycapElement(cap: Keycap): HTMLElement {
  if (cap.kind === 'text') {
    const text = document.createElement('span')
    text.className = 'keys-text'
    text.textContent = cap.text
    return text
  }
  const key = document.createElement('kbd')
  key.className = 'kbd'
  if (cap.kind === 'char') {
    if (cap.text.length > 1) key.classList.add('kbd-word')
    key.textContent = cap.text
    return key
  }
  key.classList.add('kbd-glyph')
  key.setAttribute('role', 'img')
  key.setAttribute('aria-label', cap.label)
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', cap.path)
  svg.append(path)
  key.append(svg)
  return key
}

/** The caps for one row of the shortcuts sheet, or for one menu entry. */
export function keycapRow(keys: readonly string[], windows: boolean): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'keys-caps'
  for (const cap of keycaps(keys, windows)) wrap.append(keycapElement(cap))
  return wrap
}

/**
 * Paints every `[data-keys]` in `root` as drawn caps, so a shortcut looks the same in the menus as
 * it does in the sheet. The attribute holds the same chord syntax the sheet's data uses, and the
 * element keeps its own `aria-label` if it has one -- the caps are decoration beside a named row.
 */
export function paintKeycaps(root: ParentNode): void {
  const windows = isWindowsAgent(navigator.userAgent)
  for (const host of root.querySelectorAll<HTMLElement>('[data-keys]')) {
    const keys = (host.dataset.keys ?? '').split(' ').filter((part) => part !== '')
    host.replaceChildren(...keycaps(keys, windows).map(keycapElement))
  }
}
