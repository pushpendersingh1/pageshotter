import { deleteCapture, deleteHistoryEntries, getEditorDoc, getHistoryEntry, getHistoryPageContent, getJob, getSegments } from '../shared/capture-db'
import { restoreTiledImage, saveCaptureToHistory } from './history-io'
import { ExportMenu, saveWithAnchor } from './export-menu'
import type { PageContent } from '../shared/page-content'
import {
  filenameProblem,
  sanitiseTypedFilename,
  suggestedFilename,
} from '../shared/filename'
import { displayedDownloadPath, downloadPath } from '../shared/download-folder'
import {
  DEFAULT_DOWNLOAD_FOLDER,
  getAutoDownload,
  getDownloadFolder,
  setDownloadFolder,
} from '../shared/history-settings'
import { buildTiledImage, encodeImage, encodePng, type TiledImage } from './stitcher'
import { canSaveUnattended } from '../shared/auto-download'
import { confirmDelete, printImage } from '../shared/confirm-delete'
import { createPdfBlob } from './pdf-export'
import { fullImageCrop, type CropRect } from './crop-geometry'
import { chromeTemplateFor } from './chrome-template'
import { cropTiledImage, renderEditedImage } from '../editor/export-renderer'
import { parseSceneDoc } from '../editor/scene'
import { presentAddress, stampText } from './presentation-options'
import {
  exportActionLabel,
  exportFileExtension,
  exportLimitParts,
  exportScaleLabel,
  scaleToFitSingleImage,
  suggestedExportScale,
  type ExportFormat,
} from './export-options'
import { noticeText, type NoticePart } from '../shared/notice-parts'
import { clampZoom, fitZoom, zoomIn, zoomOut, zoomedWidth, zoomPercentLabel } from './zoom-math'
import { wireThemeButton } from '../shared/theme'
import { captureNotice, type NoticeContent } from './notice'
import { buildReview, fadeOutUp, morph, openPop } from './review-ui'
import { waitForDownloadCompletion, type DownloadsApi } from './download-completion'
import {
  getReviewInstalledAt,
  getReviewState,
  onCaptureFailedState,
  putReviewState,
  recordExportAndCheck,
  type ReviewState,
} from '../shared/review-prompt'

// The palette control, shared with the popup: the choice is stored once and governs every page.
void wireThemeButton(requiredElement<HTMLButtonElement>('theme'), document.documentElement)

const title = requiredElement<HTMLElement>('title')
const dimensions = requiredElement<HTMLElement>('dimensions')
const previewWrap = requiredElement<HTMLElement>('preview-wrap')
const preview = requiredElement<HTMLElement>('preview')
const noticePanel = requiredElement<HTMLElement>('result-notice')
const noticeMessage = requiredElement<HTMLElement>('result-notice-message')
const noticeSettings = requiredElement<HTMLButtonElement>('result-notice-settings')
// Chrome owns the options page; an extension can only ask for it to be opened.
noticeSettings.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})
const exportBlocked = requiredElement<HTMLDialogElement>('export-blocked')
const exportBlockedMessage = requiredElement<HTMLElement>('export-blocked-message')
requiredElement<HTMLButtonElement>('export-blocked-close').addEventListener('click', () => {
  exportBlocked.close()
})

/*
 * The store-review ask, shown only where an export has actually succeeded and only when the
 * counters in `review-prompt.ts` say usage has earned it. The state lives in the settings store;
 * nothing here needs a permission the manifest does not already carry.
 */
const reviewPop = requiredElement<HTMLElement>('rv-pop')

/** The dev-only override: `result.html?...&rv-force=1` shows the ask without counting anything. */
function reviewForced(): boolean {
  return new URL(window.location.href).searchParams.get('rv-force') === '1'
}

function showForcedReview(anchor: HTMLButtonElement): void {
  void getReviewState().then((stored) => {
    if (!reviewPop.hidden) return
    openPop(anchor, { ...stored, exports: Math.max(stored.exports, 1) })
  })
}

/** Records one successful export and returns the state to ask with, or `undefined` when not now. */
async function recordExportSuccess(): Promise<ReviewState | undefined> {
  try {
    const now = Date.now()
    const stored = await getReviewState()
    // First use fills the install day in: onInstalled wrote it for fresh installs; anything
    // installed before this feature existed reads "now", which only ever delays an ask.
    const base =
      stored.installedAt > 0 ? stored : { ...stored, installedAt: (await getReviewInstalledAt()) || now }
    const { state, ask } = recordExportAndCheck(base, now)
    await putReviewState(state)
    return ask ? state : undefined
  } catch {
    return undefined
  }
}

/** A failed capture keeps the ask away for a day; the failure is never allowed to cost anything. */
async function recordCaptureFailure(): Promise<void> {
  try {
    const state = await getReviewState()
    await putReviewState(onCaptureFailedState(state, Date.now()))
  } catch {
    // A counter write that fails changes nothing the user can see.
  }
}

/**
 * One successful export, and the ask if this is the export that earns it.
 *
 * `anchor` is the button the success came from: Copy's popover hangs under Copy, a download's
 * under the download button. An ask that cannot be recorded or shown is skipped — the next
 * successful export tries again.
 */
