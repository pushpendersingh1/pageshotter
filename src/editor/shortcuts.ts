/**
 * The keyboard map, as data for the `?` sheet, plus the typing guards the editor's key handler reads.
 *
 * This list is the sheet's whole content, so it lists only shortcuts that work. Anything planned but
 * unbuilt stays out. The list was checked against the real handlers and corrected here, not in the
 * handlers: an earlier draft was missing cut, to front / to back, zoom
 * at the pointer, pan horizontally and middle-drag pan, and it called the nudge step "px" when the
 * editor nudges in scene units. `tests/shortcuts.test.ts` locks the list's shape and key entries.
 */
export interface ShortcutEntry {
  /**
   * One entry per keycap, in order. A `+`-joined chord draws one cap per key, so redo is three caps
   * rather than one wide `⇧⌘Z`; a leading `~` marks plain words set between caps ("or hold").
   */
  keys: readonly string[]
  action: string
}

export interface ShortcutGroup {
  label: string
  entries: readonly ShortcutEntry[]
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    label: 'Tools',
    entries: [
      { keys: ['V'], action: 'Move' },
      { keys: ['H', '~or hold', 'space'], action: 'Hand' },
      { keys: ['R'], action: 'Rectangle' },
      { keys: ['O'], action: 'Ellipse' },
      { keys: ['A'], action: 'Arrow' },
      { keys: ['L'], action: 'Line' },
      { keys: ['T'], action: 'Text' },
      { keys: ['U'], action: 'Highlight' },
      { keys: ['B'], action: 'Blur' },
      { keys: ['D'], action: 'Pen' },
      { keys: ['K'], action: 'Marker' },
      { keys: ['N'], action: 'Counter' },
      { keys: ['M'], action: 'Magnifier' },
      { keys: ['E'], action: 'Emoji' },
      { keys: ['I'], action: 'Image' },
      { keys: ['C'], action: 'Crop' },
      { keys: ['P'], action: 'Present' },
    ],
  },
  {
    label: 'Editing',
    entries: [
      { keys: ['cmd+Z'], action: 'Undo' },
      { keys: ['shift+cmd+Z'], action: 'Redo' },
      { keys: ['cmd+D', '~or', 'alt', '~+ drag'], action: 'Duplicate' },
      { keys: ['cmd+X'], action: 'Cut' },
      { keys: ['cmd+C'], action: 'Copy' },
      { keys: ['cmd+V'], action: 'Paste' },
      { keys: ['bksp', '~or', 'del'], action: 'Delete selection' },
      { keys: ['cmd+A'], action: 'Select all' },
      { keys: ['cmd+G'], action: 'Group' },
      { keys: ['shift+cmd+G'], action: 'Ungroup' },
      { keys: ['cmd+]'], action: 'Bring forward' },
      { keys: ['cmd+['], action: 'Send backward' },
      { keys: ['shift+cmd+]'], action: 'To front' },
      { keys: ['shift+cmd+['], action: 'To back' },
      { keys: ['shift+cmd+H'], action: 'Hide or show' },
      { keys: ['arrows'], action: 'Nudge 1 scene unit' },
      { keys: ['shift+arrows'], action: 'Nudge 10 scene units' },
      { keys: ['enter'], action: 'Edit text, or apply a crop' },
    ],
  },
  {
    label: 'View',
    entries: [
      { keys: ['cmd+plus'], action: 'Zoom in' },
      { keys: ['cmd+minus'], action: 'Zoom out' },
      { keys: ['shift+0'], action: '100%' },
      { keys: ['shift+1'], action: 'Fit' },
      { keys: ['shift+2'], action: 'Zoom to selection' },
      { keys: ['cmd', '~+ scroll'], action: 'Zoom at the pointer' },
      { keys: ['space', '~+ drag, or middle-drag'], action: 'Pan' },
      { keys: ['shift', '~+ scroll'], action: 'Pan horizontally' },
      { keys: ['cmd+backslash'], action: 'Minimise the interface' },
      { keys: ['esc'], action: 'Deselect, or leave a group' },
      { keys: ['?'], action: 'This sheet' },
    ],
  },
]

export { keycaps, isWindowsAgent, type Keycap } from '../shared/keycaps'

/** Held during a gesture, stated once under the three columns. */
export const GESTURE_MODIFIERS: readonly { key: string; text: string }[] = [
  // Said precisely, because until draw and rotate constraints were built "constrains" was true of resize alone: it did
  // nothing while drawing and nothing while rotating, and the sheet promised otherwise.
  { key: 'shift', text: 'constrains a draw, a resize, or a rotation' },
  { key: 'alt', text: 'draws from the centre, resizes from the centre, or duplicates' },
  { key: 'cmd', text: 'turns snapping off' },
]

/** The parts of a DOM element and a key event the typing guard reads, so Node can test it. */
export interface FocusLike {
  tagName?: string
  isContentEditable?: boolean
}

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

/**
 * The command view keys which the editor still answers from inside a field: Chrome would otherwise
 * take `⌘+`/`⌘−` as page zoom, and neither edits anything.
 */
const VIEW_KEYS: readonly string[] = ['\\', '+', '=', '-', '_']

/** Whether focus is somewhere that takes typing: an input, textarea, select or contentEditable. */
export function isTypingElement(element: FocusLike | null | undefined): boolean {
  if (!element) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName ?? '') || element.isContentEditable === true
}

/**
 * Whether a key belongs to the focused field rather than to the editor.
 *
 * The bug: `Ctrl A` in the X field selected every layer. A field owns
 * every key, `⌘A`/`⌘Z`/`⌘C`/`⌘V`/`⌘X` included, apart from the view keys above.
 */
export function typingOwnsKey(element: FocusLike | null | undefined, event: KeyLike): boolean {
  if (!isTypingElement(element)) return false
  return !((event.metaKey || event.ctrlKey) && VIEW_KEYS.includes(event.key))
}

interface ZoomKeyLike extends KeyLike {
  code?: string
  shiftKey: boolean
  altKey: boolean
}

/** The three Shift+digit view shortcuts, including shifted US-layout key values for synthetic events. */
export function shiftZoomChoice(event: ZoomKeyLike): '1' | 'fit' | 'selection' | undefined {
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (event.code === 'Digit0' || event.key === '0' || event.key === ')') return '1'
  if (event.code === 'Digit1' || event.key === '1' || event.key === '!') return 'fit'
  if (event.code === 'Digit2' || event.key === '2' || event.key === '@') return 'selection'
  return undefined
}

