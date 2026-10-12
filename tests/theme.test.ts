import { describe, expect, it } from 'vitest'

import { THEME_CHOICES, nextTheme, readTheme, themeLabel, type Theme } from '../src/shared/theme'

describe('nextTheme', () => {
  it('cycles through every choice and returns to the start', () => {
    const seen: Theme[] = []
    let theme: Theme = 'system'
    for (let step = 0; step < THEME_CHOICES.length; step += 1) {
      seen.push(theme)
      theme = nextTheme(theme)
    }
    expect(seen).toEqual(THEME_CHOICES.map((choice) => choice.theme))
    // A full cycle must land back where it started, or the button would be a one-way trip.
    expect(theme).toBe('system')
  })

  it('restarts at the default from a value that is no longer offered', () => {
    expect(nextTheme('sepia' as Theme)).toBe('system')
  })
})

describe('readTheme', () => {
  it('accepts the values we store', () => {
    for (const { theme } of THEME_CHOICES) expect(readTheme(theme)).toBe(theme)
  })

  it('falls back to following the system for anything else', () => {
    // A stored value can outlive the release that wrote it, so an unknown one must not stick.
    for (const stored of [undefined, null, '', 'sepia', 0, true, {}]) {
      expect(readTheme(stored)).toBe('system')
    }
  })
})

describe('themeLabel', () => {
  it('names every choice', () => {
    for (const { theme, label } of THEME_CHOICES) expect(themeLabel(theme)).toBe(label)
  })
})
