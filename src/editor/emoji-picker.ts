import { EMOJI_GROUPS, emojiEntry, searchEmoji, type EmojiEntry } from './emoji'

/** Must match `.emoji-grid`'s column count in `editor.css`, because the arrow keys step by it. */
const COLUMNS = 8

interface PickerHost {
  /** A glyph was picked; the editor arms the Emoji tool with it. */
  choose(char: string): void
  /** Esc: closed without a choice. */
  dismiss(): void
}

/**
 * The curated emoji popover: a search field, the recent row, then the
 * six labelled groups. It owns only its own DOM; what a choice means belongs to the editor.
 */
export class EmojiPicker {
  private readonly search = document.createElement('input')
  private readonly body = document.createElement('div')
  private recent: readonly string[] = []

  constructor(
    private readonly root: HTMLElement,
    private readonly host: PickerHost,
  ) {
    this.search.type = 'search'
    this.search.className = 'emoji-search'
    this.search.placeholder = 'Search emoji'
    this.search.setAttribute('aria-label', 'Search emoji')
    this.search.addEventListener('input', () => this.render())
    this.root.replaceChildren(this.search, this.body)
    this.root.addEventListener('keydown', (event) => this.key(event))
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  open(recent: readonly string[]): void {
    this.recent = recent
    this.search.value = ''
    this.render()
    this.root.hidden = false
    this.search.focus()
  }

  close(): void {
    this.root.hidden = true
  }

  private render(): void {
    const query = this.search.value.trim()
    const sections: Array<[string, readonly EmojiEntry[]]> = query
      ? [['Results', searchEmoji(query)]]
      : [['Recent', this.recent.flatMap((char) => emojiEntry(char) ?? [])], ...EMOJI_GROUPS.map((group): [string, readonly EmojiEntry[]] => [group.label, group.emoji])]
    const shown = sections.filter(([, entries]) => entries.length > 0).map(([label, entries]) => this.section(label, entries))
    if (query && shown.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'emoji-empty'
      empty.textContent = `No emoji match “${query}”.`
      shown.push(empty)
    }
    this.body.replaceChildren(...shown)
  }

  private section(label: string, entries: readonly EmojiEntry[]): HTMLElement {
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', label)
    const heading = document.createElement('p')
    heading.className = 'emoji-label'
    heading.textContent = label
    const grid = document.createElement('div')
    grid.className = 'emoji-grid'
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'emoji-choice'
      button.textContent = entry.char
      button.title = entry.name
      button.setAttribute('aria-label', entry.name)
      button.addEventListener('click', () => this.host.choose(entry.char))
      grid.append(button)
    }
    group.append(heading, grid)
    return group
  }

  /**
   * Keys stay inside the picker, so a letter typed into search never chooses a tool and an arrow never
   * nudges the selection behind it.
   *
   * ponytail: arrows step through one flat list, so Up/Down move eight entries rather than following
   * the visual column across groups of different lengths. Fine for six short groups.
   */
  private key(event: KeyboardEvent): void {
    event.stopPropagation()
    const choices = [...this.body.querySelectorAll<HTMLButtonElement>('.emoji-choice')]
    if (event.key === 'Escape') {
      event.preventDefault()
      this.host.dismiss()
      return
    }
    if (event.target === this.search) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        choices[0]?.focus()
      } else if (event.key === 'Enter' && choices[0]) {
        event.preventDefault()
        choices[0].click()
      }
      return
    }
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS } as Record<string, number>)[event.key]
    const index = choices.indexOf(event.target as HTMLButtonElement)
    if (step === undefined || index < 0) return
    event.preventDefault()
    const next = index + step
    if (next < 0) this.search.focus()
    else choices[Math.min(next, choices.length - 1)]?.focus()
  }
}
