import { BROWSER } from '../shared/browser'
import { deleteCapture, getSegments } from '../shared/capture-db'
import { downloadPath } from '../shared/download-folder'
import { suggestedFilename } from '../shared/filename'
import { DEFAULT_DOWNLOAD_FOLDER, getDownloadFolder } from '../shared/history-settings'
import type { CaptureJob, RuntimeRequest, RuntimeResponse } from '../shared/messages'
import { applyStoredTheme, wireThemeButton } from '../shared/theme'
import { waitForDownloadCompletion, type DownloadsApi } from '../result/download-completion'
import { EXPORT_FORMATS, exportFileExtension, type ExportFormat } from '../result/export-options'
import { getExportPreferences, type ExportPreferences } from '../result/export-preferences'
import { saveCaptureToHistory } from '../result/history-io'
import { createPdfBlob } from '../result/pdf-export'
import { buildTiledImage, encodeImage } from '../result/stitcher'
import {
  BATCH_PERMISSIONS,
  LOAD_TIMEOUT_CHOICES,
  RENDER_WAIT_CHOICES,
  batchFilename,
  batchFolder,
  batchFolderName,
  getBatchOptions,
  parseBatchUrls,
  setBatchOptions,
  siteCount,
  type BatchMode,
  type BatchOptions,
} from './batch-plan'

void applyStoredTheme(document.documentElement)
wireThemeButton(requiredElement<HTMLButtonElement>('theme'), document.documentElement)

const urlsInput = requiredElement<HTMLTextAreaElement>('urls')
const urlSummary = requiredElement<HTMLParagraphElement>('url-summary')
const modeGroup = requiredElement<HTMLElement>('batch-mode')
const formatGroup = requiredElement<HTMLElement>('batch-format')
const loadTimeoutSelect = requiredElement<HTMLSelectElement>('load-timeout')
const renderWaitSelect = requiredElement<HTMLSelectElement>('render-wait')
const subfolderSwitch = requiredElement<HTMLInputElement>('subfolder')
const subfolderNote = requiredElement<HTMLParagraphElement>('subfolder-note')
const showFolderSwitch = requiredElement<HTMLInputElement>('show-folder')
const accessNote = requiredElement<HTMLParagraphElement>('access-note')
const startButton = requiredElement<HTMLButtonElement>('start')
const stopButton = requiredElement<HTMLButtonElement>('stop')
const batchStatus = requiredElement<HTMLParagraphElement>('batch-status')
const reportGroup = requiredElement<HTMLElement>('report-group')
const report = requiredElement<HTMLOListElement>('report')
const retryFailedButton = requiredElement<HTMLButtonElement>('retry-failed')

const FORMAT_LABELS: Record<ExportFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', pdf: 'PDF' }
const MODE_LABELS: Record<BatchMode, string> = { full: 'Full page', visible: 'Visible part' }
/** How often the job is read back while the worker captures it. The popup polls at the same pace. */
const JOB_POLL_MS = 400

type RowState = 'waiting' | 'loading' | 'rendering' | 'capturing' | 'saving' | 'saved' | 'failed' | 'skipped'

interface Row {
  url: string
  position: number
  state: RowState
  element: HTMLLIElement
  stateText: HTMLSpanElement
  retry: HTMLButtonElement
}

/** One run's choices, read once when it starts so a change mid-batch cannot split it in two. */
interface Run {
  options: BatchOptions
  format: ExportFormat
  preferences: ExportPreferences
  folder: string
  total: number
}

/** A reason to end the whole batch rather than mark one page failed. */
class BatchAbort extends Error {}

/** Stop was pressed while a page was waiting its turn to be seen. */
class StoppedWhilePaused extends Error {}

/** A capture that failed, with the worker's code kept so a covered window can be told apart. */
class CaptureFailure extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

let rows: Row[] = []
let currentRun: Run | undefined
let running = false
let stopRequested = false
let settingsFormat: ExportFormat = 'png'

/*
 * Recorded per tab from the moment the page opens, so a tab created later can never have reported
 * its first load before anyone was listening for it.
 */
const tabLoads = new Map<number, { loading: boolean; complete: boolean }>()
const closedTabs = new Set<number>()
const loadWaiters = new Set<() => void>()
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const entry = tabLoads.get(tabId) ?? { loading: false, complete: false }
  if (info.status === 'loading') {
    entry.loading = true
    entry.complete = false
  } else if (info.status === 'complete' && entry.loading) {
    entry.complete = true
  }
  tabLoads.set(tabId, entry)
  for (const wake of loadWaiters) wake()
})
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLoads.delete(tabId)
  closedTabs.add(tabId)
  for (const wake of loadWaiters) wake()
})