async function afterExportSucceeded(anchor: HTMLButtonElement): Promise<void> {
  if (!reviewPop.hidden) return
  if (reviewForced()) {
    showForcedReview(anchor)
    return
  }
  const state = await recordExportSuccess()
  if (state) openPop(anchor, state)
}
const errorPanel = requiredElement<HTMLElement>('result-error')
const errorMessage = requiredElement<HTMLElement>('result-error-message')
const downloadButton = requiredElement<HTMLButtonElement>('download')
const saveAsDialog = requiredElement<HTMLDialogElement>('save-as-dialog')
const saveAsName = requiredElement<HTMLInputElement>('save-as-name')
const saveAsExt = requiredElement<HTMLSpanElement>('save-as-ext')
const saveAsCancel = requiredElement<HTMLButtonElement>('save-as-cancel')
const saveAsConfirm = requiredElement<HTMLButtonElement>('save-as-confirm')
const saveAsFallback = requiredElement<HTMLButtonElement>('save-as-fallback')
const saveAsProblem = requiredElement<HTMLParagraphElement>('save-as-problem')
const saveAsRow = requiredElement<HTMLSpanElement>('save-as-row')
const saveAsDestination = requiredElement<HTMLElement>('save-as-destination')
const saveAsAccess = requiredElement<HTMLParagraphElement>('save-as-access')
const exportOptionsButton = requiredElement<HTMLButtonElement>('export-options')
const exportMenu: ExportMenu = new ExportMenu(
  document,
  () => (image ? exportCrop() : undefined),
  (format) => onFormatChange(format),
  () => null,
  // No transparent background on this surface: the canvas options live in the editor.
  () => false,
  // `encodeExport` already caches on format, scale and quality, so the size and the download that
  // follows it share one encode.
  async () => (image ? (await encodeExport(exportMenu.current()))?.size : undefined),
)
const copyButton = requiredElement<HTMLButtonElement>('copy')
const printButton = requiredElement<HTMLButtonElement>('print')
const deleteButton = requiredElement<HTMLButtonElement>('delete-capture')
const editButton = requiredElement<HTMLButtonElement>('edit')
const exportNote = requiredElement<HTMLElement>('export-note')
const exportNoteMessage = requiredElement<HTMLElement>('export-note-message')
const exportNoteAction = requiredElement<HTMLButtonElement>('export-note-action')
const exportNoteActionLabel = requiredElement<HTMLElement>('export-note-action-label')
// Dismissed wording stays dismissed; a different warning (new crop, format or scale) shows again.
let dismissedExportNote = ''
requiredElement<HTMLButtonElement>('export-note-close').addEventListener('click', () => {
  dismissedExportNote = exportNoteMessage.textContent ?? ''
  exportNote.hidden = true
})
exportNoteAction.addEventListener('click', () => {
  const region = exportCrop()
  if (!region) return
  const fitting = suggestedExportScale(
    exportMenu.current(),
    region.width,
    region.height,
    exportMenu.scale(),
  )
  // `setScale` reports back, so the notice this button sits in redraws itself and -- the export now
  // being possible -- takes the button away with it.
  if (fitting !== null) exportMenu.setScale(fitting)
})
const errorAction = requiredElement<HTMLButtonElement>('result-error-action')
const errorActionLabel = requiredElement<HTMLElement>('result-error-action-label')
/*
 * Chrome blocks `chrome://` links in page content, so this cannot be an anchor -- but an extension
 * may navigate a tab there, and `?id=` lands on PageShotter's own details page, where the file
 * access toggle is, rather than on a list the reader then has to search.
 */
errorAction.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
})

let image: TiledImage | undefined
/** Links and text harvested from the source page, for the optional PDF layers. */
let pageContent: PageContent | undefined
let pageContentError: string | undefined
/** The code behind a failed capture, so a failure the user can fix can offer the fix. */
let failureCode: string | undefined
let imageOrigin: { x: number; y: number } | undefined
let imageScale: { x: number; y: number } | undefined
/**
 * True when `crop` is the capture's own selected region rather than something the user drew here.
 *
 * The two are the same field but not the same thing, and the difference is visible: a region
 * capture's preview shows the region alone, while `crop` is measured against the whole screenshot
 * behind it. Drawing that rectangle over a preview it does not describe put a crop box across the
 * picture at the wrong place -- and since a region capture offers no Clear crop, there was no way
 * to take it off again.
 */
/**
 * One cache for every raster export, keyed by everything that changes the bytes.
 *
 * There used to be a blob per format and a companion `jpegQuality`, and each new knob meant another
 * companion variable that some path would forget to compare. Scale would have been the third. A
 * single key means a setting the user changed can never be served the file from before they changed
 * it -- which is the actual requirement, stated once.
 */
let encodedBlob: Blob | undefined
let encodedKey: string | undefined
let pageTitle = 'PageShotter capture'
/*
 * Carried alongside the title purely so the exported filename can name the page and the moment.
 * Both are optional in practice: a restricted page stores no address, and a very old history entry
 * predates nothing, but neither should stop a file being saved.
 */
let pageUrl: string | undefined
let capturedAt = new Date()
let baseDimensions = ''
let crop: CropRect | undefined
let editorEntryId = ''
let editorRestoreFailure: string | undefined
const previewUrls: string[] = []

downloadButton.addEventListener('click', () => void runExport())
copyButton.addEventListener('click', () => void copyPng())
printButton.addEventListener('click', () => void printCapture())
deleteButton.addEventListener('click', () => void deleteCaptureAndClose())
editButton.addEventListener('click', () => {
  if (editorEntryId) {
    location.href = `editor.html?job=${encodeURIComponent(editorEntryId)}`
    return
  }
  exportBlockedMessage.textContent =
    'This screenshot could not be opened in the editor because it was too large to add to local History. ' +
    'Copy and Download still use the complete capture.'
  exportBlocked.showModal()
})
requiredElement<HTMLButtonElement>('close').addEventListener('click', () => window.close())
window.addEventListener('pagehide', () => {
  for (const url of previewUrls) URL.revokeObjectURL(url)
})

void loadResult()

