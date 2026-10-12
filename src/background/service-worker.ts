import { addDegradations } from '../shared/capture-degradation'
import { CaptureOwnership } from './capture-ownership'
import { failureOutcome } from './capture-outcome'
import {
  deleteExpiredCaptures,
  deleteSegments,
  getJob,
  getJobs,
  getSegments,
  putJob,
  putSegment,
} from '../shared/capture-db'
import {
  CAPTURE_LIMITS,
  estimatedSegmentCount,
  nextScrollY,
  sectionLimitCssHeight,
} from '../shared/capture-plan'
import {
  deadlineReached,
  depthAllowance,
  getLongPagePolicy,
  outgrewAllowance,
} from '../shared/capture-depth'
import { getImageWaitMs, getSectionWaitMs } from '../shared/capture-wait'
import { clearDownloadFolderRevokedBefore, getAutoDownload, getDownloadFolder } from '../shared/history-settings'
import { canSaveUnattended } from '../shared/auto-download'
import { putReviewInstalledAt, recordCaptureFailed } from '../shared/review-prompt'
import { pruneHistory } from '../shared/history-prune'
import { CAPTURE_RETRY_POLICY, captureRetryDelayMs, isCaptureQuotaError } from '../shared/capture-retry'
import {
  captureError,
  fileAccessMessage,
  isFileUrl,
  PageShotterError,
  visibleAreaFallbackAvailable,
} from '../shared/errors'
import {
  regionFitsViewport,
  regionToImageCrop,
  regionToViewport,
  type SelectedRegion,
} from '../shared/region-geometry'
import type { PageContent } from '../shared/page-content'
import type { ScrollOffset } from '../shared/region-geometry'
import type {
  CaptureJob,
  CaptureMode,
  ContentRequest,
  ContentResponse,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/messages'

const cancelledJobs = new Set<string>()
/** One capture owns one tab at a time; the reservation exists before the first await. */
const ownership = new CaptureOwnership()
let lastCaptureAt = 0
const tabActivationGeneration = new Map<number, number>()
let captureQueue: Promise<unknown> = Promise.resolve()

const startup = initializeServiceWorker()

chrome.tabs.onActivated.addListener(({ windowId }) => {
  tabActivationGeneration.set(windowId, (tabActivationGeneration.get(windowId) ?? 0) + 1)
})

chrome.permissions.onRemoved.addListener((removed) => {
  if (removed.permissions?.includes('downloads')) {
    void clearDownloadFolderRevokedBefore(Date.now()).catch(() => undefined)
  }
})

chrome.runtime.onMessage.addListener(
  (request: RuntimeRequest, sender, sendResponse: (response: RuntimeResponse) => void) => {
    void handleRuntimeRequest(request, sender).then(sendResponse)
    return true
  },
)

/**
 * The welcome page, opened once and only on a fresh install.
 *
 * `reason` is checked rather than assumed: `onInstalled` also fires on every update and on a Chrome
 * version change, and an extension that opens a tab each time it updates itself is the single most
 * complained-about behaviour in the category. There is a real reason to show it once -- this is a
 * screenshot tool whose whole claim is that nothing leaves the machine, and a claim needs somewhere
 * it can be explained rather than asserted in a footer.
 *
 * Neither `onInstalled` nor `tabs.create` requires a permission, so the permission list is unchanged.
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return
  // The review ask counts from this day; an update must not reset it.
  void putReviewInstalledAt(Date.now()).catch(() => undefined)
  void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
})

/**
 * `capture-visible-area` ships with no `suggested_key`: Chrome allows only four suggested bindings,
 * and more importantly an unrequested second default is a combination taken from every other
 * extension the user has. It appears unbound on chrome://extensions/shortcuts for anyone who wants it.
 */
const COMMAND_MODES: Record<string, CaptureMode> = {
  'capture-full-page': 'full',
  'capture-visible-area': 'visible',
}

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = COMMAND_MODES[command]
  if (mode === undefined || tab?.id === undefined) return
  // The popup reports its own failures, but a keyboard shortcut has no surface of its own: without
  // this the whole extension looks dead when a capture refuses to start.
  void startup
    .then(() => createCapture(mode, tab))
    .catch((error: unknown) => reportCommandFailure(error, tab, mode))
})

/**
 * Shows a shortcut-triggered failure the only way a shortcut can: by opening the result page with a
 * failed job, exactly as an interrupted capture does.
 */
async function reportCommandFailure(
  error: unknown,
  tab: chrome.tabs.Tab,
  mode: CaptureMode,
): Promise<void> {
  try {
    const failure = captureError(error)
    const job: CaptureJob = {
      id: crypto.randomUUID(),
      mode,
      status: 'failed',
      error: failure,
      title: tab.title || 'PageShotter capture',
      sourceTabId: tab.id as number,
      sourceWindowId: tab.windowId as number,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: { current: 0, estimatedTotal: 1 },
      segmentCount: 0,
    }
    await putJob(job)
    await openResultTabInFront(job.id, tab.windowId)
    void recordCaptureFailed()
  } catch {
    // Reporting the failure must never itself become an unhandled rejection.
  }
}

