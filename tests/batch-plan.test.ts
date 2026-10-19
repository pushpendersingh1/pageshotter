import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BATCH_OPTIONS,
  batchFilename,
  batchFolder,
  batchFolderName,
  parseBatchUrls,
  readBatchOptions,
  siteCount,
} from '../src/batch/batch-plan'

describe('parseBatchUrls', () => {
  it('takes one URL per line, and spaces separate entries too', () => {
    const { urls, rejected } = parseBatchUrls('https://a.example/one\n\nhttps://b.example/two https://c.example/\t')
    expect(urls).toEqual(['https://a.example/one', 'https://b.example/two', 'https://c.example/'])
    expect(rejected).toEqual([])
  })

  it('adds https:// to a bare host, because that is what typing one means', () => {
    expect(parseBatchUrls('example.com/pricing').urls).toEqual(['https://example.com/pricing'])
  })

  it('keeps http as typed rather than upgrading it', () => {
    expect(parseBatchUrls('http://example.com').urls).toEqual(['http://example.com/'])
  })

  /* The same page twice only ever produces the same file twice. */
  it('drops duplicates after normalising', () => {
    expect(parseBatchUrls('example.com\nhttps://example.com/\nEXAMPLE.com').urls).toEqual(['https://example.com/'])
  })

  /* A batch that silently skipped part of the list would look as if it had captured everything. */
  it('reports what it could not use instead of dropping it', () => {
    const { urls, rejected } = parseBatchUrls('notes\nftp://files.example/a\nchrome://settings\nexample.org')
    expect(urls).toEqual(['https://example.org/'])
    expect(rejected.map((entry) => entry.line)).toEqual(['notes', 'ftp://files.example/a', 'chrome://settings'])
  })

  it('accepts localhost, the one dotless host anyone means on purpose', () => {
    expect(parseBatchUrls('localhost:8080/page').urls).toEqual(['https://localhost:8080/page'])
  })
})

describe('siteCount', () => {
  it('counts hosts, not pages', () => {
    expect(siteCount(['https://a.example/1', 'https://a.example/2', 'https://b.example/'])).toBe(2)
  })
})

describe('batchFilename', () => {
  it('numbers files in list order, padded so 9 sorts before 10', () => {
    expect(batchFilename(9, 12, 'page.png')).toBe('09-page.png')
    expect(batchFilename(10, 12, 'page.png')).toBe('10-page.png')
    expect(batchFilename(3, 5, 'page.pdf')).toBe('3-page.pdf')
  })
})

describe('batch folders', () => {
  it('names the subfolder for the minute the batch started, in local time', () => {
    expect(batchFolderName(new Date(2026, 9, 19, 14, 5, 33))).toBe('pageshotter-batch-2026-10-19-1405')
  })

  it('nests the subfolder inside the save folder, and either may be absent', () => {
    expect(batchFolder('shots', 'pageshotter-batch-x')).toBe('shots/pageshotter-batch-x')
    expect(batchFolder('', 'pageshotter-batch-x')).toBe('pageshotter-batch-x')
    expect(batchFolder('shots', undefined)).toBe('shots')
    expect(batchFolder('', undefined)).toBe('')
  })
})

describe('readBatchOptions', () => {
  it('falls back to the defaults for anything missing or unrecognised', () => {
    expect(readBatchOptions(undefined)).toEqual(DEFAULT_BATCH_OPTIONS)
    expect(readBatchOptions({ mode: 'region', loadTimeoutMs: 12_345, renderWaitMs: -1, format: 'gif' })).toEqual(
      DEFAULT_BATCH_OPTIONS,
    )
  })

  it('keeps every offered value', () => {
    const stored = { mode: 'visible', format: 'pdf', loadTimeoutMs: 0, renderWaitMs: 60_000, subfolder: false, showFolder: false }
    expect(readBatchOptions(stored)).toEqual(stored)
  })

  /* Unset, so the batch follows the Settings file type until someone picks one here. */
  it('has no format of its own by default', () => {
    expect(DEFAULT_BATCH_OPTIONS.format).toBeUndefined()
  })
})
