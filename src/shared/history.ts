import type { PixelRect } from './region-geometry'

/**
 * A capture kept after its result tab has assembled it.
 *
 * History stores the *assembled tiles*, not the raw segments the capture loop produced. Segments are
 * viewport screenshots with overlaps that only mean anything alongside their scroll metrics; the
 * tiles are the finished image. Keeping tiles means reopening a capture is a read and a draw rather
 * than a re-stitch, and it means a stitching change can never retroactively alter a screenshot
 * someone already saw.
 */
export interface HistoryEntry {
  /** The capture's job id, reused so `result.html?job=<id>` addresses both the live job and the copy. */
  id: string
  createdAt: number
  title: string
  /** The page the capture came from. Shown in the list so one screenshot can be told from another. */
  url?: string
  width: number
  height: number
  scaleX: number
  scaleY: number
  segmentCount: number
  tileCount: number
  /** Total bytes of the tiles, which is what the retention budget is spent on. */
  bytes: number
  /** A small PNG for the list, so it never has to decode a full-size tile per row. */
  thumbnail?: Blob
  regionCrop?: PixelRect
  /**
   * The page's own words, deduplicated and lowercased, so history can be searched by what a
   * screenshot *says* and not only by the title its tab happened to carry. The runs themselves live
   * in their own store: this is a few kilobytes, they are megabytes.
   */
  searchText?: string
  pageContentError?: string
  imageOrigin?: { x: number; y: number }
  /** Image pixels per document CSS pixel, for the PDF layers. See `CaptureJob.imageScale`. */
  imageScale?: { x: number; y: number }
}

export interface HistoryTile {
  /** `${entryId}:${index}`, so tiles are addressable without a second index lookup. */
  id: string
  entryId: string
  index: number
  offsetY: number
  width: number
  height: number
  blob: Blob
}

/** The largest edge of a list thumbnail, in image pixels. */
export const HISTORY_THUMBNAIL_PX = 320