async function loadResult(): Promise<void> {
  try {
    const jobId = new URL(window.location.href).searchParams.get('job')
    if (!jobId) throw new Error('The capture identifier is missing.')
    const job = await getJob(jobId)
    // No live job means this tab is being reopened -- a reload, a restored session, or a click in
    // the history list -- and the only place the pixels can still be is history. Reaching for it
    // here is what makes all three work, because each one addresses the capture by the same id.
    if (!job) {
      await loadFromHistory(jobId)
      return
    }
    if (job.status === 'failed') {
      failureCode = job.error?.code
      throw new Error(job.error?.message ?? 'Capture failed.')
    }
    if (job.status !== 'complete') throw new Error('This capture has not finished yet.')

    const segments = await getSegments(job.id)
    image = await buildTiledImage(segments, job.finalDocumentHeight ?? segments.at(-1)?.documentHeight ?? 0)
    // Segments are only discarded once the tiles that replace them exist.
    await deleteCapture(job.id)
    // Best-effort by design: the tiles are already in memory and every export reads them from there,
    // so a capture that cannot be *kept* is still a capture the user has. It must not be silent
    // either, which is what the notice below is for.
    let historyFailure: string | undefined
    try {
      const saved = await saveCaptureToHistory(job, image)
      if (saved) {
        editorEntryId = job.id
      } else {
        historyFailure =
          'This screenshot was not added to your history because it is larger than the local history limit. ' +
          'The capture itself is unaffected and every export below still works.'
      }
    } catch (error) {
      // The message names what is *known* -- it did not save, and the capture is unaffected -- and
      // then reports the error rather than guessing at a cause. The first version of this notice
      // confidently blamed a full disk, which sent the user looking for storage to clear when the
      // real fault was a missing permission in our own code. A notice that asserts a cause it has
      // not established is worse than one that admits it does not know.
      historyFailure =
        'This screenshot was not added to your history. The capture itself is unaffected — every ' +
        'download and export below works as normal. ' +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    }
    pageTitle = job.title
    pageUrl = job.url
    capturedAt = new Date(job.createdAt)
    pageContent = job.pageContent
    pageContentError = job.pageContentError
    imageOrigin = job.imageOrigin
    imageScale = job.imageScale
    const edited = await applyStoredEdit(job.id, job.regionCrop)
    renderPreview(image, edited ? undefined : job.regionCrop)
    title.textContent = job.title
    baseDimensions = edited
      ? `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px · edited`
      : `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px · ${job.segmentCount} ${job.segmentCount === 1 ? 'section' : 'sections'}`
    dimensions.textContent = baseDimensions
    drawNotice(captureNotice(job, historyFailure) ?? editorFailureNotice())
    updateExportNote()
    previewWrap.hidden = false
    downloadButton.disabled = false
    copyButton.disabled = typeof ClipboardItem === 'undefined'
    printButton.disabled = false
    // Nothing to delete when the capture never reached history; the picture on screen is all there is.
    deleteButton.disabled = editorEntryId === ''
    editButton.disabled = false
    editButton.setAttribute('aria-disabled', String(editorEntryId === ''))
    await enableExportMenu()
    if (reviewForced()) showForcedReview(downloadButton)

    // A region capture previews the region itself, not the whole screenshot with a box drawn on it:
    // the user already chose their frame on the page, and showing them the surroundings again asks
    // them to find it a second time. The crop is applied to the tiles here, so there is nothing left
    // to clear and no Clear crop is offered — every export, and the readout, describe the region and
    // only the region.
    if (job.regionCrop && !edited) {
      crop = job.regionCrop
      baseDimensions = `${crop.width.toLocaleString()} × ${crop.height.toLocaleString()} px · selected region`
      dimensions.textContent = baseDimensions
      updateExportNote()
    }

    // Last, and only on the success path: everything above has already drawn a complete, usable page,
    // so if the save or the close does not happen the user is left looking at the result page rather
    // than at nothing.
    await maybeSaveAndClose()
  } catch (error) {
    void recordCaptureFailure()
    showError(error instanceof Error ? error.message : 'The screenshot could not be loaded.')
  }
}

/**
 * Reopens a capture from history.
 *
 * The stored tiles are the finished image, so this is a read and a draw rather than a re-stitch --
 * which also means a later change to the stitcher can never retroactively alter a screenshot someone
 * has already seen and saved.
 *
 * Notices are deliberately not restored. "You stopped this capture" and "this page was longer than
 * PageShotter captures in one run" describe something that happened while the capture was running,
 * and repeating them days later next to an image the user has already accepted is noise. The
 * dimensions still say exactly what the image is.
 */
/**
 * The other way this page is reached: a reload, a restored session, a click in History, or a URL
 * typed straight in. There is no live job by then, so the pixels come from history instead.
 *
 * **Every control this page offers has to be enabled here as well as in `loadResult`.** The two
 * paths end in the same fully usable page and neither is the unusual one -- a capture is reviewed
 * once through `loadResult` and reopened through this one for the rest of its life. Print and Delete
 * shipped enabled on only the first, which is the mistake this note exists to stop repeating.
 */
async function loadFromHistory(entryId: string): Promise<void> {
  const entry = await getHistoryEntry(entryId)
  if (!entry) {
    throw new Error(
      'This capture is no longer stored. Screenshots are kept for a limited time and only on this ' +
        'computer, so it has either passed that period or been deleted.',
    )
  }

  image = await restoreTiledImage(entry)
  pageTitle = entry.title
  pageUrl = entry.url
  capturedAt = new Date(entry.createdAt)
  pageContent = await getHistoryPageContent(entry.id)
  pageContentError = entry.pageContentError
  imageOrigin = entry.imageOrigin
  imageScale = entry.imageScale
  const edited = await applyStoredEdit(entry.id, entry.regionCrop)
  renderPreview(image, edited ? undefined : entry.regionCrop)
  title.textContent = entry.title
  baseDimensions = edited
    ? `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px · edited`
    : `${entry.width.toLocaleString()} × ${entry.height.toLocaleString()} px · ${entry.segmentCount} ${entry.segmentCount === 1 ? 'section' : 'sections'}`
  dimensions.textContent = baseDimensions
  drawNotice(editorFailureNotice())
  updateExportNote()
  previewWrap.hidden = false
  downloadButton.disabled = false
  copyButton.disabled = typeof ClipboardItem === 'undefined'
  printButton.disabled = false
  editorEntryId = entry.id
  // Always enabled on this path, unlike the live-job one: reaching a capture through history is
  // proof it is in history.
  deleteButton.disabled = false
  editButton.disabled = false
  editButton.setAttribute('aria-disabled', 'false')
  await enableExportMenu()

  if (entry.regionCrop && !edited) {
    crop = entry.regionCrop
    baseDimensions = `${crop.width.toLocaleString()} × ${crop.height.toLocaleString()} px · selected region`
    dimensions.textContent = baseDimensions
    updateExportNote()
  }
}

async function applyStoredEdit(entryId: string, region?: CropRect): Promise<boolean> {
  const original = image
  if (!original) return false
  let source = original
  try {
    const stored = await getEditorDoc(entryId)
    if (stored === undefined) return false
    if (region) source = await cropTiledImage(source, region, imageScale?.x ?? source.scaleX)
    const scene = parseSceneDoc(stored, source.width, source.height, imageScale?.x ?? source.scaleX)
    image = await renderEditedImage(scene, source, chromeTemplateFor(scene.present.frame).band, {
      address: presentAddress(scene.present.url, pageUrl, pageTitle),
      stamp: stampText(scene.present.stamp, capturedAt),
    })
    crop = undefined
    pageContent = undefined
    pageContentError = 'Edited PDFs contain the finished picture; source-page text and links are not overlaid.'
    imageOrigin = undefined
    imageScale = undefined
    return true
  } catch (error) {
    image = original
    editorRestoreFailure =
      'The saved edit could not be rendered, so this page is showing the original capture instead. ' +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    return false
  }
}

