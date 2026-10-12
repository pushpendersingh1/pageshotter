// @ts-expect-error -- Vite serves the file's text; this project has no node types to read it with.
import editorHtml from '../public/editor.html?raw'
import { describe, expect, it } from 'vitest'
import {
  GESTURE_MODIFIERS,
  SHORTCUT_GROUPS,
  isTypingElement,
  isWindowsAgent,
  keycaps,
  shiftZoomChoice,
  typingOwnsKey,
} from '../src/editor/shortcuts'
import { parseChromeShortcut } from '../src/shared/keycaps'

describe('the ? sheet data', () => {
  const rows = SHORTCUT_GROUPS.flatMap((group) => group.entries)
  const chords = (action: string): readonly string[] => rows.find((entry) => entry.action === action)?.keys ?? []

  it('carries the keyboard map in its three columns, with one action per row', () => {
    expect(SHORTCUT_GROUPS.map((group) => group.label)).toEqual(['Tools', 'Editing', 'View'])
    for (const group of SHORTCUT_GROUPS) {
      expect(group.entries.length).toBeGreaterThan(0)
      for (const entry of group.entries) {
        expect(entry.keys.length).toBeGreaterThan(0)
        expect(entry.action.trim()).not.toBe('')
      }
    }
  })

  it('lists the shortcuts the missing-shortcut pass built, because they work now', () => {
    expect(chords('Bring forward')).toEqual(['cmd+]'])
    expect(chords('Send backward')).toEqual(['cmd+['])
    expect(chords('To front')).toEqual(['shift+cmd+]'])
    expect(chords('To back')).toEqual(['shift+cmd+['])
    expect(chords('Zoom in')).toEqual(['cmd+plus'])
    expect(chords('Zoom out')).toEqual(['cmd+minus'])
    expect(chords('Pan').join(' ')).toContain('middle-drag')
    expect(chords('Duplicate')).toContain('alt')
  })

  it('names the gesture modifiers once each, and all three', () => {
    expect(GESTURE_MODIFIERS.map((modifier) => modifier.key)).toEqual(['shift', 'alt', 'cmd'])
  })

  it('lists the Shift+digit view shortcuts and no retired command aliases', () => {
    const view = SHORTCUT_GROUPS.find((group) => group.label === 'View')?.entries ?? []
    expect(view).toEqual(
      expect.arrayContaining([
        { keys: ['shift+0'], action: '100%' },
        { keys: ['shift+1'], action: 'Fit' },
        { keys: ['shift+2'], action: 'Zoom to selection' },
      ]),
    )
    expect(view.some((entry) => entry.keys.includes('cmd+0') || entry.keys.includes('cmd+1'))).toBe(false)
  })

  it('corrects the draft table rather than the handlers', () => {
    // An earlier draft omitted cut, to front / to back, zoom at the pointer and pan horizontally,
    // and called the nudge step "px" when the editor nudges in scene units.
    expect(chords('Cut')).toEqual(['cmd+X'])
    expect(rows.some((entry) => entry.action === 'Zoom at the pointer')).toBe(true)
    expect(rows.some((entry) => entry.action === 'Pan horizontally')).toBe(true)
    expect(rows.some((entry) => entry.action.includes('scene unit'))).toBe(true)
    expect(rows.some((entry) => entry.action.includes(' px'))).toBe(false)
  })
})

