import { getSetting, putSetting } from '../shared/capture-db'
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_SCALE,
  clampJpegQuality,
  readExportFormat,
  readExportScale,
  type ExportFormat,
} from './export-options'
import { DEFAULT_PDF_OPTIONS, type PdfOptions, type PdfPageSizeName } from './pdf-layout'
import { JPEG_QUALITY } from './stitcher'

const PDF_KEY = 'pdfOptions'
const FORMAT_KEY = 'exportFormat'
const JPEG_QUALITY_KEY = 'jpegQuality'
const SCALE_KEY = 'exportScale'

export const DEFAULT_JPEG_QUALITY = Math.round(JPEG_QUALITY * 100)

export interface ExportPreferences {
  format: ExportFormat
  jpegQuality: number
  scale: number
  pdf: PdfOptions
}

export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
  format: DEFAULT_EXPORT_FORMAT,
  jpegQuality: DEFAULT_JPEG_QUALITY,
  scale: DEFAULT_EXPORT_SCALE,
  pdf: { ...DEFAULT_PDF_OPTIONS },
}

export const PDF_PAGE_SIZES: readonly PdfPageSizeName[] = ['fit', 'a4', 'letter', 'legal']

export function readPdfOptions(stored: unknown): PdfOptions {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Partial<PdfOptions>) : {}
  return {
    splitToPages:
      typeof raw.splitToPages === 'boolean' ? raw.splitToPages : DEFAULT_PDF_OPTIONS.splitToPages,
    pageSize: PDF_PAGE_SIZES.includes(raw.pageSize as PdfPageSizeName)
      ? (raw.pageSize as PdfPageSizeName)
      : DEFAULT_PDF_OPTIONS.pageSize,
    directLinks: typeof raw.directLinks === 'boolean' ? raw.directLinks : DEFAULT_PDF_OPTIONS.directLinks,
    textSearchable:
      typeof raw.textSearchable === 'boolean' ? raw.textSearchable : DEFAULT_PDF_OPTIONS.textSearchable,
  }
}

export async function getExportPreferences(): Promise<ExportPreferences> {
  const [pdf, format, quality, scale] = await Promise.all([
    getSetting<unknown>(PDF_KEY).catch(() => undefined),
    getSetting<unknown>(FORMAT_KEY).catch(() => undefined),
    getSetting<unknown>(JPEG_QUALITY_KEY).catch(() => undefined),
    getSetting<unknown>(SCALE_KEY).catch(() => undefined),
  ])
  return {
    format: readExportFormat(format),
    jpegQuality: clampJpegQuality(quality, DEFAULT_JPEG_QUALITY),
    scale: readExportScale(scale),
    pdf: readPdfOptions(pdf),
  }
}

export async function setExportFormat(format: ExportFormat): Promise<void> {
  await putSetting(FORMAT_KEY, readExportFormat(format))
}

export async function setJpegQuality(quality: number): Promise<void> {
  await putSetting(JPEG_QUALITY_KEY, clampJpegQuality(quality, DEFAULT_JPEG_QUALITY))
}

export async function setExportScale(scale: number): Promise<void> {
  await putSetting(SCALE_KEY, readExportScale(scale))
}

export async function setPdfOptions(options: PdfOptions): Promise<void> {
  await putSetting(PDF_KEY, readPdfOptions(options))
}

export async function setExportPreferences(preferences: ExportPreferences): Promise<void> {
  await Promise.all([
    setExportFormat(preferences.format),
    setJpegQuality(preferences.jpegQuality),
    setExportScale(preferences.scale),
    setPdfOptions(preferences.pdf),
  ])
}