void initialise()

async function initialise(): Promise<void> {
  const [options, preferences] = await Promise.all([
    getBatchOptions().catch(() => undefined),
    getExportPreferences().catch(() => undefined),
  ])
  settingsFormat = preferences?.format ?? 'png'

  for (const mode of ['full', 'visible'] as const) appendSegment(modeGroup, 'batch-mode', mode, MODE_LABELS[mode])
  for (const format of EXPORT_FORMATS) appendSegment(formatGroup, 'batch-format', format, FORMAT_LABELS[format])
  for (const choice of LOAD_TIMEOUT_CHOICES) appendOption(loadTimeoutSelect, String(choice.ms), choice.label)
  for (const choice of RENDER_WAIT_CHOICES) appendOption(renderWaitSelect, String(choice.ms), choice.label)

  if (options) drawOptions(options)
  for (const control of [modeGroup, formatGroup, loadTimeoutSelect, renderWaitSelect, subfolderSwitch, showFolderSwitch]) {
    control.addEventListener('change', () => {
      drawSubfolderNote()
      void setBatchOptions(currentOptions()).catch(() => undefined)
    })
  }

  urlsInput.addEventListener('input', drawSummary)
  startButton.addEventListener('click', onStart)
  stopButton.addEventListener('click', () => {
    stopRequested = true
    stopButton.disabled = true
    showStatus('Stopping after the page being captured now.')
  })
  retryFailedButton.addEventListener('click', () => {
    const failed = rows.filter((row) => row.state === 'failed' || row.state === 'skipped')
    if (failed.length > 0) requestAccessThenRun(failed)
  })

  // A batch in progress is lost if this tab goes, and its window with it. Browsers show their own
  // wording for this; asking is what matters.
  window.addEventListener('beforeunload', (event) => {
    if (running) event.preventDefault()
  })

  drawSummary()
  drawSubfolderNote()
  await drawAccessNote()
  chrome.permissions.onAdded.addListener(() => void drawAccessNote())
  chrome.permissions.onRemoved.addListener(() => void drawAccessNote())
}

function drawOptions(options: BatchOptions): void {
  checkRadio(modeGroup, options.mode)
  checkRadio(formatGroup, options.format ?? settingsFormat)
  loadTimeoutSelect.value = String(options.loadTimeoutMs)
  renderWaitSelect.value = String(options.renderWaitMs)
  subfolderSwitch.checked = options.subfolder
  showFolderSwitch.checked = options.showFolder
}

function currentOptions(): BatchOptions {
  const mode = checkedValue(modeGroup) === 'visible' ? 'visible' : 'full'
  const format = checkedValue(formatGroup) as ExportFormat | undefined
  return {
    mode,
    // Stored only once it differs from Settings, so a batch keeps following the Settings file type
    // until someone deliberately picks another one here.
    ...(format !== undefined && format !== settingsFormat ? { format } : {}),
    loadTimeoutMs: Number(loadTimeoutSelect.value),
    renderWaitMs: Number(renderWaitSelect.value),
    subfolder: subfolderSwitch.checked,
    showFolder: showFolderSwitch.checked,
  }
}

function drawSummary(): void {
  const { urls, rejected } = parseBatchUrls(urlsInput.value)
  const parts: string[] = []
  if (urls.length > 0) {
    const sites = siteCount(urls)
    parts.push(`${plural(urls.length, 'page')} on ${plural(sites, 'site')}.`)
  }
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 3).map((entry) => `“${entry.line}” (${entry.reason})`)
    const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : ''
    parts.push(`Skipped: ${shown.join(', ')}${more}.`)
  }
  urlSummary.textContent = parts.join(' ')
  startButton.disabled = running || urls.length === 0
}

function drawSubfolderNote(): void {
  void getDownloadFolder()
    .catch(() => DEFAULT_DOWNLOAD_FOLDER)
    .then((folder) => {
      const destination = batchFolder(folder, subfolderSwitch.checked ? batchFolderName(new Date()) : undefined)
      subfolderNote.textContent = `Files go to Downloads/${destination === '' ? '' : `${destination}/`}`
    })
}

