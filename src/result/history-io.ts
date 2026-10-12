import { getHistoryTiles, replaceHistoryEntry } from '../shared/capture-db'
import { HISTORY_THUMBNAIL_PX, type HistoryEntry, type HistoryTile } from '../shared/history'
import { expiredHistoryIds, fitsHistoryBudget } from '../shared/history-policy'
import { getHistorySettings, limitsFor } from '../shared/history-settings'
import type { CaptureJob } from '../shared/messages'
import { searchableText } from '../shared/page-content'
import type { TiledImage } from './stitcher'

/**
 * Keeps a finished capture so it can be reopened.
 *
 * Every caller treats this as best-effort. A capture that cannot be *kept* is still a capture the
 * user is looking at: the tiles are already on screen and every export reads them from memory, so
 * failing the write must never fail the screenshot. What it must not do is fail silently, hence the
 * thrown error the result page turns into a notice.
 */
export async function saveCaptureToHistory(job: CaptureJob, image: TiledImage): Promise<boolean> {
  const settings = await getHistorySettings()
  const bytes = image.tiles.reduce((total, tile) => total + tile.blob.size, 0)
  const limits = limitsFor(settings)
  if (!fitsHistoryBudget(bytes, limits)) return false

  // The thumbnail and tile records are prepared before the database is touched: a transaction
  // commits itself the moment it is left waiting on anything that is not one of its own requests.
  const now = Date.now()
  const entry: HistoryEntry = {
    id: job.id,
    createdAt: job.createdAt,
    title: job.title,
    url: job.url,
    width: image.width,
    height: image.height,
    scaleX: image.scaleX,
    scaleY: image.scaleY,
    segmentCount: job.segmentCount,
    tileCount: image.tiles.length,
    bytes,
    thumbnail: await buildThumbnail(image),
    regionCrop: job.regionCrop,
    searchText: job.pageContent ? searchableText(job.pageContent) : undefined,
    pageContentError: job.pageContentError,
    imageOrigin: job.imageOrigin,
    imageScale: job.imageScale,
  }
  const tiles: HistoryTile[] = image.tiles.map((tile, index) => ({
    id: `${job.id}:${index}`,
    entryId: job.id,
    index,
    offsetY: tile.offsetY,
    width: tile.width,
    height: tile.height,
    blob: tile.blob,
  }))
  // Evictions are decided inside the write's own transaction, against whatever is stored at that
  // moment, with the incoming capture counted as though it were already there. Pruning against the
  // existing entries alone would let every save overshoot the budget by one capture -- the one being
  // written when storage was already nearly full. Evicting in the same transaction means a write
  // that fails, realistically on the disk quota, evicts nothing.
  await replaceHistoryEntry(entry, tiles, job.pageContent, (current) =>
    expiredHistoryIds(
      [
        { id: job.id, createdAt: now, bytes },
        ...current.map((stored) => ({ id: stored.id, createdAt: stored.createdAt, bytes: stored.bytes })),
      ],
      now,
      limits,
    ).filter((id) => id !== job.id),
  )
  return true
}

/** Rebuilds the exact image that was stored, so exports behave identically to the original tab. */
export async function restoreTiledImage(entry: HistoryEntry): Promise<TiledImage> {
  const tiles = await getHistoryTiles(entry.id)
  return {
    width: entry.width,
    height: entry.height,
    scaleX: entry.scaleX,
    scaleY: entry.scaleY,
    tiles: tiles.map((tile) => ({
      offsetY: tile.offsetY,
      width: tile.width,
      height: tile.height,
      blob: tile.blob,
    })),
  }
}

/**
 * A small PNG of the top of the capture, for the list.
 *
 * The top rather than the whole thing, because a full-page capture scaled into a list row is an
 * illegible grey smear, while its first screenful is the part someone actually recognises. A region
 * capture is cropped to its region first, since the surrounding page is not what was captured.
 *
 * Returns `undefined` rather than throwing: a missing thumbnail costs a placeholder in one row,
 * which is not worth losing the capture over.
 */
async function buildThumbnail(image: TiledImage): Promise<Blob | undefined> {
  const first = image.tiles[0]
  if (!first) return undefined
  try {
    const source = await createImageBitmap(first.blob)
    const sourceHeight = Math.min(source.height, Math.round(source.width * 0.75))
    const scale = Math.min(1, HISTORY_THUMBNAIL_PX / source.width)
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(source.width * scale)),
      Math.max(1, Math.round(sourceHeight * scale)),
    )
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return undefined
    context.drawImage(source, 0, 0, source.width, sourceHeight, 0, 0, canvas.width, canvas.height)
    source.close()
    return await canvas.convertToBlob({ type: 'image/png' })
  } catch {
    return undefined
  }
}
