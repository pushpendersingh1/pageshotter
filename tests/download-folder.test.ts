import { describe, expect, it } from 'vitest'
import {
  displayedDownloadPath,
  downloadPath,
  folderProblem,
  sanitiseFolder,
} from '../src/shared/download-folder'

describe('sanitiseFolder', () => {
  it('keeps an ordinary folder name', () => {
    expect(sanitiseFolder('PageShotter')).toBe('PageShotter')
  })

  it('keeps a nested path and normalises its separators', () => {
    expect(sanitiseFolder('Work/Screenshots')).toBe('Work/Screenshots')
    expect(sanitiseFolder('Work\\Screenshots')).toBe('Work/Screenshots')
  })

  it('strips leading and trailing separators, so the value can never be absolute', () => {
    expect(sanitiseFolder('/PageShotter/')).toBe('PageShotter')
    expect(sanitiseFolder('///a///b///')).toBe('a/b')
  })

  it('removes every traversal segment rather than resolving it', () => {
    expect(sanitiseFolder('../../etc')).toBe('etc')
    expect(sanitiseFolder('a/../../b')).toBe('a/b')
    expect(sanitiseFolder('..')).toBe('')
  })

  it('removes characters a filesystem refuses in a path segment', () => {
    expect(sanitiseFolder('a<b>:c|d?e*f')).toBe('a b c d e f')
  })

  it('trims dots and spaces from each segment, not just the whole string', () => {
    expect(sanitiseFolder(' .a. / .b. ')).toBe('a/b')
  })

  it('escapes a reserved device name in any segment', () => {
    expect(sanitiseFolder('CON/shots')).toBe('CON-folder/shots')
  })

  it('returns empty for a value with nothing usable, meaning no folder', () => {
    expect(sanitiseFolder('')).toBe('')
    expect(sanitiseFolder('   ')).toBe('')
    expect(sanitiseFolder('///')).toBe('')
  })

  it('caps the depth so a pasted path cannot nest without limit', () => {
    expect(sanitiseFolder('a/b/c/d/e/f')).toBe('a/b/c')
  })
})

describe('folderProblem', () => {
  it('accepts an empty value, which means save to Downloads itself', () => {
    expect(folderProblem('')).toBeUndefined()
    expect(folderProblem('   ')).toBeUndefined()
  })

  it('accepts an ordinary folder', () => {
    expect(folderProblem('PageShotter')).toBeUndefined()
  })

  it('explains a value that is only unusable characters', () => {
    expect(folderProblem('///')).toBe('That folder name is only characters a folder cannot contain.')
    expect(folderProblem('..')).toBe('That folder name is only characters a folder cannot contain.')
  })
})

describe('downloadPath', () => {
  it('joins the folder and the filename', () => {
    expect(downloadPath('PageShotter', 'shot.png')).toBe('PageShotter/shot.png')
  })

  it('returns the bare filename when there is no folder', () => {
    expect(downloadPath('', 'shot.png')).toBe('shot.png')
    expect(downloadPath('   ', 'shot.png')).toBe('shot.png')
  })

  it('sanitises the folder on the way through, so a stored value cannot escape later', () => {
    expect(downloadPath('../../etc', 'shot.png')).toBe('etc/shot.png')
  })

  it('never lets the filename contribute a separator', () => {
    expect(downloadPath('PageShotter', 'a/b.png')).toBe('PageShotter/a-b.png')
  })
})

describe('displayedDownloadPath', () => {
  it('shows the complete destination inside Downloads', () => {
    expect(displayedDownloadPath('PageShotter', 'capture.png')).toBe(
      'Downloads/PageShotter/capture.png',
    )
    expect(displayedDownloadPath('', 'capture.png')).toBe('Downloads/capture.png')
  })
})