/** Asked rather than remembered: access can be removed from Settings or the browser at any time. */
async function drawAccessNote(): Promise<void> {
  const granted = await chrome.permissions.contains(BATCH_PERMISSIONS).catch(() => false)
  accessNote.textContent = granted
    ? 'PageShotter has the access batch capture needs. You can remove it in Settings.'
    : `Start asks ${BROWSER.name} for access to all websites and to downloads. A screenshot of a page you didn't open from PageShotter needs both. Nothing is uploaded.`
}

/**
 * The permission request comes first and synchronously. Firefox honours `permissions.request` only
 * inside the click that asked for it, and anything awaited before the call can end that window.
 */
function onStart(): void {
  if (running) return
  const { urls } = parseBatchUrls(urlsInput.value)
  if (urls.length === 0) return
  currentRun = undefined
  rows = urls.map((url, index) => createRow(url, index + 1))
  report.replaceChildren(...rows.map((row) => row.element))
  reportGroup.hidden = false
  requestAccessThenRun(rows)
}

function requestAccessThenRun(selected: Row[]): void {
  void chrome.permissions
    .request(BATCH_PERMISSIONS)
    // A refused prompt and a request the browser rejected outright read very differently to the
    // person who saw no prompt at all, so the browser's own reason is kept rather than folded into
    // "not granted".
    .then(
      (granted) => ({ granted, reason: undefined }),
      (error: unknown) => ({ granted: false, reason: error instanceof Error ? error.message : String(error) }),
    )
    .then(({ granted, reason }) => {
      void drawAccessNote()
      if (reason !== undefined) {
        showStatus(`${BROWSER.name} could not ask for access, so nothing was captured. Its reason: ${reason}`, true)
        return
      }
      if (!granted) {
        showStatus(
          `${BROWSER.name} did not grant access, so nothing was captured. Batch capture needs it to take a screenshot of each page.`,
          true,
        )
        return
      }
      return runBatch(selected)
    })
}

async function runBatch(selected: Row[]): Promise<void> {
  running = true
  stopRequested = false
  setRunning(true)
  hideStatus()
  for (const row of selected) setRowState(row, 'waiting', 'Waiting')

  const options = currentOptions()
  void setBatchOptions(options).catch(() => undefined)
  /*
   * A retry takes the options as they are now -- raising the load limit and retrying is exactly
   * what a page that timed out calls for -- but keeps its batch's folder and numbering, so the
   * retried file lands beside the others in its place in the list.
   */
  const folder =
    currentRun?.folder ??
    batchFolder(
      await getDownloadFolder().catch(() => DEFAULT_DOWNLOAD_FOLDER),
      options.subfolder ? batchFolderName(new Date()) : undefined,
    )
  const run: Run = {
    options,
    format: options.format ?? settingsFormat,
    preferences: await getExportPreferences(),
    folder,
    total: rows.length,
  }
  currentRun = run

  // The worker closes the window if this page goes away mid-batch; see `onConnect` there.
  const port = chrome.runtime.connect({ name: 'batch' })
  let windowId: number | undefined
  let lastDownloadId: number | undefined
  let abortMessage: string | undefined
  try {
    const opened = await openCaptureWindow()
    windowId = opened.windowId
    let tabId = opened.tabId
    port.postMessage({ windowId })
    for (const row of selected) {
      if (stopRequested) break
      const result = await captureRow(row, run, windowId, tabId)
      tabId = result.tabId
      if (result.downloadId !== undefined) lastDownloadId = result.downloadId
    }
  } catch (error) {
    abortMessage = error instanceof Error ? error.message : String(error)
  } finally {
    if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => undefined)
    port.disconnect()
    for (const row of selected) {
      if (row.state === 'waiting') setRowState(row, 'skipped', 'Not captured: the batch stopped first')
    }
    running = false
    setRunning(false)
    await focusThisPage()
  }

  if (run.options.showFolder && lastDownloadId !== undefined) {
    try {
      chrome.downloads.show(lastDownloadId)
    } catch {
      // Showing the folder is a convenience; the files are saved either way.
    }
  }
  const saved = rows.filter((row) => row.state === 'saved').length
  const failed = rows.filter((row) => row.state === 'failed' || row.state === 'skipped').length
  const summary = `${plural(saved, 'page')} saved${failed > 0 ? `, ${failed} not` : ''}.`
  showStatus(abortMessage ? `${abortMessage} ${summary}` : summary, abortMessage !== undefined || failed > 0)
}