function editorFailureNotice(): NoticeContent | null {
  return editorRestoreFailure
    ? { parts: [noticeText(editorRestoreFailure)], settingsLink: false }
    : null
}

/**
 * The preview is one image element per tile. Nothing is downscaled, so the user inspects the exact
 * pixels they are about to export, and Chrome decodes only the tiles currently on screen.
 */
function renderPreview(tiled: TiledImage, region?: CropRect): void {
  if (!region) {
    // The zoom controller owns this width from here on: it sets the rendered pixel width and
    // `img { width: 100% }` scales every tile with it. `.tiles` no longer carries `max-width: 100%`,
    // because zooming past the stage has to be allowed to overflow and scroll.
    setNaturalWidth(tiled.width)
    for (const tile of tiled.tiles) preview.append(previewTile(tile))
    return
  }

  // A region capture shows the region and nothing else: the frame was already chosen on the page, and
  // presenting the surroundings again asks the user to find their own selection a second time.
  //
  // Every measurement here is a percentage on purpose. An absolutely positioned stack with a pixel
  // width escapes the scaling applied to the preview, so the tiles would render at full size inside
  // a smaller window and the region would appear cropped on screen while exporting correctly. Sizing
  // the stack and its offsets against the window instead means one scale factor governs all three,
  // at any zoom.
  setNaturalWidth(region.width)
  preview.style.aspectRatio = `${region.width} / ${region.height}`
  preview.style.overflow = 'hidden'
  preview.style.position = 'relative'

  const stack = document.createElement('div')
  stack.style.position = 'absolute'
  stack.style.width = `${(tiled.width / region.width) * 100}%`
  stack.style.left = `${(-region.x / region.width) * 100}%`
  // Percentage `top` resolves against the window's height, which `aspect-ratio` has already put in
  // the same proportion as its width -- so this offset scales exactly as the width does.
  stack.style.top = `${(-region.y / region.height) * 100}%`
  for (const tile of tiled.tiles) stack.append(previewTile(tile))
  preview.append(stack)
}

function previewTile(tile: TiledImage['tiles'][number]): HTMLImageElement {
  const url = URL.createObjectURL(tile.blob)
  previewUrls.push(url)
  const element = document.createElement('img')
  element.src = url
  element.width = tile.width
  element.height = tile.height
  element.alt = ''
  element.loading = 'lazy'
  element.decoding = 'async'
  return element
}

/** Exports read this rather than branching on whether a crop exists. */
function exportCrop(): CropRect | undefined {
  if (!image) return undefined
  return crop ?? fullImageCrop(image.width, image.height)
}

/**
 * A capture can now be taller than any single canvas, so PNG, JPEG and Copy genuinely cannot produce
 * a file for it — PDF is written one page at a time and always can. Saying so here, before anything
 * is clicked, is the difference between an informed choice and a long wait ending in an error.
 *
 * The button stays enabled because a crop that fits exports perfectly well, and this is re-evaluated
 * whenever the crop *or the format* changes, so choosing PDF, or setting a workable region, visibly
 * clears the warning.
 */
function updateExportNote(): void {
  const region = exportCrop()
  // A PDF is written one page at a time and is never subject to this ceiling, so the warning is
  // shown against the format actually selected rather than against every export there used to be.
  // Format *and* scale: WebP's ceiling is a quarter of the canvas limit, and scaling down is one of
  // the remedies, so a warning that ignored either would be wrong in both directions -- absent when
  // WebP cannot hold the image, and still present after the user had already fixed it.
  const parts = region
    ? exportLimitParts(exportMenu.current(), region.width, region.height, exportMenu.scale())
    : null
  drawParts(exportNoteMessage, parts ?? [])
  exportNote.hidden = parts === null || exportNoteMessage.textContent === dismissedExportNote

  // The same scale the sentence names, from the same function, so the button cannot offer one thing
  // while the prose promises another.
  const fitting = region
    ? suggestedExportScale(exportMenu.current(), region.width, region.height, exportMenu.scale())
    : null
  exportNoteActionLabel.textContent = fitting === null ? '' : `Export at ${exportScaleLabel(fitting)}`
  exportNoteAction.hidden = fitting === null
}

/**
 * The full-size canvas is built here and nowhere else, only when an export actually needs it.
 *
 * Always unscaled: this is what Copy puts on the clipboard, and a scale chosen for a *download*
 * should not silently shrink what someone pastes.
 */
async function ensurePng(): Promise<Blob | undefined> {
  if (!image) return undefined
  return await cachedEncode('png', 1, () => encodePng(image as TiledImage, exportCrop(), 1))
}

async function cachedEncode(
  format: ExportFormat,
  scale: number,
  encode: () => Promise<Blob>,
): Promise<Blob> {
  const key = `${format}:${scale}:${exportMenu.quality()}`
  if (encodedBlob && encodedKey === key) return encodedBlob
  const blob = await encode()
  encodedBlob = blob
  encodedKey = key
  return blob
}

/**
 * One button, every format.
 *
 * The busy label and the filename both come from the selected format rather than from the function
 * that happens to be running, so a format added later cannot be given a button that lies about what
 * it is preparing.
 */
async function runExport(): Promise<void> {
  const format = exportMenu.current()
  const blocked = exportMenu.problemParts()
  if (blocked) {
    showExportError(blocked)
    return
  }
  const extension = exportFileExtension(format)
  const suggested = suggestedFilename({ title: pageTitle, url: pageUrl, capturedAt, extension })
  const folder = await getDownloadFolder().catch(() => DEFAULT_DOWNLOAD_FOLDER)
  const permissionGranted = folder === '' || (await hasDownloadsPermission())

  /*
   * Ask for the name before spending the encode. A large PNG takes real time to produce, and
   * cancelling afterwards would mean the work was done for a file nobody wanted.
   */
  await askForFilename({
    suggested,
    extension,
    folder,
    permissionGranted,
    encode: () => encodeExport(format),
  })
}

interface SaveChoice {
  filename: string
  folder: string
}

/**
 * Save this capture and close the tab, when the user asked for captures to arrive as files.
 *
 * The page still opens -- it is the only place that can assemble the image, because
 * `URL.createObjectURL` does not exist in an MV3 service worker and there is no DOM there to click
 * an anchor with. The worker opens it behind whatever the user is doing; this saves the file with
 * the name the dialog would have suggested and then asks to be closed.
 *
 * Every way of not succeeding leaves the tab open instead, which is the point: a background tab
 * that failed quietly and closed anyway would lose the capture with no trace. If it is still there,
 * the whole result page is there with it, and Download still works by hand.
 */