/**
 * Opens the result page and brings it to the front.
 *
 * Two things this has to survive, both found in incognito.
 *
 * The extension is in Chrome's default **spanning** incognito mode, and Chrome will not put an
 * extension page in an incognito window in that mode. So handing `tabs.create` the source window's
 * id is at best pointless and at worst fatal: the page lands in some other window, or the call
 * rejects outright — which, from inside the capture's own try block, turned a finished screenshot
 * into "Capture couldn't finish".
 *
 * And creating a tab in a window does not focus that window. Sitting in incognito with the result
 * quietly opened in a normal window behind it is exactly what "it did not navigate" was.
 *
 * Never throws. Delivery is not capture: the screenshot is already stored and already in history by
 * the time this runs, and failing to show it must not be reported as failing to take it.
 */
async function openResultTab(jobId: string, windowId?: number): Promise<void> {
  /*
   * With auto-download on, the page still opens -- it is the only place that can assemble and save
   * the image. `URL.createObjectURL` does not exist in an MV3 service worker and neither does a DOM
   * to click an anchor with, so a worker-side download is not available at any price short of the
   * `offscreen` permission. What the setting can honestly promise is that the tab does not take
   * focus and does not survive the save: it opens behind, saves, and asks to be closed.
   */
  const background = await canSaveUnattendedNow()
  const url = chrome.runtime.getURL(`result.html?job=${encodeURIComponent(jobId)}`)
  let tab: chrome.tabs.Tab | undefined
  if (windowId !== undefined) {
    // Preferred when it works: a normal-window capture puts its result beside the page it came from.
    tab = await chrome.tabs.create({ url, windowId, active: !background }).catch(() => undefined)
  }
  // Chrome picks a window it is allowed to use, which is the whole point of the fallback.
  tab ??= await chrome.tabs.create({ url, active: !background }).catch(() => undefined)
  if (background || tab?.windowId === undefined) return
  // `chrome.windows` needs no permission, so this does not touch the permission list.
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
}

/** The worker's half of the rule in `shared/auto-download.ts`; the result page asks the same question. */
async function canSaveUnattendedNow(): Promise<boolean> {
  try {
    const [on, folder, granted] = await Promise.all([
      getAutoDownload(),
      getDownloadFolder(),
      chrome.permissions.contains({ permissions: ['downloads'] }).catch(() => false),
    ])
    return canSaveUnattended(on, folder, granted)
  } catch {
    return false
  }
}

/**
 * A failure has to be read, so it is never delivered quietly.
 *
 * Auto-download answers "I already know I want the file"; it does not answer "tell me nothing when
 * the capture did not work". Every failure path therefore goes through here instead of the function
 * above, and lands in front of the user exactly as it did before the setting existed.
 */
async function openResultTabInFront(jobId: string, windowId?: number): Promise<void> {
  const url = chrome.runtime.getURL(`result.html?job=${encodeURIComponent(jobId)}`)
  let tab: chrome.tabs.Tab | undefined
  if (windowId !== undefined) {
    tab = await chrome.tabs.create({ url, windowId, active: true }).catch(() => undefined)
  }
  tab ??= await chrome.tabs.create({ url, active: true }).catch(() => undefined)
  if (tab?.windowId === undefined) return
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
}

async function handleRuntimeRequest(
  request: RuntimeRequest,
  sender?: chrome.runtime.MessageSender,
): Promise<RuntimeResponse> {
  try {
    await startup
    switch (request.type) {
      case 'START_CAPTURE': {
        const job = await createCapture(request.mode)
        return { ok: true, jobId: job.id }
      }
      case 'CANCEL_CAPTURE': {
        cancelledJobs.add(request.jobId)
        const job = await getJob(request.jobId)
        // A capture that is still running settles itself: `runCapture` keeps the sections it already
        // has and opens the result page. Only an orphaned job — one whose worker died mid-capture —
        // has to be closed out here, because nothing else is left to do it.
        const running = job !== undefined && ownership.owner(job.sourceTabId) === job.id
        if (job?.status === 'capturing' && !running) {
          job.status = 'cancelled'
          job.error = { code: 'CANCELLED', message: 'Capture cancelled. The page was restored.' }
          job.updatedAt = Date.now()
          await putJob(job)
          await sendContentMessage(job.sourceTabId, { type: 'CLEANUP_CAPTURE' }).catch(() => undefined)
          await deleteSegments(job.id)
        }
        return { ok: true }
      }
      case 'GET_JOB':
        return { ok: true, job: await getJob(request.jobId) }
      case 'CLOSE_RESULT_TAB': {
        // Only ever the sender's own tab. The id comes from Chrome rather than from the message, so
        // a page cannot ask for any other tab to be closed.
        const tabId = sender?.tab?.id
        if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined)
        return { ok: true }
      }
    }
  } catch (error) {
    return { ok: false, error: captureError(error) }
  }
}