describe('keycaps', () => {
  it('draws one cap per key, so redo is three caps', () => {
    expect(keycaps(['shift+cmd+Z'], false)).toEqual([
      { kind: 'glyph', path: expect.any(String), label: 'Shift' },
      { kind: 'glyph', path: expect.any(String), label: 'Command' },
      { kind: 'char', text: 'Z' },
    ])
  })

  it('spells the modifiers out on Windows', () => {
    expect(keycaps(['shift+cmd+Z'], true)).toEqual([
      { kind: 'char', text: 'Shift' },
      { kind: 'char', text: 'Ctrl' },
      { kind: 'char', text: 'Z' },
    ])
  })

  it('keeps the words between caps as plain text', () => {
    expect(keycaps(['H', '~or hold', 'space'], false)).toEqual([
      { kind: 'char', text: 'H' },
      { kind: 'text', text: 'or hold' },
      { kind: 'char', text: 'Space' },
    ])
  })

  it('prints a named key as its character', () => {
    expect(keycaps(['cmd+backslash'], true).at(-1)).toEqual({ kind: 'char', text: '\\' })
    expect(keycaps(['cmd+minus'], true).at(-1)).toEqual({ kind: 'char', text: '−' })
  })

  it('every glyph the data asks for exists, in both platforms', () => {
    for (const entry of SHORTCUT_GROUPS.flatMap((group) => group.entries)) {
      for (const windows of [false, true]) {
        for (const cap of keycaps(entry.keys, windows)) {
          if (cap.kind === 'glyph') expect(cap.path.length).toBeGreaterThan(10)
          else expect(cap.text).not.toBe('')
        }
      }
    }
  })

  it('reads the platform off the agent string', () => {
    expect(isWindowsAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
    expect(isWindowsAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
    expect(isWindowsAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe(true)
  })
})

describe('Shift+digit zoom shortcuts', () => {
  const key = (code: string, key: string, extra: Partial<KeyboardEvent> = {}) => ({
    code,
    key,
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  })

  it('maps Shift 0, 1 and 2 to the existing zoom choices', () => {
    expect(shiftZoomChoice(key('Digit0', ')'))).toBe('1')
    expect(shiftZoomChoice(key('Digit1', '!'))).toBe('fit')
    expect(shiftZoomChoice(key('Digit2', '@'))).toBe('selection')
  })

  it('does not keep the command shortcuts as aliases', () => {
    expect(shiftZoomChoice(key('Digit0', '0', { shiftKey: false, metaKey: true }))).toBeUndefined()
    expect(shiftZoomChoice(key('Digit1', '1', { shiftKey: false, ctrlKey: true }))).toBeUndefined()
  })
})

describe('typing owns the keyboard', () => {
  const input = { tagName: 'INPUT' }
  const key = (key: string, command = false) => ({ key, metaKey: command, ctrlKey: false })

  it('recognises every element that takes typing, and nothing else', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingElement({ tagName })).toBe(true)
    expect(isTypingElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingElement({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingElement({ tagName: 'CANVAS' })).toBe(false)
    expect(isTypingElement(null)).toBe(false)
  })

  it('gives a focused field the editing shortcuts, Ctrl A first', () => {
    for (const letter of ['a', 'z', 'c', 'v', 'x', 'd', 'g', ']', '[']) expect(typingOwnsKey(input, key(letter, true))).toBe(true)
    expect(typingOwnsKey(input, { key: 'a', metaKey: false, ctrlKey: true })).toBe(true)
    expect(typingOwnsKey(input, key('Backspace'))).toBe(true)
    expect(typingOwnsKey(input, key('v'))).toBe(true)
  })

  it('still lets the active command view keys through', () => {
    for (const view of ['+', '=', '-', '\\']) expect(typingOwnsKey(input, key(view, true))).toBe(false)
    for (const retired of ['0', '1']) expect(typingOwnsKey(input, key(retired, true))).toBe(true)
  })

  it('leaves every key to the editor when nothing takes typing', () => {
    expect(typingOwnsKey({ tagName: 'BODY' }, key('a', true))).toBe(false)
  })

})

describe('the menus show the same shortcut as the sheet', () => {
  const html = editorHtml as string
  const chord = (action: string): string =>
    (SHORTCUT_GROUPS.flatMap((group) => group.entries).find((entry) => entry.action === action)?.keys ?? []).join(' ')
  const menu = (label: string): string | undefined =>
    new RegExp(`<span>${label}</span><span class="keys-caps" data-keys="([^"]+)"`).exec(html)?.[1]

  // The zoom menu advertised Cmd 0 and Cmd 1 long after they were retired. A menu that names a
  // shortcut and the sheet that lists it must not be able to disagree again.
  it('names the zoom shortcuts the editor actually answers to', () => {
    expect(menu('100%')).toBe(chord('100%'))
    expect(menu('Fit')).toBe(chord('Fit'))
    expect(menu('Zoom to selection')).toBe(chord('Zoom to selection'))
  })

  it('leaves no retired command binding in the markup', () => {
    expect(html).not.toContain('&#8984;0')
    expect(html).not.toContain('&#8984;1')
  })

  it('every painted chord is one the cap renderer understands', () => {
    for (const [, keys] of html.matchAll(/data-keys="([^"]+)"/g)) {
      for (const cap of keycaps((keys ?? '').split(' '), false)) {
        if (cap.kind !== 'text') expect(cap.kind === 'glyph' ? cap.path : cap.text).not.toBe('')
      }
    }
  })
})

describe("Chrome's own shortcut strings, on the popup chips", () => {
  it('reads the macOS glyph run and the Windows words alike', () => {
    expect(parseChromeShortcut('⌘⇧S')).toEqual(['cmd', 'shift', 'S'])
    expect(parseChromeShortcut('Ctrl+Shift+S')).toEqual(['cmd', 'shift', 'S'])
    expect(parseChromeShortcut('Alt+Shift+1')).toEqual(['alt', 'shift', '1'])
  })

  it('passes anything it does not recognise through, since Chrome wrote it', () => {
    expect(parseChromeShortcut('Ctrl+F13')).toEqual(['cmd', 'F13'])
    expect(parseChromeShortcut('⌘§')).toEqual(['cmd', '§'])
  })

  it('draws the modifiers and leaves the key as a character', () => {
    expect(keycaps(parseChromeShortcut('⌘⇧S'), false).map((cap) => cap.kind)).toEqual(['glyph', 'glyph', 'char'])
  })
})