async function maybeSaveAndClose(): Promise<void> {
  try {
    const [on, folder, granted] = await Promise.all([
      getAutoDownload(),
      getDownloadFolder().catch(() => DEFAULT_DOWNLOAD_FOLDER),
      hasDownloadsPermission(),
    ])
    if (!canSaveUnattended(on, folder, granted)) return

    const format = exportMenu.current()
    if (exportMenu.problemParts()) return
    const extension = exportFileExtension(format)
    const blob = await encodeExport(format)
    if (!blob) return

    const filename = suggestedFilename({ title: pageTitle, url: pageUrl, capturedAt, extension })
    if ((await saveBlob(blob, { filename, folder })) !== 'saved') return

    // The counter moves, the ask does not: a popover in a tab that is about to close would be spent
    // without ever being seen. `recordExportSuccess` only offers the ask, so skipping it here simply
    // defers it to the next export the user watches.
    await recordExportSuccess()
    await chrome.runtime.sendMessage({ type: 'CLOSE_RESULT_TAB' })
  } catch {
    // Anything unexpected leaves the page open, which is the safe outcome.
  }
}

/**
 * Show the save dialog, save through it, and let the same card become the review ask when the save
 * has earned it.
 *
 * The dialog stays open through the encode and the download: the confirm button carries the
 * "Saving" spinner the prototype specified, and on a completed download it either fades out and
 * morphs into the ask, or closes normally. A download that did not finish restores the button and
 * explains itself inside the dialog, and never becomes the ask.
 *
 * The suggested name arrives complete, extension included; the input is given only the stem, and
 * the extension is rendered beside it as static text. So the saved name always ends in the
 * extension of the format actually encoded, whatever was typed.
 *
 * The stem is selected rather than merely focused, which is what makes "just press Download" and
 * "type a whole new name" both single actions. Escape counts as backing out while the form shows
 * and as "Not now" once the ask does, and Enter accepts, through the input's own keydown — a form
 * submit is deliberately not used, because submission is blocked in some contexts.
 */