async function createCapture(mode: CaptureMode, providedTab?: chrome.tabs.Tab): Promise<CaptureJob> {
  const tab = providedTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!tab?.id || tab.windowId === undefined) {
    throw new PageShotterError('NO_ACTIVE_TAB', 'No active Chrome tab was found.')
  }
  const tabId = tab.id

  const job: CaptureJob = {
    id: crypto.randomUUID(),
    mode,
    status: 'capturing',
    title: tab.title || 'PageShotter capture',
    url: tab.url,
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    progress: { current: 0, estimatedTotal: 1 },
    segmentCount: 0,
  }
  // Reserved before the first await: `putJob` yields, and a second request for the same tab
  // arriving inside that yield must be refused rather than served a second capture loop.
  if (!ownership.reserve(tabId, job.id)) {
    throw new PageShotterError('CAPTURE_IN_PROGRESS', 'A capture is already running on this tab.')
  }
  try {
    await putJob(job)
  } catch (error) {
    ownership.release(tabId, job.id)
    throw error
  }
  void runCapture(job, tab).finally(() => ownership.release(tabId, job.id))
  return job
}

async function runCapture(job: CaptureJob, tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id as number
  const windowId = tab.windowId
  let contentPrepared = false
  /**
   * Set only after the completion `putJob` resolves. An in-memory `status = 'complete'` proves
   * nothing about persistence, and using it as that proof once reported a finished capture as
   * silently vanished when the write itself was what failed.
   */
  let persistedComplete = false

  try {
    if (job.mode === 'region') {
      // Region select injects the content script and, for a band, prepares the page for scrolling.
      // Both must be torn down in `finally` whatever happens next; CLEANUP_CAPTURE also cancels a
      // selection still on screen, so sending it unconditionally is the safe order.
      contentPrepared = true
      await captureRegion(job, tabId, windowId)
    } else if (job.mode === 'visible') {
      await captureVisibleArea(job, tabId, windowId)
    } else {
      let useVisibleAreaFallback = false
      let fileAccessDenied = false
      try {
        await ensureContentScript(tabId)
      } catch (error) {
        const failure = captureError(error)
        /*
         * A local file is not a page Chrome forbids extensions on, but its refusal is worded like
         * one, so it used to be reported as one -- and the remedy that message implies is "give up",
         * when the real remedy is a toggle the user owns. The tab's own URL settles what kind of
         * page this is, and Chrome's own answer settles whether the toggle is off, so neither fact
         * is inferred from the error text.
         */
        fileAccessDenied = isFileUrl(tab.url) && !(await chrome.extension.isAllowedFileSchemeAccess())
        if (!fileAccessDenied && !visibleAreaFallbackAvailable(failure, job.mode)) {
          throw new PageShotterError(failure.code, failure.message)
        }
        useVisibleAreaFallback = true
      }

      if (useVisibleAreaFallback) {
        if (fileAccessDenied) job.fileAccessFallback = true
        else job.restrictedPageFallback = true
        /*
         * The fallback is still attempted rather than refused outright: a partial screenshot with a
         * true explanation beats an error, and whether Chrome permits even this much on a local file
         * is its decision, not a guess we should encode. If it refuses that too, the user gets the
         * same remedy in the failure instead of Chrome's raw text.
         */
        try {
          await captureVisibleArea(job, tabId, windowId)
        } catch (error) {
          if (!fileAccessDenied) throw error
          throw new PageShotterError('FILE_ACCESS_DENIED', fileAccessMessage(false))
        }
      } else {
        contentPrepared = true
        await captureFullPage(job, tabId, windowId)
      }
    }

    await throwIfCancelled(job.id)
    // Where document (0, 0) sits in the image, which the PDF layers subtract before placing anything.
    // A band capture works it out from its own origin; a full-page capture starts at the document's
    // top, offset only by the capture rect's left edge inside the viewport.
    const [firstSegment] = await getSegments(job.id)
    /*
     * `captureX` and `captureY` are already CSS pixels -- `CaptureMetrics` stores `ScrollGeometry`
     * verbatim -- and `imageScale` below is what converts CSS to image pixels. Dividing by the
     * device-pixel ratio here was wrong, and invisible on every page that scrolls its document,
     * because there `captureX` is 0. On a page whose real scroller is nested and inset from the
     * left, it displaced every link and every selectable word by `captureX × (1 - 1/DPR)`.
     *
     * `captureY` was not carried at all, which is the larger half of the same bug: a nested
     * scroller starting partway down the viewport put the whole text layer that far out.
     */
    if (job.imageOrigin === undefined) {
      job.imageOrigin = { x: firstSegment?.captureX ?? 0, y: firstSegment?.captureY ?? 0 }
    }
    // Harvested here, after the capture, for every mode that can reach the page.
    //
    // After rather than before, because lazy content only exists once it has been scrolled past, so
    // measuring earlier would give a PDF whose searchable text stops a screenful down. And for every
    // mode, not only the scrolling ones: a visible-area capture is a picture of a real page with
    // real links in it, and there is no reason its PDF should be the one that cannot offer them.
    // That path takes its screenshot before this runs, so injecting here cannot alter the image.
    const collected = await collectPageContent(tabId, contentPrepared)
    if (collected.error !== undefined) job.pageContentError = collected.error
    if (collected.pageContent) {
      job.pageContent = collected.pageContent
      // The scale the layers are placed by, measured against the live viewport rather than taken
      // from the assembled image. A visible-area capture stores its screenshot's pixel size as its
      // segment's viewport, so the image's own scale is 1 however many device pixels a CSS pixel is
      // worth -- which is why text and links were misplaced there and correct on a full page.
      if (firstSegment && collected.viewport && collected.viewport.width > 0 && collected.viewport.height > 0) {
        job.imageScale = {
          x: firstSegment.imageWidth / collected.viewport.width,
          y: firstSegment.imageHeight / collected.viewport.height,
        }
      }
      // A visible-area capture photographs the viewport, so image (0, 0) is wherever the page
      // happens to be scrolled to. Reading it from the page is the only way to know.
      if (job.mode === 'visible' && collected.scroll) {
        job.imageOrigin = {
          x: collected.scroll.x + (collected.captureOrigin?.x ?? 0),
          y: collected.scroll.y + (collected.captureOrigin?.y ?? 0),
        }
      } else if (collected.captureOrigin) {
        // The page reports the origin against the element it actually scrolled, which is the only
        // place that knows. The worker's guess from the first segment stands in when it cannot.
        job.imageOrigin = collected.captureOrigin
      }
    }
    job.status = 'complete'
    job.updatedAt = Date.now()
    await putJob(job)
    persistedComplete = true
    await throwIfCancelled(job.id)
    await openResultTab(job.id, windowId)
  } catch (error) {
    const failure = captureError(error)
    // A stored capture is never re-reported as a failure. Everything after a persisted completion
    // is delivery -- opening a tab, focusing a window -- and in incognito that is exactly where
    // things go wrong. Throwing the screenshot away at that point loses work that is already on
    // disk and already in history, and tells the user the opposite of what happened.
    switch (failureOutcome(failure.code, job.segmentCount, persistedComplete)) {
      case 'already-delivered':
        return
      case 'deliver-stopped':
        await deliverStoppedCapture(job, windowId).catch(() => undefined)
        return
      case 'mark-cancelled':
        job.status = 'cancelled'
        job.error = failure
        job.updatedAt = Date.now()
        // Storing the error record is best-effort when persistence is the thing that is failing;
        // reporting must not itself become an unhandled rejection.
        await putJob(job).catch(() => undefined)
        await deleteSegments(job.id).catch(() => undefined)
        return
      case 'mark-failed':
        job.status = 'failed'
        job.error = failure
        job.updatedAt = Date.now()
        await putJob(job).catch(() => undefined)
        await deleteSegments(job.id).catch(() => undefined)
        await openResultTabInFront(job.id, windowId)
        void recordCaptureFailed()
        return
    }
  } finally {
    cancelledJobs.delete(job.id)
    if (contentPrepared) {
      await sendContentMessage(tabId, { type: 'CLEANUP_CAPTURE' }).catch(() => undefined)
    }
  }
}

