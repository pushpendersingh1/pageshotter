import type { Degradations } from './capture-degradation'
import type { PageContent } from './page-content'
import type { PixelRect, ScrollOffset, SelectedRegion } from './region-geometry'

export type CaptureMode = 'full' | 'visible' | 'region'
export type CaptureStatus = 'capturing' | 'complete' | 'failed' | 'cancelled'

export interface CaptureProgress {
  current: number
  estimatedTotal: number
}

export interface CaptureError {
  code: string
  message: string
}

export interface CaptureJob {
  id: string
  mode: CaptureMode
  status: CaptureStatus
  title: string
  /**
   * The page the capture came from, recorded only so history can tell one screenshot from another.
   * It never leaves the device, and it is discarded with the rest of the entry when history is off
   * or the retention period passes.
   */
  url?: string
  sourceTabId: number
  sourceWindowId: number
  createdAt: number
  updatedAt: number
  progress: CaptureProgress
  segmentCount: number
  /** Height actually assembled, in CSS pixels; capped at Chrome's canvas limit. */
  finalDocumentHeight?: number
  /** Full page height, in CSS pixels, when it exceeded what one image can hold. */
  fullDocumentHeight?: number
  truncated?: boolean
  /** The user stopped the capture, so the sections already taken were assembled instead of discarded. */
  stoppedEarly?: boolean
  restrictedPageFallback?: boolean
  /**
   * The page outgrew what the long-page setting allows, so capture stopped rather than chasing
   * content generated as fast as it is scrolled. Distinct from `truncated`: that one means the page
   * is genuinely deeper than one run reaches, this one means it was still being written.
   */
  endlessPage?: boolean
  /** Capture used its whole time budget. Distinct from `endlessPage`: this page was slow, not endless. */
  deadlineReached?: boolean
  /** The page grew during the last section. Only the progress UI reads this; it is not an outcome. */
  growingPage?: boolean
  /**
   * What the capture could not do, having finished anyway.
   *
   * Every flag above says why a capture **stopped**. This one says it did not stop, and the picture
   * is still not what the page looks like -- which the user has no other way of telling apart from
   * a page that genuinely looks like that.
   */
  degradations?: Degradations
  /**
   * The page was a local file and "Allow access to file URLs" is off, so only the visible area could
   * be taken. Distinct from `restrictedPageFallback` because the user can fix this one and cannot
   * fix that one -- the two produce the same picture and must not produce the same sentence.
   */
  fileAccessFallback?: boolean
  /**
   * The region the user selected on the page, already converted to image pixels. The result page
   * opens with this applied as its crop, so region select and Crop are one mechanism rather than two
   * — and **Clear crop** still reveals the whole page, because the capture itself is unabridged.
   */
  regionCrop?: PixelRect
  /**
   * Links and text measured on the page, in document CSS pixels, for the PDF's optional clickable
   * and searchable layers. Harvested for every mode that can reach the page, the visible-area one
   * included -- it is injected after its screenshot, so collecting cannot alter the image.
   */
  pageContent?: PageContent
  /**
   * Why the page could not be read, when it could not. Recorded rather than inferred: the first
   * version of this guessed a reason from the absence of content, and reported a bug in our
   * own collection as a limitation of the capture mode.
   */
  pageContentError?: string
  /** Document position of image pixel (0, 0) — non-zero only for a band-captured region. */
  imageOrigin?: { x: number; y: number }
  /**
   * Image pixels per document CSS pixel — the scale the PDF layers place text and links by.
   *
   * Deliberately **not** the assembled image's `scaleX`/`scaleY`, which describe how the image
   * relates to the segments it was stitched from. For a full-page capture the two agree. For a
   * visible-area or on-screen-region capture they do not: that path records the screenshot's own
   * pixel size as the segment's viewport, so its image scale is 1 whatever the device pixel ratio
   * is. Placing CSS-pixel rectangles by that 1 put every word at half position and half size on a
   * Retina screen, and clipped them out of a region crop entirely.
   */
  imageScale?: { x: number; y: number }
  error?: CaptureError
}

/**
 * Geometry for one capture step. `scrollY` is the content offset of the pixel at the top of the
 * capture rect, and `documentHeight` is the capturable content height. Both are measured against
 * the document when the document scrolls, and against the nested scroll container otherwise.
 * `viewportWidth`/`viewportHeight` always describe the real viewport, because the screenshot scale
 * is derived from them. `captureX`/`captureY`/`captureWidth`/`captureHeight` are the CSS-pixel
 * region of that viewport which actually shows scrolled content.
 */
export interface CaptureMetrics {
  scrollX: number
  scrollY: number
  viewportWidth: number
  viewportHeight: number
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
  documentHeight: number
  documentWidth: number
  overlayIds: number[]
}