/**
 * A window of its own, at the size of this one, so pages lay out the way they would for the user.
 *
 * `captureVisibleTab` photographs what is on screen, so the window is focused rather than opened
 * behind: a window covered by another may not be painted at all.
 */
async function openCaptureWindow(): Promise<{ windowId: number; tabId: number }> {
  const own = await chrome.windows.getCurrent().catch(() => undefined)
  const placement: chrome.windows.CreateData =
    own?.state === 'maximized' || own?.state === 'fullscreen'
      ? { state: 'maximized' }
      : { width: own?.width, height: own?.height, left: own?.left, top: own?.top }
  const created = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal', ...placement })
  const tabId = created?.tabs?.[0]?.id
  if (created?.id === undefined || tabId === undefined) {
    throw new BatchAbort('The capture window could not be opened.')
  }
  return { windowId: created.id, tabId }
}

/**
 * One page, start to finish. Each page gets a fresh tab and the previous one is closed.
 *
 * A fresh tab rather than navigating one tab through the list, because it makes a page that never
 * answered unmistakable: the tab is still on its blank first document, which refuses the content
 * script, so the page is reported as not loaded. Navigating a single tab would still be showing the
 * *previous* page, and would save it under this page's number.
 */
async function captureRow(
  row: Row,
  run: Run,
  windowId: number,
  previousTabId: number,
): Promise<{ tabId: number; downloadId?: number }> {
  setRowState(row, 'loading', 'Loading')
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.create({ windowId, url: row.url, active: true })
  } catch {
    throw new BatchAbort('The capture window was closed, so the batch stopped.')
  }
  const tabId = tab.id as number
  await chrome.tabs.remove(previousTabId).catch(() => undefined)

  try {
    const loaded = await waitForLoad(tabId, run.options.loadTimeoutMs)
    if (run.options.renderWaitMs > 0) {
      setRowState(row, 'rendering', 'Letting it render')
      await sleep(run.options.renderWaitMs)
    }
    await assertTabOpen(tabId)
    await waitUntilVisible(row, windowId, tabId)

    setRowState(row, 'capturing', 'Capturing')
    let job: CaptureJob
    try {
      job = await captureInWorker(tabId, run.options.mode)
    } catch (error) {
      // Covered partway through: the page was restored, so once it can be seen again it is simply
      // captured again. Once only -- a second failure is reported like any other.
      if (!(error instanceof CaptureFailure) || error.code !== 'PAGE_HIDDEN') throw error
      await waitUntilVisible(row, windowId, tabId)
      setRowState(row, 'capturing', 'Capturing again')
      job = await captureInWorker(tabId, run.options.mode)
    }
    setRowState(row, 'saving', 'Saving')
    const downloadId = await saveJob(job, row, run)
    setRowState(row, 'saved', savedDescription(job, loaded))
    return { tabId, downloadId }
  } catch (error) {
    if (error instanceof BatchAbort) {
      setRowState(row, 'failed', error.message)
      throw error
    }
    if (error instanceof StoppedWhilePaused) {
      setRowState(row, 'skipped', 'Not captured: the batch stopped first')
      return { tabId }
    }
    setRowState(row, 'failed', error instanceof Error ? error.message : String(error))
    return { tabId }
  }
}

/** `true` when the page said it had loaded, `false` when the limit came first. */
function waitForLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined
    const check = (): void => {
      if (closedTabs.has(tabId)) {
        finish()
        reject(new BatchAbort('The capture window was closed, so the batch stopped.'))
      } else if (tabLoads.get(tabId)?.complete) {
        finish()
        resolve(true)
      }
    }
    const finish = (): void => {
      loadWaiters.delete(check)
      if (timer !== undefined) window.clearTimeout(timer)
    }
    if (timeoutMs > 0) {
      timer = window.setTimeout(() => {
        finish()
        resolve(false)
      }, timeoutMs)
    }
    loadWaiters.add(check)
    check()
  })
}
/**
 * Holds the page until the browser is actually drawing it.
 *
 * Capture waits for frames, and a browser draws no frames for a page in a minimised window or one
 * covered by another -- which is exactly where a batch's window ends up the moment someone goes
 * back to what they were doing. So the window is brought forward once, and if the page is still
 * not visible the batch pauses and says so rather than failing every page after it. It does not
 * keep pulling the window forward: someone who switched away did so on purpose.
 */