/**
 * Stopping is the only way to finish an endless page, so a stop keeps what has already been captured
 * instead of throwing it away. The assembled height is recomputed from the stored segments: the
 * running job records the height it *planned* to reach, and using that here would pad the screenshot
 * with blank space for every section that was never taken.
 */
async function deliverStoppedCapture(job: CaptureJob, windowId: number): Promise<void> {
  const segments = await getSegments(job.id)
  const covered = segments.reduce(
    (deepest, segment) => Math.max(deepest, segment.scrollY + segment.captureHeight),
    0,
  )
  job.status = 'complete'
  job.stoppedEarly = true
  job.finalDocumentHeight = covered
  // The page was not truncated by Chrome's canvas limit; it was stopped by the user, and the notice
  // for that says so on its own.
  job.truncated = false
  job.error = undefined
  job.updatedAt = Date.now()
  await putJob(job)
  await openResultTabInFront(job.id, windowId)
}

async function captureVisibleArea(job: CaptureJob, tabId: number, windowId: number): Promise<void> {
  await throwIfCancelled(job.id)
  const dataUrl = await captureActiveTab(job.id, tabId, windowId, false)
  const blob = await dataUrlToBlob(dataUrl)
  const dimensions = await imageDimensions(blob)
  await throwIfCancelled(job.id)
  await putSegment({
    id: `${job.id}:0`,
    jobId: job.id,
    index: 0,
    blob,
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
    scrollX: 0,
    scrollY: 0,
    viewportWidth: dimensions.width,
    viewportHeight: dimensions.height,
    captureX: 0,
    captureY: 0,
    captureWidth: dimensions.width,
    captureHeight: dimensions.height,
    documentWidth: dimensions.width,
    documentHeight: dimensions.height,
    overlayIds: [],
  })
  job.segmentCount = 1
  job.finalDocumentHeight = dimensions.height
  job.progress = { current: 1, estimatedTotal: 1 }
}

