import { describe, expect, it } from 'vitest'
import {
  filenameProblem,
  sanitiseTypedFilename,
  suggestedFilename,
} from '../src/shared/filename'

/*
 * Built from local components on purpose. The name renders the user's calendar, not UTC, so a
 * fixture pinned to a UTC instant renders differently depending on the machine's timezone and the
 * suite would pass here and fail in CI.
 */
const at = new Date(2026, 7, 28, 9, 5, 3)
const base = {
  title: 'Quarterly Report',
  url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/length',
  capturedAt: at,
  extension: 'png' as const,
}

describe('suggestedFilename', () => {
  it('sorts chronologically and identifies the page', () => {
    expect(suggestedFilename(base)).toBe('2026-08-28-090503-developer-mozilla-org-quarterly-report.png')
  })

  it('appends the real extension', () => {
    expect(suggestedFilename({ ...base, extension: 'pdf' })).toBe(
      '2026-08-28-090503-developer-mozilla-org-quarterly-report.pdf',
    )
  })

  it('caps the base name at 120 without ever losing the extension', () => {
    const long = suggestedFilename({ ...base, title: 'a'.repeat(300) })
    expect(long).toHaveLength(120 + '.png'.length)
    expect(long).toMatch(/^2026-08-28-090503-developer-mozilla-org-a+\.png$/)
  })

  it('collapses separators rather than leaving gaps where the host or title is empty', () => {
    expect(suggestedFilename({ ...base, url: undefined })).toBe('2026-08-28-090503-quarterly-report.png')
    expect(suggestedFilename({ ...base, title: '???', url: 'not a url' })).toBe('2026-08-28-090503.png')
  })

  it('never emits a path separator, so a title cannot smuggle in a directory', () => {
    const out = suggestedFilename({ ...base, url: undefined, title: '../../etc/passwd' })
    expect(out).toBe('2026-08-28-090503-etc-passwd.png')
    expect(out).not.toContain('/')
    expect(out).not.toContain('..')
  })

  it('uses local calendar fields, so a capture is named for the day the user saw', () => {
    // 04:30 on 1 January is still 31 December in UTC anywhere east of UTC+4:30; the name follows the local clock.
    const local = new Date(2026, 0, 1, 4, 30, 0)
    expect(suggestedFilename({ ...base, url: undefined, title: '', capturedAt: local })).toBe('2026-01-01-043000.png')
  })
})

describe('sanitiseTypedFilename', () => {
  it('leaves an ordinary typed name alone, spaces and punctuation included', () => {
    expect(sanitiseTypedFilename('Q3 Report (final)')).toBe('Q3 Report (final)')
  })

  it('keeps letters outside ASCII, which the template slug deliberately folds away', () => {
    expect(sanitiseTypedFilename('\u00dcbersicht Bericht')).toBe('\u00dcbersicht Bericht')
  })

  it('removes path separators so a typed name cannot choose a directory', () => {
    expect(sanitiseTypedFilename('../../etc/passwd')).toBe('etc passwd')
    expect(sanitiseTypedFilename('a\\b')).toBe('a b')
  })

  it('removes characters Windows refuses in a filename', () => {
    expect(sanitiseTypedFilename('a<b>c:d"e|f?g*h')).toBe('a b c d e f g h')
  })

  it('removes control characters', () => {
    expect(sanitiseTypedFilename('report\u0001\u0002name')).toBe('report name')
  })

  it('trims leading and trailing dots and spaces, which Windows silently drops', () => {
    expect(sanitiseTypedFilename('  ..report..  ')).toBe('report')
  })

  it('escapes a reserved Windows device name rather than producing an unopenable file', () => {
    expect(sanitiseTypedFilename('CON')).toBe('CON-capture')
    expect(sanitiseTypedFilename('com1')).toBe('com1-capture')
    expect(sanitiseTypedFilename('CONSOLE')).toBe('CONSOLE')
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitiseTypedFilename('   ')).toBe('pageshotter-capture')
    expect(sanitiseTypedFilename('/////')).toBe('pageshotter-capture')
  })

  it('caps the length and never leaves a trailing space', () => {
    expect(sanitiseTypedFilename('a'.repeat(300))).toHaveLength(120)
    expect(sanitiseTypedFilename('ab '.repeat(80))).not.toMatch(/ $/)
  })
})

describe('filenameProblem', () => {
  it('accepts an ordinary name', () => {
    expect(filenameProblem('Q3 Report (final)')).toBeUndefined()
  })

  it('rejects an empty box, and says what to do rather than what went wrong', () => {
    expect(filenameProblem('')).toBe('Enter a file name.')
  })

  it('rejects whitespace only, which looks like a name and is not one', () => {
    expect(filenameProblem('   ')).toBe('Enter a file name.')
    expect(filenameProblem('\t \n ')).toBe('Enter a file name.')
  })

  it('rejects a name made only of characters a file cannot contain', () => {
    expect(filenameProblem('///')).toBe('That name is only characters a file cannot contain.')
    expect(filenameProblem('<>:"|?*')).toBe('That name is only characters a file cannot contain.')
  })

  it('rejects dots and spaces alone, which every filesystem strips to nothing', () => {
    expect(filenameProblem('...')).toBe('That name is only characters a file cannot contain.')
  })

  it('accepts a name that merely contains bad characters alongside usable ones', () => {
    expect(filenameProblem('a/b')).toBeUndefined()
  })

  it('accepts the fallback name typed deliberately, which is a real name a user may want', () => {
    expect(filenameProblem('pageshotter-capture')).toBeUndefined()
  })

  it('accepts a reserved device name, which is repaired rather than refused', () => {
    expect(filenameProblem('CON')).toBeUndefined()
    expect(sanitiseTypedFilename('CON')).toBe('CON-capture')
  })
})