async function waitUntilVisible(row: Row, windowId: number, tabId: number): Promise<void> {
  const captureWindow = await chrome.windows.get(windowId).catch(() => undefined)
  if (captureWindow === undefined) throw new BatchAbort('The capture window was closed, so the batch stopped.')
  await chrome.windows
    .update(windowId, captureWindow.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true })
    .catch(() => undefined)

  let paused = false
  for (let attempt = 0; ; attempt += 1) {
    const visible = await pageIsVisible(tabId)
    // `undefined` is a page scripts cannot run in -- usually one that did not load. The capture
    // itself reports that properly, so it is not a reason to wait here.
    if (visible !== false) break
    // The first second is the window coming forward; only after that is it worth interrupting anyone.
    if (!paused && attempt >= 2) {
      paused = true
      setRowState(row, row.state, 'Paused: the capture window is covered or minimised')
      showStatus('Paused. Bring the PageShotter capture window to the front and the batch carries on by itself.', true)
    }
    if (stopRequested) throw new StoppedWhilePaused()
    await assertTabOpen(tabId)
    await sleep(500)
  }
  if (paused) hideStatus()
}

async function pageIsVisible(tabId: number): Promise<boolean | undefined> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState === 'visible',
    })
    return result?.result === true
  } catch {
    return undefined
  }
}

async function assertTabOpen(tabId: number): Promise<void> {
  try {
    await chrome.tabs.get(tabId)
  } catch {
    throw new BatchAbort('The capture window was closed, so the batch stopped.')
  }
}

async function captureInWorker(tabId: number, mode: BatchMode): Promise<CaptureJob> {
  const request: RuntimeRequest = { type: 'START_BATCH_CAPTURE', tabId, mode }
  const started = (await chrome.runtime.sendMessage(request)) as RuntimeResponse
  if (!started.ok) throw new CaptureFailure(started.error.code, failureText(started.error.code, started.error.message))
  const jobId = started.jobId as string
  for (;;) {
    await sleep(JOB_POLL_MS)
    const response = (await chrome.runtime.sendMessage({ type: 'GET_JOB', jobId } satisfies RuntimeRequest)) as RuntimeResponse
    if (!response.ok) throw new CaptureFailure(response.error.code, failureText(response.error.code, response.error.message))
    const job = response.job
    if (job === undefined) throw new Error('The capture disappeared before it finished.')
    if (job.status === 'capturing') {
      if (job.progress.estimatedTotal > 1) {
        const row = rows.find((candidate) => candidate.state === 'capturing')
        if (row) setRowState(row, 'capturing', `Capturing, section ${job.progress.current} of about ${job.progress.estimatedTotal}`)
      }
      continue
    }
    if (job.status === 'complete') return job
    throw new CaptureFailure(job.error?.code, failureText(job.error?.code, job.error?.message ?? 'The capture did not finish.'))
  }
}

/**
 * The batch's half of what the result page does with a finished capture: assemble it, keep it in
 * History, and save the file -- with the export settings the result page would have opened on.
 */