/**
 * Region capture: the user drags a region on the live page, then PageShotter photographs the visible
 * area and hands the result page that region as its crop.
 *
 * It is a visible-area capture plus a crop rather than a second capture pipeline, and that is the
 * whole design. A region is bounded by the viewport, so one screenshot always contains it — there is
 * no scrolling, so none of the scroll-loop machinery (overlay policy, background unpinning, lazy
 * settling, stitching) can affect the result, and every correctness property already verified for
 * those paths is untouched. It also returns immediately, which matters: making someone wait through
 * a 200-section capture to crop out a button would be absurd.
 *
 * The cost is the documented limitation: a region cannot extend past the current viewport. Selecting
 * across a scroll is a separate capability, not a tweak to this one.
 */
async function captureRegion(job: CaptureJob, tabId: number, windowId: number): Promise<void> {
  // Selecting a region means drawing on the page, so unlike a visible-area capture this cannot fall
  // back to photographing a restricted page: with no script injection there is nothing to drag on.
  try {
    await ensureContentScript(tabId)
  } catch {
    throw new PageShotterError(
      'REGION_UNAVAILABLE',
      'Chrome does not allow extensions to run on this page, so a region cannot be selected here. Capture the visible area instead.',
    )
  }

  const selection = await sendContentMessage(tabId, { type: 'SELECT_REGION' })
  if (!selection.ok) throw responseError(selection)
  await throwIfCancelled(job.id)

  // The user pressed Escape, clicked without dragging, or let the selection time out. That is a
  // cancellation, not a failure: no screenshot is taken and no result page opens.
  if (!selection.region) {
    throw new PageShotterError('CANCELLED', 'Region selection cancelled. The page was restored.')
  }

  const viewport = selection.viewport
  const scroll = selection.scroll ?? { x: 0, y: 0 }
  const region = selection.region

  // A region still entirely on screen is served by one screenshot and a crop. That is not merely an
  // optimisation: nothing is scrolled, so overlay policy, background unpinning, lazy settling and
  // stitching cannot touch the result, and it returns immediately. A page whose document cannot
  // scroll takes the same path because there is nowhere for a band to go.
  const onScreen =
    viewport === undefined ||
    selection.documentScrolls === false ||
    regionFitsViewport(region, scroll, viewport)

  if (onScreen) {
    await captureVisibleArea(job, tabId, windowId)
    const [segment] = await getSegments(job.id)
    if (segment && viewport && viewport.width > 0 && viewport.height > 0) {
      job.regionCrop = regionToImageCrop(
        regionToViewport(region, scroll),
        segment.imageWidth / viewport.width,
        segment.imageHeight / viewport.height,
        0,
        0,
        segment.imageWidth,
        segment.imageHeight,
      )
    }
    // This path photographs the viewport, so image (0, 0) is the page's scroll offset — not the
    // document's origin. Without this every link and word in a region captured below the fold lands
    // in the PDF exactly `scrollY` too high.
    job.imageOrigin = { x: scroll.x, y: scroll.y }
    // A region that maps to nothing leaves `regionCrop` unset, so the result page shows the whole
    // visible area rather than an empty export. That is a degraded result, not a broken one.
    return
  }

  await captureRegionBand(job, tabId, windowId, region, scroll)
}

/**
 * Captures a region taller than the window as a band: the ordinary scroll loop, seeded at the top of
 * the selection and stopped once the bottom of it has been covered, then cropped to the selection's
 * horizontal extent.
 *
 * Because this scrolls, it is a multi-segment capture like any other and the overlay rules apply
 * exactly as they do to a full-page capture — a selection spanning a scroll and one that fits on
 * screen will therefore treat a floating chat button differently, which is a consequence of the
 * page moving, not a special case for regions.
 *
 * Segments are stored with scroll offsets relative to the band rather than the document, because the
 * stitcher places the first segment at image y 0. Storing document offsets would pad the top of the
 * image with the entire distance scrolled to reach the selection.
 */