function askForFilename(options: {
  suggested: string
  extension: string
  folder: string
  permissionGranted: boolean
  encode: () => Promise<Blob | undefined>
}): Promise<void> {
  const { suggested, extension, folder, permissionGranted, encode } = options
  const suffix = `.${extension}`
  const stem = suggested.endsWith(suffix) ? suggested.slice(0, -suffix.length) : suggested
  const form = requiredElement<HTMLElement>('save-as-form')

  saveAsName.value = stem
  saveAsName.disabled = false
  saveAsExt.textContent = suffix
  saveAsAccess.textContent = ''
  saveAsAccess.hidden = true
  saveAsFallback.hidden = true
  saveAsConfirm.hidden = false
  setButtonLabel(saveAsConfirm, 'Download')
  saveAsDialog.style.width = ''
  saveAsDialog.removeAttribute('aria-label')
  saveAsDialog.setAttribute('aria-labelledby', 'save-as-heading')
  saveAsDialog.getAnimations().forEach((animation) => animation.cancel())
  form.hidden = false
  form.getAnimations().forEach((animation) => animation.cancel())
  const actions = saveAsDialog.querySelector<HTMLElement>('.confirm-actions')
  if (actions) actions.hidden = false
  saveAsDialog.querySelectorAll('.rv-host').forEach((host) => host.remove())
  const openingSpinner = saveAsConfirm.querySelector<HTMLElement>('.spin')
  if (openingSpinner) openingSpinner.hidden = true

  return new Promise((resolve) => {
    let settled = false
    let folderPermissionGranted = permissionGranted
    let busy = false
    let encoded: Blob | undefined

    /*
     * Every way out of this dialog resolves the promise, and none of them is the only one that can.
     * `close` remains as a backstop; a `settled` guard makes the duplicates harmless.
     */
    const finish = (value: SaveChoice | undefined): void => {
      if (settled) return
      settled = true
      saveAsName.removeEventListener('input', validate)
      saveAsName.removeEventListener('keydown', onNameKey)
      saveAsConfirm.removeEventListener('click', accept)
      saveAsDialog.removeEventListener('cancel', onCancel)
      saveAsDialog.removeEventListener('close', onClose)
      saveAsCancel.removeEventListener('click', onCancelClick)
      saveAsFallback.removeEventListener('click', onFallback)
      saveAsName.disabled = false
      saveAsCancel.disabled = false
      const spin = spinner()
      if (spin) spin.hidden = true
      if (saveAsDialog.open) saveAsDialog.close(value ? 'save' : 'cancel')
      // Focus returns to the button that began this, so keyboard flow continues on the page.
      downloadButton.focus({ preventScroll: true })
      resolve()
    }

    const currentFilename = (): string => `${sanitiseTypedFilename(saveAsName.value)}${suffix}`
    const spinner = (): HTMLElement | null => saveAsConfirm.querySelector<HTMLElement>('.spin')

    const setBusy = (label: string): void => {
      busy = true
      saveAsName.disabled = true
      saveAsCancel.disabled = true
      saveAsConfirm.disabled = true
      saveAsFallback.disabled = true
      setButtonLabel(saveAsConfirm, label)
      const spin = spinner()
      if (spin) spin.hidden = false
    }

    const accept = (): void => {
      if (busy) return
      if (filenameProblem(saveAsName.value) !== undefined) return

      if (folder === '' || folderPermissionGranted) {
        void runSave({ filename: currentFilename(), folder })
        return
      }

      // The request is created before the first await, directly inside the click gesture. Chrome
      // rejects permission requests moved behind encoding or any other asynchronous boundary.
      let request: Promise<boolean>
      try {
        request = chrome.permissions.request({ permissions: ['downloads'] })
      } catch {
        showPermissionRefusal()
        return
      }

      setBusy('Waiting for Chrome…')

      void request
        .then(async (granted) => {
          if (!granted) {
            showPermissionRefusal()
            return
          }
          folderPermissionGranted = true
          await setDownloadFolder(folder).catch(() => undefined)
          await runSave({ filename: currentFilename(), folder })
        })
        .catch(() => showPermissionRefusal())
    }

    const runSave = async (choice: SaveChoice): Promise<void> => {
      setBusy('Saving')
      try {
        if (!encoded) encoded = await encode()
        if (!encoded) {
          showSaveProblem('The export could not be created. Nothing was saved.', false)
          return
        }
        const outcome = await saveBlob(encoded, choice)
        if (outcome === 'saved') {
          const ask = await recordExportSuccess()
          if (ask) {
            await morphDialogToReview(choice, ask)
            return
          }
          finish(choice)
          return
        }
        if (outcome === 'refused') {
          showSaveProblem(
            `Chrome could not save to ${displayedDownloadPath(choice.folder, choice.filename)}. ` +
              `Nothing was saved. You can save this file to ` +
              `${displayedDownloadPath('', choice.filename)} instead.`,
            true,
          )
          return
        }
        // An interrupted or silent download is not a success the ask can count on, and not a
        // capture failure either: say what happened and leave the retry to the user.
        showSaveProblem('The download did not finish. Try again, or Cancel.', false)
      } catch (error) {
        showSaveProblem(
          `Nothing was saved. ${
            error instanceof Error ? error.message : 'The export could not be created.'
          }`,
          false,
        )
      }
    }

    /** Fades the form out and morphs this same dialog card into the ask. */
    const morphDialogToReview = async (choice: SaveChoice, state: ReviewState): Promise<void> => {
      await fadeOutUp(form)
      const host = document.createElement('div')
      host.className = 'rv-host'
      const review = buildReview(state.exports, () => finish(choice), saveAsDialog)
      morph(saveAsDialog, () => {
        // Hide the padded `.confirm-body`, not only its child. Leaving the wrapper visible put an
        // empty 36px block above the modal ask while the popover version sat correctly at the top.
        form.hidden = true
        const actions = saveAsDialog.querySelector<HTMLElement>('.confirm-actions')
        if (actions) actions.hidden = true
        host.append(review.root)
        saveAsDialog.append(host)
        saveAsDialog.style.width = '400px'
      })
      saveAsDialog.setAttribute('aria-label', 'Saved. Rate PageShotter')
      review.playIntro(120)
      review.root.querySelector<HTMLElement>('.rv-cta')?.focus({ preventScroll: true })
    }

    const onFallback = (): void => {
      if (busy || filenameProblem(saveAsName.value) !== undefined) return
      void runSave({ filename: currentFilename(), folder: '' })
    }
    const onCancel = (event: Event): void => {
      event.preventDefault()
      if (busy) return
      // Escape inside the ask means "Not now", exactly as the prototype's keydown does.
      const later = saveAsDialog.querySelector<HTMLElement>('.rv-host [data-rv="later"]')
      if (later) {
        later.click()
        return
      }
      finish(undefined)
    }
    const onClose = (): void => finish(undefined)
    const onCancelClick = (): void => {
      if (!busy) finish(undefined)
    }
    const onNameKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        accept()
      }
    }

    const showPermissionRefusal = (): void => {
      showSaveProblem(
        `Folder access was not granted. Nothing was saved. Try again, or save this file to ` +
          `${displayedDownloadPath('', currentFilename())}.`,
        true,
      )
    }

    const showSaveProblem = (message: string, fallbackable: boolean): void => {
      busy = false
      saveAsName.disabled = false
      saveAsCancel.disabled = false
      saveAsConfirm.disabled = false
      saveAsFallback.hidden = !fallbackable
      saveAsFallback.disabled = !fallbackable
      saveAsAccess.textContent = message
      saveAsAccess.hidden = false
      const spin = spinner()
      if (spin) spin.hidden = true
      setButtonLabel(saveAsConfirm, 'Try again')
      saveAsConfirm.focus()
    }

    /*
     * Validate as they type. The confirm is disabled while the name is unusable, so Enter cannot
     * submit one either -- which is what makes this a validation rather than a message next to a
     * button that still works.
     *
     * The message appears only once they have made the box unusable, not on the way in, because the
     * suggested name is always valid and an error shown before anyone has typed is an accusation.
     */
    const validate = (): void => {
      const problem = filenameProblem(saveAsName.value)
      saveAsConfirm.disabled = busy || problem !== undefined
      saveAsRow.classList.toggle('invalid', problem !== undefined)
      saveAsName.setAttribute('aria-invalid', problem === undefined ? 'false' : 'true')
      saveAsProblem.textContent = problem ?? ''
      saveAsProblem.hidden = problem === undefined
      const shownFilename = problem === undefined ? currentFilename() : `…${suffix}`
      saveAsDestination.textContent = displayedDownloadPath(folder, shownFilename)
      saveAsFallback.disabled = busy || problem !== undefined
    }
    saveAsName.addEventListener('input', validate)

    saveAsConfirm.addEventListener('click', accept)
    saveAsName.addEventListener('keydown', onNameKey)
    saveAsDialog.addEventListener('cancel', onCancel)
    saveAsDialog.addEventListener('close', onClose)
    saveAsCancel.addEventListener('click', onCancelClick)
    saveAsFallback.addEventListener('click', onFallback)

    validate()
    saveAsDialog.returnValue = ''
    saveAsDialog.showModal()
    saveAsName.focus()
    saveAsName.select()
    /*
     * `select()` leaves the caret at the end, which scrolls a long name so only its tail is visible
     * -- the default begins with the date, so the user would see "...quarterly-report" and not the
     * part that makes it unique. Scrolling back shows the start while the whole stem stays selected,
     * which is what a native save dialog does.
     */
    saveAsName.scrollLeft = 0
  })
}

async function encodeExport(format: ExportFormat): Promise<Blob | undefined> {
  if (!image) return undefined
  const source = image
  const scale = exportMenu.scale()
  if (format !== 'pdf') {
    return await cachedEncode(format, scale, () =>
      encodeImage(format, source, exportCrop(), exportMenu.quality(), scale),
    )
  }
  return await createPdfBlob(
    { image, content: pageContent, imageOrigin, imageScale },
    exportCrop(),
    exportMenu.pdfOptions(pageContent !== undefined),
  )
}

/**
 * Print the capture as the image it is, not as the page it is displayed on.
 *
 * Shrunk by the same rule Copy uses, for the same reason: past Chrome's single-image ceiling there
 * is no encoded image to hand the print dialog at all, and a smaller one prints correctly where
 * nothing else would.
 */