async function saveJob(job: CaptureJob, row: Row, run: Run): Promise<number | undefined> {
  const segments = await getSegments(job.id)
  const image = await buildTiledImage(segments, job.finalDocumentHeight ?? segments.at(-1)?.documentHeight ?? 0)
  // Segments are only discarded once the tiles that replace them exist.
  await deleteCapture(job.id).catch(() => undefined)
  // Best-effort, as on the result page: the file below is the batch's real output.
  const kept = await saveCaptureToHistory(job, image).catch(() => false)
  const captured = kept ? 'Captured and kept in History' : 'Captured'

  let blob: Blob
  try {
    if (run.format === 'pdf') {
      const hasContent = job.pageContent !== undefined
      const pdf = run.preferences.pdf
      blob = await createPdfBlob(
        { image, content: job.pageContent, imageOrigin: job.imageOrigin, imageScale: job.imageScale },
        undefined,
        { ...pdf, directLinks: pdf.directLinks && hasContent, textSearchable: pdf.textSearchable && hasContent },
      )
    } else {
      blob = await encodeImage(run.format, image, undefined, run.preferences.jpegQuality / 100, run.preferences.scale)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${captured}, but the ${FORMAT_LABELS[run.format]} could not be made. ${reason}`, { cause: error })
  }

  const name = batchFilename(
    row.position,
    run.total,
    suggestedFilename({
      title: job.title,
      url: job.url,
      capturedAt: new Date(job.createdAt),
      extension: exportFileExtension(run.format),
    }),
  )
  const url = URL.createObjectURL(blob)
  try {
    const id = await chrome.downloads.download({ url, filename: downloadPath(run.folder, name), conflictAction: 'uniquify' })
    const outcome = await waitForDownloadCompletion(chrome.downloads as unknown as DownloadsApi, id)
    if (outcome === 'interrupted') throw new Error(`${captured}, but the download was interrupted.`)
    return id
  } finally {
    // Chrome reads the object URL after `download()` resolves; revoking early writes an empty file.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

function savedDescription(job: CaptureJob, loaded: boolean): string {
  const notes: string[] = []
  if (!loaded) notes.push('captured before it finished loading')
  if (job.stoppedEarly) notes.push('stopped early')
  if (job.truncated) notes.push('longer than one capture reaches, so the bottom is cut')
  if (job.endlessPage) notes.push('kept growing, so it was cut at your long-page setting')
  if (job.deadlineReached) notes.push('took too long, so it was cut')
  return notes.length === 0 ? 'Saved' : `Saved, ${notes.join('; ')}`
}

/**
 * In a batch, "extensions aren't allowed on this page" nearly always means the page never loaded:
 * the browser's own error page is one extensions may not touch. Saying only the first would send
 * someone looking for a setting when the address is what is wrong.
 */
function failureText(code: string | undefined, message: string): string {
  if (code === 'RESTRICTED_PAGE') {
    return `The page didn't load, or ${BROWSER.name} doesn't let extensions capture it. Check the address and retry.`
  }
  return message
}

function createRow(url: string, position: number): Row {
  const element = document.createElement('li')
  const number = document.createElement('span')
  number.className = 'position'
  number.textContent = String(position)
  const page = document.createElement('span')
  page.className = 'page'
  const address = document.createElement('span')
  address.className = 'address'
  address.textContent = url
  address.title = url
  const stateText = document.createElement('span')
  stateText.className = 'state'
  page.append(address, stateText)
  const retry = document.createElement('button')
  retry.className = 'btn'
  retry.type = 'button'
  retry.textContent = 'Retry'
  retry.hidden = true
  element.append(number, page, retry)
  const row: Row = { url, position, state: 'waiting', element, stateText, retry }
  retry.addEventListener('click', () => {
    if (!running) requestAccessThenRun([row])
  })
  setRowState(row, 'waiting', 'Waiting')
  return row
}

function setRowState(row: Row, state: RowState, text: string): void {
  row.state = state
  row.element.dataset.state = state
  row.element.dataset.active = String(state === 'loading' || state === 'rendering' || state === 'capturing' || state === 'saving')
  row.stateText.textContent = text
  row.retry.hidden = running || (state !== 'failed' && state !== 'skipped')
}

function setRunning(on: boolean): void {
  urlsInput.disabled = on
  for (const control of formControls()) control.disabled = on
  startButton.hidden = on
  stopButton.hidden = !on
  stopButton.disabled = false
  for (const row of rows) row.retry.hidden = on || (row.state !== 'failed' && row.state !== 'skipped')
  retryFailedButton.hidden = on || !rows.some((row) => row.state === 'failed' || row.state === 'skipped')
  drawSummary()
}

function formControls(): (HTMLInputElement | HTMLSelectElement)[] {
  return [
    ...modeGroup.querySelectorAll('input'),
    ...formatGroup.querySelectorAll('input'),
    loadTimeoutSelect,
    renderWaitSelect,
    subfolderSwitch,
    showFolderSwitch,
  ]
}

async function focusThisPage(): Promise<void> {
  const own = await chrome.windows.getCurrent().catch(() => undefined)
  if (own?.id !== undefined) await chrome.windows.update(own.id, { focused: true }).catch(() => undefined)
}

function showStatus(message: string, problem = false): void {
  batchStatus.textContent = message
  batchStatus.dataset.state = problem ? 'problem' : 'done'
  batchStatus.hidden = false
}

function hideStatus(): void {
  batchStatus.hidden = true
}

function appendSegment(group: HTMLElement, name: string, value: string, label: string): void {
  const item = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = name
  input.value = value
  const text = document.createElement('span')
  text.textContent = label
  item.append(input, text)
  group.append(item)
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  select.append(option)
}

function checkRadio(group: HTMLElement, value: string): void {
  for (const input of group.querySelectorAll<HTMLInputElement>('input')) input.checked = input.value === value
}

function checkedValue(group: HTMLElement): string | undefined {
  return group.querySelector<HTMLInputElement>('input:checked')?.value
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element as T
}