export interface StoredSegment extends CaptureMetrics {
  id: string
  jobId: string
  index: number
  blob: Blob
  imageWidth: number
  imageHeight: number
}

export type RuntimeRequest =
  | { type: 'START_CAPTURE'; mode: CaptureMode }
  | { type: 'CANCEL_CAPTURE'; jobId: string }
  | { type: 'GET_JOB'; jobId: string }
  /**
   * Sent by the result page once an auto-download has saved the file. The page cannot close its own
   * tab -- `window.close()` does not apply to one the page did not open -- so the worker, which
   * opened it, closes it.
   */
  | { type: 'CLOSE_RESULT_TAB' }
  /**
   * One page of a batch, in a tab the batch page opened and loaded. The worker captures it and
   * opens nothing; the batch page polls `GET_JOB` and saves the result itself.
   */
  | { type: 'START_BATCH_CAPTURE'; tabId: number; mode: 'full' | 'visible' }
  /** Where a batch has got to, for the toolbar icon; `done` of `total` pages finished. */
  | { type: 'BATCH_PROGRESS'; done: number; total: number }
  /** The batch ended, however it ended: the toolbar icon goes back to normal. */
  | { type: 'BATCH_FINISHED' }

export type RuntimeResponse =
  | { ok: true; jobId?: string; job?: CaptureJob }
  | { ok: false; error: CaptureError }

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'SELECT_REGION' }
  | { type: 'CANCEL_REGION' }
  /**
   * `jobId` rides along so the page can stop its own capture. Escape is handled in the content
   * script, which is the only place a keystroke can be heard once the popup has closed — and a
   * capture started by the keyboard shortcut has no popup at all.
   */
  /**
   * `sectionWaitMs` is the user's floor under each section's wait, and `imageWaitMs` the ceiling on
   * how long a section may wait for its visible images. Both are sent once, at prepare, because
   * neither can change during a capture -- carrying them on every position message would invite
   * exactly that.
   */
  | { type: 'PREPARE_CAPTURE'; jobId: string; sectionWaitMs?: number; imageWaitMs?: number }
  | { type: 'COLLECT_PAGE_CONTENT' }
  /**
   * `depthLimit` is how deep this capture will actually go, which is not always the bottom of the
   * document: a page held to the long-page allowance stops short of it. The page needs the number to
   * know which section is its *last*, because the last one is the only one that waits for lazily
   * loaded sources to arrive.
   */
  | { type: 'CAPTURE_POSITION'; scrollY: number; seenOverlayIds: number[]; depthLimit?: number }
  | { type: 'HEARTBEAT_CAPTURE' }
  /** Whether the page is being drawn, asked while a capture waits for it to be on screen again. */
  | { type: 'PAGE_VISIBLE' }
  | { type: 'CLEANUP_CAPTURE' }

export type ContentResponse =
  | {
      ok: true
      metrics?: CaptureMetrics
      region?: SelectedRegion | null
      /** Document scroll when the selection ended, so a region still on screen skips the scroll loop. */
      scroll?: ScrollOffset
      /** False when the document itself cannot scroll, e.g. a page whose real scroller is nested. */
      documentScrolls?: boolean
      /**
       * The live CSS viewport. A visible-area capture photographs the whole viewport and reports
       * only image pixels, so this is the only way to recover the capture scale (DPR × browser
       * zoom) — both to place a dragged region on the image, and to place the PDF layers, which
       * are measured in the page's own coordinates and have to be put somewhere in the image's.
       */
      viewport?: { width: number; height: number }
      /**
       * `location.href`, read in the page itself. `tabs.Tab.url` is only populated when the
       * extension holds a matching permission, which for `activeTab` depends on the grant being
       * live at the moment the tab is queried — so it is not a source history can rely on. The page
       * always knows its own address, and reading it at prepare time also survives a redirect
       * between the click and the capture.
       */
      pageUrl?: string
      /**
       * Where the image's own (0, 0) sits, in the same CSS-pixel space the harvested rects are in,
       * so the PDF writer can subtract it. Reported by the page rather than derived by the worker
       * because only the page knows which element was scrolled: on a nested scroller the image
       * starts at the container's padding box, not at the window's top-left.
       */
      captureOrigin?: ScrollOffset
      /** Links and text for the PDF layers, harvested after the scroll loop. */
      pageContent?: PageContent
      /**
       * What this capture could not do, so far. Sent on the response rather than folded into
       * `CaptureMetrics`, because metrics are what a `StoredSegment` is built from and this would
       * then be written to IndexedDB once per section -- a new kind of stored record, for a number
       * nothing reads back.
       */
      degradations?: Degradations
      /** Answer to PAGE_VISIBLE. */
      visible?: boolean
      /**
       * How long the page was hidden while serving this request. Time spent paused is not time the
       * page took, so the capture's deadline leaves it out.
       */
      hiddenMs?: number
    }
  | { ok: false; error: CaptureError }