async function captureRegionBand(
  job: CaptureJob,
  tabId: number,
  windowId: number,
  region: SelectedRegion,
  scroll: { x: number; y: number },
): Promise<void> {
  const prepared = await sendContentMessage(tabId, {
    type: 'PREPARE_CAPTURE',
    jobId: job.id,
    sectionWaitMs: await getSectionWaitMs(),
    imageWaitMs: await getImageWaitMs(),
  })
  if (!prepared.ok || !prepared.metrics) throw responseError(prepared)
  if (prepared.degradations) {
    job.degradations = addDegradations(job.degradations ?? {}, prepared.degradations)
  }
  if (prepared.pageUrl) job.url = prepared.pageUrl

  const regionBottom = region.y + region.height
  let targetY = Math.max(0, region.y)
  let bandOrigin: number | undefined
  let index = 0
  let coveredUntil = targetY
  const seenOverlayIds = new Set<number>()

  while (index < CAPTURE_LIMITS.maxSegments) {
    await throwIfCancelled(job.id)
    const positioned = await sendContentMessage(tabId, {
      type: 'CAPTURE_POSITION',
      scrollY: targetY,
      seenOverlayIds: [...seenOverlayIds],
    })
    if (!positioned.ok || !positioned.metrics) throw responseError(positioned)
    const metrics = positioned.metrics
    // Each response reports only what happened since the last one, so these accumulate.
    if (positioned.degradations) {
      job.degradations = addDegradations(job.degradations ?? {}, positioned.degradations)
    }
    if (metrics.captureWidth <= 0 || metrics.captureHeight <= 0) {
      throw new PageShotterError(
        'NO_VISIBLE_CONTENT',
        'The scrollable area of this page is not visible on screen, so there is nothing to capture.',
      )
    }
    // The band's origin is wherever the page actually landed, which near the bottom of a document is
    // above the requested offset. Deriving it from the first segment rather than from the selection
    // keeps the image origin and the crop in agreement whatever the page did.
    if (bandOrigin === undefined) bandOrigin = metrics.scrollY
    if (metrics.scrollY > coveredUntil + 1) {
      throw new PageShotterError(
        'SCROLL_GAP',
        'The page forced Chrome to skip part of the document while scrolling. Disable scroll snapping and retry.',
      )
    }

    const dataUrl = await captureActiveTab(job.id, tabId, windowId, true)
    const blob = await dataUrlToBlob(dataUrl)
    const dimensions = await imageDimensions(blob)
    await throwIfCancelled(job.id)

    await putSegment({
      id: `${job.id}:${index}`,
      jobId: job.id,
      index,
      blob,
      imageWidth: dimensions.width,
      imageHeight: dimensions.height,
      ...metrics,
      scrollY: metrics.scrollY - bandOrigin,
    })
    for (const overlayId of metrics.overlayIds) seenOverlayIds.add(overlayId)
    coveredUntil = Math.max(coveredUntil, metrics.scrollY + metrics.captureHeight)

    index += 1
    await throwIfCancelled(job.id)
    job.segmentCount = index
    job.finalDocumentHeight = Math.min(coveredUntil, Math.max(regionBottom, coveredUntil)) - bandOrigin
    job.progress = { current: index, estimatedTotal: Math.max(index, estimatedSegmentCount(regionBottom - bandOrigin, metrics.captureHeight)) }
    job.updatedAt = Date.now()
    await putJob(job)

    if (coveredUntil >= regionBottom - 1) break
    const nextY = nextScrollY(metrics.scrollY, metrics.captureHeight, Math.min(metrics.documentHeight, regionBottom))
    if (nextY === null) break
    if (nextY <= metrics.scrollY) {
      throw new PageShotterError('PAGE_STOPPED_SCROLLING', 'The page stopped scrolling before capture finished.')
    }
    targetY = nextY
  }

  const [segment] = await getSegments(job.id)
  if (segment && bandOrigin !== undefined && segment.viewportWidth > 0 && segment.viewportHeight > 0) {
    const assembledHeight = job.finalDocumentHeight ?? 0
    const scaleX = segment.imageWidth / segment.viewportWidth
    const scaleY = segment.imageHeight / segment.viewportHeight
    job.regionCrop = regionToImageCrop(
      { x: region.x - scroll.x, y: region.y, width: region.width, height: region.height },
      scaleX,
      scaleY,
      segment.captureX,
      bandOrigin,
      Math.round(segment.captureWidth * scaleX),
      Math.round(assembledHeight * scaleY),
    )
    // Image pixel (0, 0) is the first segment's scroll offset, not the document's origin. The PDF
    // layers place document-space rects, so they need to subtract exactly this.
    job.imageOrigin = { x: scroll.x + segment.captureX / scaleX, y: bandOrigin }
  }
}

