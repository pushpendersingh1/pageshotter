import { keycapRow } from './keycap'
import { GESTURE_MODIFIERS, SHORTCUT_GROUPS, isWindowsAgent } from './shortcuts'

interface OverlayHost {
  /** Esc, a backdrop click, or pressing `?` again: closed without any other effect. */
  close(): void
}

/**
 * The `?` shortcuts sheet: a native modal `<dialog>` listing every shortcut that works, in three
 * columns, with one
 * drawn keycap per key. It owns only its own DOM; what closing means belongs to the editor.
 */
export class ShortcutOverlay {
  private readonly grid: HTMLElement
  private readonly filter: HTMLInputElement
  private readonly empty: HTMLElement
  private windows = isWindowsAgent(navigator.userAgent)

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly host: OverlayHost,
  ) {
    this.grid = this.child('.keys-grid')
    this.empty = this.child('.keys-empty')
    this.filter = this.child<HTMLInputElement>('.keys-filter input')
    // Esc reaches the document handler too, which ascends a group and deselects; that must not fire
    // underneath a dialog which is merely being dismissed, so closing goes through the host.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.host.close()
    })
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) this.host.close()
    })
    this.child<HTMLButtonElement>('.keys-close').addEventListener('click', () => this.host.close())
    this.filter.addEventListener('input', () => this.draw())
    const platform = dialog.querySelectorAll<HTMLButtonElement>('.keys-platform button')
    for (const button of platform) {
      button.addEventListener('click', () => {
        this.windows = button.value === 'windows'
        for (const other of platform) other.setAttribute('aria-pressed', String(other === button))
        this.draw()
      })
      button.setAttribute('aria-pressed', String(button.value === (this.windows ? 'windows' : 'mac')))
    }
    this.draw()
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  open(): void {
    if (this.dialog.open) return
    this.dialog.showModal()
    // The sheet keeps the height of the whole list while it is filtered: a dialog that shrinks under
    // the pointer as you type moves the field you are typing in. Measured on each open rather than
    // once, so a resized window is measured at its own width; `close` clears the filter, so what is
    // on screen here is always the full list.
    this.grid.style.minHeight = ''
    this.grid.style.minHeight = `${this.grid.offsetHeight}px`
    this.filter.focus()
  }

  close(): void {
    if (!this.dialog.open) return
    this.filter.value = ''
    this.draw()
    this.dialog.close()
  }

  private child<T extends HTMLElement>(selector: string): T {
    const found = this.dialog.querySelector<T>(selector)
    if (!found) throw new Error(`Shortcut sheet is missing ${selector}`)
    return found
  }

  private draw(): void {
    const query = this.filter.value.trim().toLowerCase()
    const columns: HTMLElement[] = []
    for (const group of SHORTCUT_GROUPS) {
      const entries = query === '' ? group.entries : group.entries.filter((entry) => entry.action.toLowerCase().includes(query))
      if (entries.length > 0) columns.push(this.column(group.label, entries))
    }
    this.footer()
    this.empty.hidden = columns.length > 0
    this.empty.textContent = `No shortcut matches “${this.filter.value.trim()}”.`
    this.grid.replaceChildren(...columns, this.empty)
  }

  private column(label: string, entries: readonly { keys: readonly string[]; action: string }[]): HTMLElement {
    const column = document.createElement('div')
    column.className = 'keys-group'
    const heading = document.createElement('h4')
    heading.className = 'eyebrow'
    heading.textContent = label
    column.append(heading)
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'keys-row'
      const action = document.createElement('span')
      action.className = 'keys-label'
      action.textContent = entry.action
      row.append(action, this.caps(entry.keys))
      column.append(row)
    }
    return column
  }

  private caps(keys: readonly string[]): HTMLElement {
    return keycapRow(keys, this.windows)
  }

  /** The footer's modifier line. Drawn with the rest, because its caps follow the platform switch. */
  private footer(): void {
    const line = this.child('.keys-gestures')
    const parts: (HTMLElement | string)[] = []
    for (const modifier of GESTURE_MODIFIERS) {
      const item = document.createElement('span')
      item.className = 'keys-gesture'
      item.append(this.caps([modifier.key]), document.createTextNode(modifier.text))
      parts.push(item)
    }
    line.replaceChildren(...parts)
  }
}
