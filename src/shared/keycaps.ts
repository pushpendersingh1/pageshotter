/**
 * Keycaps: the modifier glyphs and the rule for turning a chord into one cap per key.
 *
 * Shared, because the editor's sheet and menus and the popup's shortcut chips all draw the same
 * keys. The chord syntax is `shift+cmd+Z`; `src/editor/shortcuts.ts` owns which chords exist.
 */
/**
 * The modifier glyphs, drawn rather than typed: `⌘` and `⌥` are unreadable at 11px in most UI faces,
 * and `⌫` is missing from several. Paths are on a 12×12 box, stroked not filled.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  cmd: 'M4.5 4.5h3v3h-3zM4.5 4.5V3.3a1.2 1.2 0 1 0-1.2 1.2h1.2M7.5 4.5V3.3a1.2 1.2 0 1 1 1.2 1.2H7.5M4.5 7.5v1.2a1.2 1.2 0 1 1-1.2-1.2h1.2M7.5 7.5v1.2a1.2 1.2 0 1 0 1.2-1.2H7.5',
  shift: 'M6 1.8l4.2 4.5H7.8v3.9H4.2V6.3H1.8z',
  alt: 'M1.5 3h2.8l3.4 6h2.8M7.4 3h3.1',
  bksp: 'M4 2.5h6.5v7H4L1.2 6zM5.7 4.5l2.9 3M8.6 4.5l-2.9 3',
  enter: 'M10 2.5v3.3a1.7 1.7 0 0 1-1.7 1.7H2.5M4.5 5.5l-2 2 2 2',
  arrows: 'M6 1.5v9M1.5 6h9M4.6 2.9L6 1.5l1.4 1.4M4.6 9.1L6 10.5l1.4-1.4M2.9 4.6L1.5 6l1.4 1.4M9.1 4.6L10.5 6 9.1 7.4',
}

const GLYPH_LABELS: Readonly<Record<string, string>> = {
  cmd: 'Command',
  shift: 'Shift',
  alt: 'Option',
  bksp: 'Delete',
  enter: 'Return',
  arrows: 'Arrow keys',
}

/** What a Mac modifier is called on Windows, where the glyphs mean nothing. */
const WINDOWS_WORDS: Readonly<Record<string, string>> = { cmd: 'Ctrl', alt: 'Alt', shift: 'Shift' }

/** Keys whose name is longer than the character that would be printed for them. */
const CHARS: Readonly<Record<string, string>> = {
  plus: '+',
  minus: '−',
  backslash: '\\',
  space: 'Space',
  esc: 'Esc',
  del: 'Del',
}

export type Keycap =
  | { kind: 'text'; text: string }
  | { kind: 'char'; text: string }
  | { kind: 'glyph'; path: string; label: string }

/** One cap per key, with modifiers drawn on macOS and spelled out on Windows. */
export function keycaps(keys: readonly string[], windows: boolean): Keycap[] {
  const caps: Keycap[] = []
  for (const part of keys) {
    if (part.startsWith('~')) {
      caps.push({ kind: 'text', text: part.slice(1) })
      continue
    }
    for (const key of part.split('+')) {
      const word = windows ? WINDOWS_WORDS[key] : undefined
      const glyph = GLYPHS[key]
      if (word !== undefined) caps.push({ kind: 'char', text: word })
      else if (glyph !== undefined) caps.push({ kind: 'glyph', path: glyph, label: GLYPH_LABELS[key] ?? key })
      else caps.push({ kind: 'char', text: CHARS[key] ?? key })
    }
  }
  return caps
}

/** Which platform's modifier names to show. A surface with a switch of its own overrides it. */
export function isWindowsAgent(agent: string): boolean {
  return !/Mac|iPhone|iPad/i.test(agent)
}

/**
 * Chrome's own spelling of an assigned command, as `chrome.commands.getAll()` returns it: the
 * glyph run `⌘⇧S` on macOS, and `Ctrl+Shift+S` elsewhere. Anything unrecognised is passed through
 * as its own cap rather than dropped, since this string comes from Chrome and not from us.
 */
export function parseChromeShortcut(shortcut: string): string[] {
  const named: Readonly<Record<string, string>> = {
    Command: 'cmd', Ctrl: 'cmd', Control: 'cmd', MacCtrl: 'ctrl', Alt: 'alt', Option: 'alt', Shift: 'shift',
  }
  if (shortcut.includes('+')) return shortcut.split('+').map((part) => named[part.trim()] ?? part.trim())
  const glyphs: Readonly<Record<string, string>> = { '\u2318': 'cmd', '\u21e7': 'shift', '\u2325': 'alt', '\u2303': 'ctrl' }
  const keys: string[] = []
  for (const character of [...shortcut]) keys.push(glyphs[character] ?? character)
  return keys
}

/** The path for one modifier glyph, for a surface that draws its own caps. */
export function glyphPath(key: string): string | undefined {
  return GLYPHS[key]
}