async function captureFullPage(job: CaptureJob, tabId: number, windowId: number): Promise<void> {
  const prepared = await sendContentMessage(tabId, {
    type: 'PREPARE_CAPTURE',
    jobId: job.id,
    sectionWaitMs: await getSectionWaitMs(),
    imageWaitMs: await getImageWaitMs(),
  })
  if (!prepared.ok || !prepared.metrics) throw responseError(prepared)
  if (prepared.degradations) {
    job.degradations = addDegradations(job.degradations ?? {}, prepared.degradations)
  }
  if (prepared.pageUrl) job.url = prepared.pageUrl

  // A nested scroller clipped above the viewport starts above content offset 0, so the loop is
  // seeded from the prepared position rather than assuming the document's origin.
  let targetY = Math.max(0, prepared.metrics.scrollY)
  const startOffset = targetY
  let index = 0
  let coveredUntil = targetY
  const seenOverlayIds = new Set<number>()
  /*
   * The height the page had when capture began, measured once and never again.
   *
   * This is the whole termination guarantee. Re-reading the document height every section -- what
   * this replaced -- makes the finish line recede exactly as fast as capture advances on any page
   * that appends while it is scrolled, so such a page could only ever end at the section ceiling.
   * With the target fixed here, `follow` grants a bounded extension on top of it, and every policy
   * except the one the user explicitly opts into terminates by construction rather than by
   * threshold.
   */
  const frozenHeight = Math.max(1, prepared.metrics.documentHeight)
  const policy = await getLongPagePolicy()
  const startedAt = Date.now()
  // Computed once, from the viewport the capture starts with, so the depth the page is told about is
  // the depth it is actually held to. Recomputing it per section would let it wobble with a viewport
  // that changes mid-capture, and the page would be given a different floor each time.
  const allowance = depthAllowance(policy, frozenHeight, Math.max(1, prepared.metrics.captureHeight))
  const depthLimit = Number.isFinite(allowance) ? allowance : undefined

  while (index < CAPTURE_LIMITS.maxSegments) {
    await throwIfCancelled(job.id)
    const positioned = await sendContentMessage(tabId, {
      type: 'CAPTURE_POSITION',
      scrollY: targetY,
      seenOverlayIds: [...seenOverlayIds],
      depthLimit,
    })
    if (!positioned.ok || !positioned.metrics) throw responseError(positioned)
    const metrics = positioned.metrics
    // Each response reports only what happened since the last one, so these accumulate.
    if (positioned.degradations) {
      job.degradations = addDegradations(job.degradations ?? {}, positioned.degradations)
    }
    if (metrics.captureWidth <= 0 || metrics.captureHeight <= 0) {
      throw new PageShotterError(
        'NO_VISIBLE_CONTENT',
        'The scrollable area of this page is not visible on screen, so there is nothing to capture.',
      )
    }
    if (metrics.scrollY > coveredUntil + 1) {
      throw new PageShotterError(
        'SCROLL_GAP',
        'The page forced Chrome to skip part of the document while scrolling. Disable scroll snapping and retry.',
      )
    }

    const dataUrl = await captureActiveTab(job.id, tabId, windowId, true)
    const blob = await dataUrlToBlob(dataUrl)
    const dimensions = await imageDimensions(blob)
    await throwIfCancelled(job.id)
    // Reach is bounded by the section ceiling alone. Chrome's canvas limit used to bound it here
    // too, which truncated every export — PDF included — at 65,535 output pixels; output is now a
    // stack of tiles, so that limit applies only where a single canvas is genuinely required.
    const reachLimit = sectionLimitCssHeight(startOffset, metrics.captureHeight)
    const plannedHeight = Math.min(metrics.documentHeight, allowance, reachLimit)

    await putSegment({
      id: `${job.id}:${index}`,
      jobId: job.id,
      index,
      blob,
      imageWidth: dimensions.width,
      imageHeight: dimensions.height,
      ...metrics,
    })
    for (const overlayId of metrics.overlayIds) seenOverlayIds.add(overlayId)
    coveredUntil = Math.max(coveredUntil, metrics.scrollY + metrics.captureHeight)

    index += 1
    await throwIfCancelled(job.id)
    job.segmentCount = index
    job.finalDocumentHeight = plannedHeight
    job.fullDocumentHeight = metrics.documentHeight
    job.truncated = metrics.documentHeight > plannedHeight + 1
    // Not a threshold and not a guess: the page is longer than it was when it was measured, which
    // is the only claim the popup makes about growth while a capture is running.
    job.growingPage = metrics.documentHeight > frozenHeight + 1
    job.progress = {
      current: index,
      estimatedTotal: Math.max(index, estimatedSegmentCount(plannedHeight, metrics.captureHeight)),
    }
    job.updatedAt = Date.now()
    await putJob(job)

    /*
     * Outgrowing the allowance is recorded, not acted on. Returning here -- what the first version
     * of this did -- ended the capture the moment the page was *known* to be taller than the
     * allowance, which is many sections before that allowance is reached: the screenshot lost the
     * sections it was entitled to, and was then padded out to the planned height with blank space.
     * `plannedHeight` is already capped at the allowance, so the ordinary end of the loop stops in
     * exactly the right place. This flag only decides what the result page says.
     */
    if (outgrewAllowance(metrics.documentHeight, allowance)) job.endlessPage = true

    /*
     * The deadline does have to return, because what it bounds is the wait itself. It reports the
     * height actually covered rather than the height planned, for the same reason a user's Stop
     * does: padding the picture out to a depth that was never photographed adds blank space.
     */
    if (deadlineReached(startedAt, Date.now())) {
      job.deadlineReached = true
      job.endlessPage = false
      job.finalDocumentHeight = coveredUntil
      return
    }

    const nextY = nextScrollY(metrics.scrollY, metrics.captureHeight, plannedHeight)
    if (nextY === null) return
    if (nextY <= metrics.scrollY) {
      throw new PageShotterError('PAGE_STOPPED_SCROLLING', 'The page stopped scrolling before capture finished.')
    }
    targetY = nextY
  }

  // The section ceiling was reached. `plannedHeight` is capped at that ceiling, so getting here
  // means the page is genuinely deeper than PageShotter captures in one run and `job.truncated` is
  // already set — the sections taken are delivered with a notice rather than thrown away. This used
  // to raise PAGE_KEEPS_GROWING, which was only ever true of a page that grew as it was scrolled and
  // discarded a perfectly good partial capture on every page that was merely very long.
}

/**
 * Asks the page for its links and text, injecting the content script first if this capture mode has
 * not already done so.
 *
 * Entirely best-effort. A restricted page refuses injection, a page mid-navigation refuses to
 * answer, and either way the capture is already taken and exports perfectly well — just without the
 * two optional PDF layers, which is exactly what the menu then says.
 */
