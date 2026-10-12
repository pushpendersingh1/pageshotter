/**
 * Accumulates page content across the capture's scroll positions.
 *
 * Harvesting once, after the scroll loop, is right for a page that *adds* content as it is scrolled
 * -- which is why it was written that way -- but it is defeated by an application that also
 * *removes* what has scrolled away. On such a page a message is mounted, photographed, and unmounted
 * again before the harvest runs: the picture has it and the DOM never does, so the PDF shows text
 * nobody can select. A chat transcript showed exactly this, where whole messages came
 * out unselectable while the words around them were fine.
 *
 * So the harvest runs at every position the capture stops at, and the passes are merged here. A
 * static page contributes the same words at every pass, which is what the deduplication is for; a
 * virtualised one contributes each message at the one pass where it existed.
 *
 * Everything is pure: no DOM, no timers. The content script measures, this decides what is kept.
 */

import {
  MAX_CAPTURED_LINKS,
  MAX_CAPTURED_RUNS,
  type CapturedLink,
  type CapturedTextRun,
  type ContentRect,
  type PageContent,
} from './page-content'

/**
 * How far apart two measurements of the same word may sit and still be the same word.
 *
 * A page re-measured after a scroll does not always report identical coordinates: the scroll offset
 * itself can land on a fractional pixel, and a subpixel-positioned glyph moves with it. Without a
 * tolerance those near-misses survive as separate runs, and duplicated invisible glyphs are worse
 * than a missing one -- selecting the line copies "hellohello".
 */
export const HARVEST_TOLERANCE_PX = 3

/**
 * Buckets are looked up with their eight neighbours, so the grid only has to be at least as coarse
 * as the tolerance for every near-miss to be found. Coarser than that costs comparisons; finer would
 * let a pair straddling two buckets escape.
 */
export const HARVEST_GRID_PX = 8

/** How far a pass's rects must be moved to land in the space the first pass established. */
export interface HarvestShift {
  x: number
  y: number
}

const NO_SHIFT: HarvestShift = { x: 0, y: 0 }

/**
 * The shift that puts a later pass in the first pass's image space.
 *
 * Harvested rects are the content offset plus the viewport position; the capture's own origin is
 * subtracted later, once, by the worker. That origin is read from one geometry, so passes measured
 * against a different one -- a scroller whose top edge moved when a header collapsed, say -- have to
 * be brought back to the first one's before they are stored, or half the text layer is displaced by
 * however far the edge travelled.
 */
export function harvestShift(base: { x: number; y: number }, pass: { x: number; y: number }): HarvestShift {
  return { x: base.x - pass.x, y: base.y - pass.y }
}

export class ContentHarvest {
  private readonly runs: CapturedTextRun[] = []
  private readonly runBuckets = new Map<string, CapturedTextRun[]>()
  private readonly links: CapturedLink[] = []
  private readonly linkKeys = new Set<string>()

  /**
   * Merges one pass into the accumulated content, in the order the passes arrive.
   *
   * Insertion order is the reading order, and it is left alone deliberately. Within a pass it is DOM
   * order, which keeps side-by-side columns readable; between passes it is top to bottom, because
   * the capture loop descends the page. Sorting the result by coordinate would fix nothing and would
   * shuffle a two-column layout into alternating fragments.
   */
  absorb(content: PageContent, shift: HarvestShift = NO_SHIFT): void {
    for (const run of content.runs) {
      if (this.runs.length >= MAX_CAPTURED_RUNS) break
      const moved = shiftRect(run, shift)
      if (this.hasRun(run.text, moved)) continue
      const stored: CapturedTextRun = { ...moved, text: run.text }
      this.runs.push(stored)
      bucket(this.runBuckets, bucketKey(run.text, stored.x, stored.y)).push(stored)
    }

    for (const link of content.links) {
      if (this.links.length >= MAX_CAPTURED_LINKS) break
      const rects = link.rects.map((rect) => shiftRect(rect, shift))
      const key = linkKey(link.href, rects)
      if (this.linkKeys.has(key)) continue
      this.linkKeys.add(key)
      this.links.push({ href: link.href, rects })
    }
  }

  /** True once anything has been absorbed, so the caller can tell an empty page from an unrun one. */
  get isEmpty(): boolean {
    return this.runs.length === 0 && this.links.length === 0
  }

  result(): PageContent {
    return { links: this.links, runs: this.runs }
  }

  private hasRun(text: string, rect: ContentRect): boolean {
    const column = Math.floor(rect.x / HARVEST_GRID_PX)
    const row = Math.floor(rect.y / HARVEST_GRID_PX)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const near = this.runBuckets.get(`${text}@${column + dx},${row + dy}`)
        if (!near) continue
        for (const run of near) {
          if (
            Math.abs(run.x - rect.x) <= HARVEST_TOLERANCE_PX &&
            Math.abs(run.y - rect.y) <= HARVEST_TOLERANCE_PX
          ) {
            return true
          }
        }
      }
    }
    return false
  }
}

function shiftRect<T extends ContentRect>(rect: T, shift: HarvestShift): ContentRect {
  return { x: rect.x + shift.x, y: rect.y + shift.y, width: rect.width, height: rect.height }
}

function bucketKey(text: string, x: number, y: number): string {
  return `${text}@${Math.floor(x / HARVEST_GRID_PX)},${Math.floor(y / HARVEST_GRID_PX)}`
}

function bucket(map: Map<string, CapturedTextRun[]>, key: string): CapturedTextRun[] {
  const existing = map.get(key)
  if (existing) return existing
  const created: CapturedTextRun[] = []
  map.set(key, created)
  return created
}

/**
 * A link is the same link when it points at the same place from the same boxes. Rects are rounded
 * first for the same reason runs have a tolerance: the same anchor re-measured after a scroll can
 * report a coordinate a fraction of a pixel away, and two identical clickable boxes stacked on each
 * other are pure weight in the PDF.
 */
function linkKey(href: string, rects: ContentRect[]): string {
  const boxes = rects
    .map((rect) => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`)
    .join(' ')
  return `${href}|${boxes}`
}