async function printCapture(): Promise<void> {
  await withButton(printButton, 'Preparing...', async () => {
    const region = exportCrop()
    if (!image || !region) return
    const fit = scaleToFitSingleImage(region.width, region.height)
    const blob = fit < 1
      ? await cachedEncode('png', fit, () => encodePng(image as TiledImage, region, fit))
      : await ensurePng()
    if (blob) printImage(blob)
  })
}

/**
 * Delete this capture and close the tab.
 *
 * The tab goes because what it was showing no longer exists: leaving the result page up with its
 * preview, its Download button and its Edit button, all now operating on a screenshot that has been
 * deleted, is worse than closing. Everything on this page reads from history.
 */
async function deleteCaptureAndClose(): Promise<void> {
  if (editorEntryId === '') return
  const confirmed = await confirmDelete({
    heading: 'Delete this screenshot?',
    detail: `“${pageTitle}” is stored on this computer only, so deleting it cannot be undone and nothing is kept anywhere else.`,
  })
  if (!confirmed) return
  try {
    await deleteHistoryEntries([editorEntryId])
    await chrome.runtime.sendMessage({ type: 'CLOSE_RESULT_TAB' })
  } catch {
    showExportError([noticeText('This screenshot could not be deleted. It is still in your history.')])
  }
}

/**
 * Copy, shrinking the image if the clipboard could not otherwise have it.
 *
 * A capture past Chrome's single-image ceiling used to make Copy fail outright, which is the worst
 * of the three possible answers: the other two are a smaller picture, or an explanation. A smaller
 * picture is what someone pasting into a document actually wants -- they are about to scale it down
 * in the document anyway -- so it is shrunk to the largest size that fits and the button says so
 * rather than claiming an unqualified success.
 *
 * Only ever shrinks. An image that already fits is copied untouched at full size, which is the
 * common path and must stay lossless.
 */
async function copyPng(): Promise<void> {
  await withButton(copyButton, 'Preparing...', async () => {
    const region = exportCrop()
    if (!image || !region) return
    const fit = scaleToFitSingleImage(region.width, region.height)
    const blob = fit < 1 ? await cachedEncode('png', fit, () => encodePng(image as TiledImage, region, fit)) : await ensurePng()
    if (!blob) return
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setButtonLabel(copyButton, fit < 1 ? `Copied at ${exportScaleLabel(fit)}` : 'Copied')
      window.setTimeout(() => setButtonLabel(copyButton, 'Copy'), fit < 1 ? 2_600 : 1_400)
      // A resolved clipboard write is a successful export, by the same rule a completed download is.
      void afterExportSucceeded(copyButton)
    } catch {
      setButtonLabel(copyButton, 'Copy unavailable')
    }
  })
}

/**
 * Brings the options menu up once there is an image to export.
 *
 * `setAvailable` is told whether the capture carries page content, because the text and link layers
 * are read from the live page and a capture that never reached one — a visible-area shot of a
 * restricted page, or anything captured before this feature existed — genuinely cannot have them.
 */
async function enableExportMenu(): Promise<void> {
  exportOptionsButton.disabled = false
  await exportMenu.load()
  exportMenu.setAvailable(pageContent !== undefined, pageContentError)
}

/**
 * The primary button renames itself, because it is the only thing on screen that says which of the
 * which format a click will produce -- the picker that decided it is behind a caret.
 */
function onFormatChange(format: ExportFormat): void {
  setButtonLabel(downloadButton, exportActionLabel(format))
  // The single-image ceiling applies to PNG and JPEG and not to PDF, so the warning has to be
  // re-evaluated on a format change or it sits there being false.
  updateExportNote()
}

/* ---------- zoom ---------- */

/** The stage's own padding, so a fitted capture is not left flush against the window edge. */
const STAGE_GUTTER = 48

const workArea = requiredElement<HTMLElement>('work')
const zoomOutButton = requiredElement<HTMLButtonElement>('zoom-out')
const zoomInButton = requiredElement<HTMLButtonElement>('zoom-in')
const zoomFitButton = requiredElement<HTMLButtonElement>('zoom-fit')
const zoomFullButton = requiredElement<HTMLButtonElement>('zoom-full')
const zoomPercent = requiredElement<HTMLElement>('zoom-pct')

/**
 * The capture's own width in pixels, which is what a zoom percentage is a percentage *of*.
 *
 * For a region capture this is the region's width, not the whole screenshot's: the preview shows the
 * region alone, so 100% has to mean one screen pixel per pixel of the thing on screen.
 */
let naturalWidth = 0
let zoom = 1
/** Whether the current zoom came from Fit, so a resized window can keep it fitted. */
let zoomIsFit = true

zoomOutButton.addEventListener('click', () => setZoom(zoomOut(zoom)))
zoomInButton.addEventListener('click', () => setZoom(zoomIn(zoom)))
zoomFullButton.addEventListener('click', () => setZoom(1))
zoomFitButton.addEventListener('click', () => applyFit())
// Only a window that is still showing a fitted preview re-fits. Someone who has zoomed deliberately
// has said what they want to look at, and having it jump back on a window resize would undo that.
window.addEventListener('resize', () => {
  if (zoomIsFit) applyFit()
})

function setNaturalWidth(width: number): void {
  naturalWidth = width
  applyFit()
  // The transition is added only after the first width is in place. Without this the preview would
  // animate open from nothing on every page load, which reads as the page still loading.
  requestAnimationFrame(() => preview.classList.add('zoomable'))
}

function setZoom(next: number, fromFit = false): void {
  if (naturalWidth <= 0) return
  zoom = clampZoom(next)
  zoomIsFit = fromFit
  preview.style.width = `${zoomedWidth(naturalWidth, zoom)}px`
  zoomPercent.textContent = zoomPercentLabel(zoom)
}

function applyFit(): void {
  // `clientWidth`, not `getBoundingClientRect`, so the vertical scrollbar the preview itself causes
  // is already excluded -- otherwise fitting a tall capture leaves it a scrollbar's width too wide.
  setZoom(fitZoom(workArea.clientWidth, STAGE_GUTTER, naturalWidth), true)
}

/**
 * A button's own words, without its icon.
 *
 * Buttons whose text changes while they work carry a `.button-label` span, because writing
 * `textContent` on the button itself would replace every child -- including the icon, which would
 * then be gone until the page was reloaded.
 */
function buttonLabel(button: HTMLButtonElement): string {
  const label = button.querySelector('.button-label')
  return (label ?? button).textContent ?? ''
}

