import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_PREFERENCES,
  DEFAULT_JPEG_QUALITY,
  PDF_PAGE_SIZES,
  readPdfOptions,
} from '../src/result/export-preferences'
import { DEFAULT_EXPORT_FORMAT, DEFAULT_EXPORT_SCALE } from '../src/result/export-options'
import { DEFAULT_PDF_OPTIONS } from '../src/result/pdf-layout'

describe('export preference defaults', () => {
  it('reuses the export and PDF modules as its source of truth', () => {
    expect(DEFAULT_EXPORT_PREFERENCES).toEqual({
      format: DEFAULT_EXPORT_FORMAT,
      jpegQuality: DEFAULT_JPEG_QUALITY,
      scale: DEFAULT_EXPORT_SCALE,
      pdf: DEFAULT_PDF_OPTIONS,
    })
  })

  it('offers every supported PDF page size', () => {
    expect(PDF_PAGE_SIZES).toEqual(['fit', 'a4', 'letter', 'legal'])
  })
})

describe('stored PDF preferences', () => {
  it('reads each valid choice independently', () => {
    expect(readPdfOptions({
      splitToPages: false,
      pageSize: 'letter',
      directLinks: true,
      textSearchable: true,
    })).toEqual({
      splitToPages: false,
      pageSize: 'letter',
      directLinks: true,
      textSearchable: true,
    })
  })

  it('repairs invalid fields from the factory defaults', () => {
    expect(readPdfOptions({
      splitToPages: 'yes',
      pageSize: 'screen',
      directLinks: 1,
      textSearchable: null,
    })).toEqual(DEFAULT_PDF_OPTIONS)
  })
})