async function collectPageContent(
  tabId: number,
  alreadyInjected: boolean,
): Promise<{
  pageContent?: PageContent
  captureOrigin?: { x: number; y: number }
  scroll?: ScrollOffset
  viewport?: { width: number; height: number }
  error?: string
}> {
  try {
    if (!alreadyInjected) await ensureContentScript(tabId)
    const response = await sendContentMessage(tabId, { type: 'COLLECT_PAGE_CONTENT' })
    if (!response.ok) return { error: response.error.message }
    if (!response.pageContent) return { error: 'The page returned no content.' }
    return {
      pageContent: response.pageContent,
      scroll: response.scroll,
      viewport: response.viewport,
      captureOrigin: response.captureOrigin,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const response = await sendContentMessage(tabId, { type: 'PING' })
    if (response.ok) return
  } catch {
    // The content script is injected only after an explicit user action grants activeTab access.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  const response = await sendContentMessage(tabId, { type: 'PING' })
  if (!response.ok) throw responseError(response)
}

async function sendContentMessage(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  return chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>
}

async function assertTabIsActive(tabId: number, windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (activeTab?.id !== tabId) {
    throw new PageShotterError(
      'TAB_NOT_ACTIVE',
      'The source tab must remain active while Chrome captures it. Return to the page and retry.',
    )
  }
}

async function captureActiveTab(
  jobId: string,
  tabId: number,
  windowId: number,
  heartbeat: boolean,
): Promise<string> {
  const generation = tabActivationGeneration.get(windowId) ?? 0
  const operation = captureQueue.then(async () => {
    let quotaFailureCount = 0

    while (quotaFailureCount < CAPTURE_RETRY_POLICY.maxAttempts) {
      try {
        await throwIfCancelled(jobId)
        if (heartbeat) {
          const response = await sendContentMessage(tabId, { type: 'HEARTBEAT_CAPTURE' })
          if (!response.ok) throw responseError(response)
        }
        await throwIfCancelled(jobId)
        await assertTabIsActive(tabId, windowId)
        if (generation !== (tabActivationGeneration.get(windowId) ?? 0)) {
          throw new PageShotterError(
            'TAB_CHANGED',
            'The active tab changed during capture. Return to the page and retry.',
          )
        }

        const result = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        lastCaptureAt = Date.now()
        await throwIfCancelled(jobId)
        await assertTabIsActive(tabId, windowId)
        if (generation !== (tabActivationGeneration.get(windowId) ?? 0)) {
          throw new PageShotterError(
            'TAB_CHANGED',
            'The active tab changed during capture. Return to the page and retry.',
          )
        }
        return result
      } catch (error) {
        await throwIfCancelled(jobId)
        if (!isCaptureQuotaError(error)) throw error
        quotaFailureCount += 1
        if (quotaFailureCount >= CAPTURE_RETRY_POLICY.maxAttempts) {
          throw new PageShotterError(
            'CAPTURE_RATE_LIMITED',
            'Chrome is temporarily limiting screenshot requests. Wait a moment and retry.',
          )
        }

        const waitMs = captureRetryDelayMs(
          quotaFailureCount,
          lastCaptureAt > 0 ? lastCaptureAt : null,
          Date.now(),
        )
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        await throwIfCancelled(jobId)
      }
    }

    throw new PageShotterError('CAPTURE_RATE_LIMITED', 'Chrome is temporarily limiting screenshot requests.')
  })
  captureQueue = operation.catch(() => undefined)
  return operation
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const image = await createImageBitmap(blob)
  const dimensions = { width: image.width, height: image.height }
  image.close()
  return dimensions
}

async function throwIfCancelled(jobId: string): Promise<void> {
  const persistedJob = await getJob(jobId)
  if (cancelledJobs.has(jobId) || persistedJob?.status === 'cancelled') {
    throw new PageShotterError('CANCELLED', 'Capture cancelled. The page was restored.')
  }
}

async function recoverInterruptedCaptures(): Promise<void> {
  const jobs = await getJobs()
  await Promise.all(
    jobs
      .filter((job) => job.status === 'capturing')
      .map(async (job) => {
        job.status = 'failed'
        job.error = {
          code: 'CAPTURE_INTERRUPTED',
          message: 'Chrome interrupted the capture. The page was restored; please retry.',
        }
        job.updatedAt = Date.now()
        await sendContentMessage(job.sourceTabId, { type: 'CLEANUP_CAPTURE' }).catch(() => undefined)
        await deleteSegments(job.id)
        await putJob(job)
        void recordCaptureFailed()
      }),
  )
}

async function initializeServiceWorker(): Promise<void> {
  await recoverInterruptedCaptures()
  await deleteExpiredCaptures()
  // Retention has to be applied somewhere that runs without a capture happening, or a history left
  // alone would keep its entries past the period the user was promised. Failing this must not stop
  // the worker from starting: the extension still captures perfectly well with a stale history.
  await pruneHistory().catch(() => undefined)
}

function responseError(response: ContentResponse): PageShotterError {
  return response.ok
    ? new PageShotterError('INVALID_RESPONSE', 'The page returned an invalid capture response.')
    : new PageShotterError(response.error.code, response.error.message)
}