function setButtonLabel(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector('.button-label')
  if (label) label.textContent = text
  else button.textContent = text
}

async function withButton(
  button: HTMLButtonElement,
  busyLabel: string,
  action: () => Promise<void>,
): Promise<void> {
  const label = buttonLabel(button)
  // A previous failure's explanation must not outlive it. Without this, refusing an oversize PNG and
  // then successfully exporting a crop leaves the "too large" message sitting above the file that
  // just proved it wrong. Restoring the note rather than merely hiding it also puts back the
  // standing warning, if the newly selected format still cannot hold the image.
  updateExportNote()
  button.disabled = true
  setButtonLabel(button, busyLabel)
  try {
    await action()
  } catch (error) {
    // A failed export leaves the screenshot itself intact, so the preview stays on screen.
    showExportError([
      noticeText(error instanceof Error ? error.message : 'The export could not be created.'),
    ])
  } finally {
    button.disabled = false
    if (buttonLabel(button) === busyLabel) setButtonLabel(button, label)
  }
}

/**
 * What a save turned out to be, from the ask's point of view.
 *
 * `saved` means the export reached Chrome for certain — a confirmed `onChanged` completion for a
 * folder save, or the blob handed to an anchor download for root Downloads (a deliberate hybrid: an anchor has no completion event to wait on). `interrupted` and `unknown` say the ask
 * must not open; `refused` says the folder path was declined and the Downloads fallback may be
 * offered.
 */
type SaveOutcome = 'saved' | 'interrupted' | 'unknown' | 'refused'

/**
 * Save the file, into the chosen folder when there is one.
 *
 * An anchor download needs no permission but cannot express a subfolder. Folder saves therefore use
 * `chrome.downloads`, whose optional permission is requested from the save-dialog click that names
 * the destination. Root Downloads remains available when the user chose it in Settings or accepts
 * the one-export fallback after a refusal.
 */
async function saveBlob(blob: Blob, choice: SaveChoice): Promise<SaveOutcome> {
  if (choice.folder === '') {
    saveWithAnchor(blob, choice.filename)
    return 'saved'
  }

  if (!(await hasDownloadsPermission())) return 'refused'
  return await downloadIntoFolder(blob, downloadPath(choice.folder, choice.filename))
}

async function hasDownloadsPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['downloads'] })
  } catch {
    return false
  }
}

/** Resolves the save outcome for a folder save, reconciling Chrome's state as soon as the id exists. */
async function downloadIntoFolder(blob: Blob, path: string): Promise<SaveOutcome> {
  const url = URL.createObjectURL(blob)
  try {
    const id = await chrome.downloads.download({ url, filename: path, conflictAction: 'uniquify' })
    return await waitForDownloadCompletion(chrome.downloads as unknown as DownloadsApi, id)
  } catch {
    return 'refused'
  } finally {
    /*
     * Longer than the anchor path's second: Chrome reads the object URL asynchronously after the
     * call resolves, and revoking too early produces a zero-byte file.
     */
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/*
 * An export failure is not a missing screenshot.
 *
 * This used to fill the page's fatal panel, which is headed "Screenshot unavailable" and offers to
 * close the tab -- both false, since the screenshot was on screen behind it, and the panel then
 * collapsed to a one-word column because it had become a flex sibling of the preview. It belongs
 * where the warning that predicted it already lives -- an export failure and the notice saying the
 * export cannot be made are the same sentence, before and after pressing the button -- and is also
 * raised as a modal, because a press has to visibly answer for itself.
 */
function showExportError(parts: readonly NoticePart[]): void {
  drawParts(exportNoteMessage, parts)
  exportNote.hidden = false
  // Repeated as a modal because this one is the *outcome of a click*, not a standing condition. The
  // strip is already on screen when the button is pressed, so writing into it a second time is a
  // change the reader has no reason to look for -- the press would read as having done nothing.
  drawParts(exportBlockedMessage, parts)
  if (!exportBlocked.open) exportBlocked.showModal()
}

function showError(message: string): void {
  title.textContent = 'Capture unavailable'
  dimensions.textContent = ''
  previewWrap.hidden = true
  noticePanel.hidden = true
  exportNote.hidden = true
  errorPanel.hidden = false
  errorMessage.textContent = message.toLowerCase().includes('upload')
    ? message
    : `${message} Nothing was uploaded.`
  // The remedy for this one is a toggle on PageShotter's own details page, and a reader told to go
  // to chrome://extensions still has to find their extension in a list to act on it.
  const fixable = failureCode === 'FILE_ACCESS_DENIED'
  errorActionLabel.textContent = 'Open PageShotter’s permissions'
  errorAction.hidden = !fixable
}

/**
 * Constrained to `Element` rather than `HTMLElement` because the export menu's ratio glyph is an
 * `SVGRectElement`, which is an `Element` but not an `HTMLElement`. The throw is the point: a page
 * that has lost a control its script drives should fail loudly at load rather than silently do
 * nothing when the control is used.
 */
function requiredElement<T extends Element>(id: string): T {
  const element: Element | null = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element as T
}

/*
 * Paints a notice, or hides the panel when there is nothing to admit.
 *
 * Numbers and setting names are marked up rather than merely stated. A reader who has just been told
 * their screenshot is incomplete is scanning for two things -- how much they got, and what they can
 * do about it -- and a wall of even prose makes them read the whole sentence to find either.
 */
function drawNotice(content: NoticeContent | null): void {
  if (content === null) {
    noticePanel.hidden = true
    noticeSettings.hidden = true
    return
  }

  noticeMessage.replaceChildren(
    ...content.parts.map((part) => {
      if (part.kind === 'text') return document.createTextNode(part.text)
      const span = document.createElement('span')
      span.className = part.kind === 'value' ? 'notice-value' : 'notice-chip'
      span.textContent = part.text
      return span
    }),
  )
  noticeSettings.hidden = !content.settingsLink
  noticePanel.hidden = false
}

/** Paints marked-up runs into an element, replacing whatever was there. */
function drawParts(target: HTMLElement, parts: readonly NoticePart[]): void {
  target.replaceChildren(
    ...parts.map((part) => {
      if (part.kind === 'text') return document.createTextNode(part.text)
      const span = document.createElement('span')
      span.className = part.kind === 'value' ? 'notice-value' : 'notice-chip'
      span.textContent = part.text
      return span
    }),
  )
}
