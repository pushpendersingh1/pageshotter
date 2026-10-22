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
import { takeHandoff, type BatchHandoff } from './batch-handoff'
import { BATCH_SKIP_KEY, BATCH_STOP_KEY, clearStatus, readSkip, writeStatus } from './batch-status'
import { filledSegments, segmentCount } from '../popup/progress-bar'
import {
  BATCH_PERMISSIONS,
  LOAD_TIMEOUT_CHOICES,
  RENDER_WAIT_CHOICES,
  batchFilename,
  batchFolder,
  batchFolderName,
  batchSource,
  getBatchOptions,
  parseBatchUrls,
  setBatchOptions,
  siteCount,
  tabCapturable,
  type BatchMode,
  type BatchOptions,
  type BatchSource,
} from './batch-plan'

void applyStoredTheme(document.documentElement)
wireThemeButton(requiredElement<HTMLButtonElement>('theme'), document.documentElement)

const sourceGroup = requiredElement<HTMLElement>('batch-source')
const urlsPanel = requiredElement<HTMLElement>('urls-panel')
const tabsPanel = requiredElement<HTMLElement>('tabs-panel')
const tabList = requiredElement<HTMLUListElement>('tab-list')
const tabSummary = requiredElement<HTMLParagraphElement>('tab-summary')
const tabsAccessButton = requiredElement<HTMLButtonElement>('tabs-access')
const tabsAllButton = requiredElement<HTMLButtonElement>('tabs-all')
const tabsNoneButton = requiredElement<HTMLButtonElement>('tabs-none')
const startDialogHow = requiredElement<HTMLParagraphElement>('start-dialog-how')
const startTour = requiredElement<HTMLElement>('start-tour')
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
const backButton = requiredElement<HTMLButtonElement>('back-to-capture')
const skipButton = requiredElement<HTMLButtonElement>('skip')
const nowCard = requiredElement<HTMLElement>('now')
const nowCount = requiredElement<HTMLElement>('now-count')
const nowTally = requiredElement<HTMLElement>('now-tally')
const nowTitle = requiredElement<HTMLElement>('now-title')
const nowAddress = requiredElement<HTMLElement>('now-address')
const nowSteps = requiredElement<HTMLOListElement>('now-steps')
const nowBar = requiredElement<HTMLElement>('now-bar')
const rowMarks = requiredElement<HTMLTemplateElement>('row-marks')
const startDialog = requiredElement<HTMLDialogElement>('start-dialog')
const startConfirm = requiredElement<HTMLButtonElement>('start-confirm')
const startCancel = requiredElement<HTMLButtonElement>('start-cancel')

const FORMAT_LABELS: Record<ExportFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', pdf: 'PDF' }
const MODE_LABELS: Record<BatchMode, string> = { full: 'Full page', visible: 'Visible part' }
/**
 * A backstop, not the mechanism. The worker announces each settled capture, and this page waits on
 * that announcement: while a batch runs this is a background tab, and a background tab's timers are
 * throttled -- to once a minute, after a few minutes. The poll only covers a worker that restarted
 * mid-capture and so never announced anything.
 */
const JOB_BACKSTOP_MS = 5_000
const PAGE_TITLE = document.title

type RowState = 'waiting' | 'loading' | 'rendering' | 'capturing' | 'saving' | 'saved' | 'failed' | 'skipped'

interface Row {
  url: string
  title: string
  /** Set for a tab that was already open: it is captured where it is, and never closed. */
  tabId?: number
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

/**
 * Stop or Skip was pressed: whatever was waiting gives up, and the page in hand is not saved. Which
 * one decides only whether the batch then carries on.
 */
class Stopped extends Error {}

/** The tab a page was in went away while it waited its turn or loaded. */
class TabClosed extends Error {}

/** A capture that failed, with the worker's code kept. */
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
/** Skip was pressed for the page in hand. Cleared as each page starts, so it never reaches the next. */
let skipRequested = false
/** The page being worked on, so a skip can be checked against the page it was meant for. */
let currentRow: Row | undefined
let settingsFormat: ExportFormat = 'png'
let source: BatchSource = batchSource(location.search)
/** The tab the current page is loading or being captured in, and its capture once started. */
let captureTabId: number | undefined
/** The tab this page opened for an address, which it closes again. Never an open tab it was given. */
let openedTabId: number | undefined
let currentJobId: string | undefined
/** The rows the running batch was started with, and this page's own tab: what the popup is told. */
let runRows: Row[] = []
let ownTabId: number | undefined
/** What the start dialog will run once confirmed: a fresh list, or rows being retried. */
let pendingRows: Row[] | 'new' = 'new'
/** Every tab listed, in window order, and whether each one is ticked -- kept across redraws. */
let tabEntries: TabEntry[] = []
const tabTicks = new Map<number, boolean>()
/** The tabs the popup ticked, when it opened this page; every other tab starts unticked. */
let handedTabs: Set<number> | undefined
let tabRefresh: number | undefined

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
  if (info.title !== undefined || info.url !== undefined || info.discarded !== undefined) scheduleTabRefresh()
})
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLoads.delete(tabId)
  closedTabs.add(tabId)
  for (const wake of loadWaiters) wake()
  scheduleTabRefresh()
})
for (const event of [chrome.tabs.onCreated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached]) {
  ;(event as chrome.events.Event<() => void>).addListener(scheduleTabRefresh)
}

const settledJobs = new Set<string>()
const settleWaiters = new Set<() => void>()
chrome.runtime.onMessage.addListener((message: { type?: unknown; jobId?: unknown }) => {
  if (message?.type !== 'BATCH_JOB_SETTLED' || typeof message.jobId !== 'string') return
  settledJobs.add(message.jobId)
  for (const wake of settleWaiters) wake()
  // Nothing is returned: this page never answers a message, so it cannot take anyone's reply.
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

  const handoff = takeHandoffSafely()
  if (handoff) {
    source = handoff.source
    urlsInput.value = handoff.urls
    if (handoff.source === 'tabs') handedTabs = new Set(handoff.tabIds)
  }

  checkRadio(sourceGroup, source)
  sourceGroup.addEventListener('change', () => {
    source = checkedValue(sourceGroup) === 'tabs' ? 'tabs' : 'urls'
    // Kept in the address, so a reload comes back to the same list.
    history.replaceState(null, '', source === 'tabs' ? '?source=tabs' : location.pathname)
    drawSource()
  })
  urlsInput.addEventListener('input', drawSummary)
  tabsAccessButton.addEventListener('click', requestAccessForTabs)
  tabsAllButton.addEventListener('click', () => tickAllTabs(true))
  tabsNoneButton.addEventListener('click', () => tickAllTabs(false))
  startButton.addEventListener('click', () => {
    if (running || pageCount() === 0) return
    askToStart('new')
  })
  stopButton.addEventListener('click', stop)
  skipButton.addEventListener('click', skip)
  retryFailedButton.addEventListener('click', () => {
    const failed = rows.filter((row) => row.state === 'failed' || row.state === 'skipped')
    if (failed.length > 0) askToStart(failed)
  })
  startConfirm.addEventListener('click', onConfirmStart)
  startCancel.addEventListener('click', () => startDialog.close())
  backButton.addEventListener('click', () => {
    if (captureTabId !== undefined) void chrome.tabs.update(captureTabId, { active: true }).catch(() => undefined)
  })
  document.addEventListener('visibilitychange', drawPausedNotice)

  // A batch in progress is lost if this tab goes. Browsers show their own wording for this; asking
  // is what matters.
  window.addEventListener('beforeunload', (event) => {
    if (running) event.preventDefault()
  })
  // Gone is gone, so the popup and the toolbar must stop reporting a batch that is no longer running.
  window.addEventListener('pagehide', () => {
    if (running) endProgress()
  })
  // Stop pressed in the popup, which is open over the page being captured rather than over this one.
  window.addEventListener('storage', (event) => {
    if (event.key === BATCH_STOP_KEY && event.newValue !== null && running && !stopRequested) stop()
    // Pressed against a page that has since finished, it is ignored rather than spent on the next one.
    if (event.key === BATCH_SKIP_KEY && readSkip(event.newValue) === currentRow?.position) skip()
  })

  drawSource()
  drawSubfolderNote()
  await drawAccessNote()
  for (const event of [chrome.permissions.onAdded, chrome.permissions.onRemoved]) {
    event.addListener(() => {
      void drawAccessNote()
      scheduleTabRefresh()
    })
  }

  // The popup already chose the pages, so this page opens on the step that is left: confirming.
  if (handoff) {
    if (source === 'tabs') await refreshTabs()
    if (pageCount() > 0) askToStart('new')
  }
}

function takeHandoffSafely(): BatchHandoff | undefined {
  try {
    return takeHandoff(localStorage, Date.now())
  } catch {
    return undefined
  }
}

function drawSource(): void {
  urlsPanel.hidden = source !== 'urls'
  tabsPanel.hidden = source !== 'tabs'
  startTour.dataset.source = source
  startDialogHow.textContent =
    source === 'tabs'
      ? 'PageShotter brings each tab you picked to the front, one at a time, and captures it.'
      : 'PageShotter opens each page in a tab beside this one, one at a time, and captures it.'
  drawSummary()
  scheduleTabRefresh()
}

/** How many pages Start would capture from the source on screen. */
function pageCount(): number {
  return source === 'urls' ? parseBatchUrls(urlsInput.value).urls.length : pickedTabs().length
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
  startButton.disabled = running || pageCount() === 0
}

interface TabEntry {
  tab: chrome.tabs.Tab
  element: HTMLLIElement
  checkbox: HTMLInputElement
  title: HTMLSpanElement
  address: HTMLSpanElement
}

/**
 * Tabs open, close, move and change title all the time; the list follows them, a moment later, so a
 * page loading in the background redraws it once rather than on every step of its load.
 */
function scheduleTabRefresh(): void {
  if (source !== 'tabs' || running || tabRefresh !== undefined) return
  tabRefresh = window.setTimeout(() => {
    tabRefresh = undefined
    void refreshTabs()
  }, 150)
}

/**
 * A tab's address and title are only readable with access to its site, so without the access batch
 * capture already asks for there is nothing to list -- and asking here, on a button, is what lets
 * someone see their tabs before deciding.
 */
async function refreshTabs(): Promise<void> {
  if (source !== 'tabs' || running) return
  const granted = await chrome.permissions.contains(BATCH_PERMISSIONS).catch(() => false)
  const own = await chrome.tabs.getCurrent().catch(() => undefined)
  tabsAccessButton.hidden = granted
  tabsAllButton.hidden = !granted
  tabsNoneButton.hidden = !granted
  if (!granted || own === undefined) {
    tabEntries = []
    tabList.replaceChildren()
    tabList.hidden = true
    tabSummary.textContent = granted
      ? 'This page could not find its own window.'
      : `To list this window's tabs, PageShotter needs the access to all websites that batch capture uses. Nothing is uploaded.`
    drawSummary()
    return
  }
  const tabs = await chrome.tabs.query({ windowId: own.windowId }).catch(() => [])
  const previous = new Map(tabEntries.map((entry) => [entry.tab.id, entry]))
  tabEntries = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== own.id)
    .map((tab) => drawTabEntry(tab, previous.get(tab.id)))
  const elements = tabEntries.map((entry) => entry.element)
  // Only rebuilt when the tabs themselves changed, so a title update does not steal focus.
  const children = [...tabList.children]
  if (children.length !== elements.length || children.some((child, index) => child !== elements[index])) {
    tabList.replaceChildren(...elements)
  }
  tabList.hidden = tabEntries.length === 0
  drawTabSummary()
}

function drawTabEntry(tab: chrome.tabs.Tab, entry: TabEntry | undefined): TabEntry {
  const id = tab.id as number
  if (entry === undefined) {
    const element = document.createElement('li')
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    const page = document.createElement('span')
    page.className = 'page'
    const title = document.createElement('span')
    title.className = 'address'
    const address = document.createElement('span')
    address.className = 'state'
    page.append(title, address)
    label.append(checkbox, page)
    element.append(label)
    checkbox.addEventListener('change', () => {
      tabTicks.set(id, checkbox.checked)
      drawTabSummary()
    })
    entry = { tab, element, checkbox, title, address }
  }
  entry.tab = tab
  const capturable = tabCapturable(tab.url)
  // Without its address the tab is one PageShotter has no access to: a browser or extension page.
  entry.title.textContent = tab.title || tab.url || "A page PageShotter can't read"
  entry.address.textContent = capturable ? (tab.url as string) : "Can't be captured"
  entry.title.title = tab.url ?? ''
  entry.checkbox.disabled = !capturable
  entry.checkbox.checked = capturable && (tabTicks.get(id) ?? handedTabs?.has(id) ?? true)
  return entry
}

function pickedTabs(): TabEntry[] {
  return tabEntries.filter((entry) => entry.checkbox.checked && !entry.checkbox.disabled)
}

function tickAllTabs(on: boolean): void {
  for (const entry of tabEntries) {
    if (entry.checkbox.disabled) continue
    entry.checkbox.checked = on
    tabTicks.set(entry.tab.id as number, on)
  }
  drawTabSummary()
}

function drawTabSummary(): void {
  const offered = tabEntries.filter((entry) => !entry.checkbox.disabled).length
  const refused = tabEntries.length - offered
  const parts = [
    tabEntries.length === 0
      ? 'There are no other tabs in this window.'
      : `${pickedTabs().length} of ${plural(offered, 'tab')} picked.`,
  ]
  if (refused > 0) parts.push(`${plural(refused, 'tab')} can't be captured.`)
  tabSummary.textContent = parts.join(' ')
  drawSummary()
}

/** Synchronous in the click, for the same reason as Start's request: Firefox allows it nowhere else. */
function requestAccessForTabs(): void {
  void chrome.permissions
    .request(BATCH_PERMISSIONS)
    .catch(() => false)
    .then(() => {
      void drawAccessNote()
      void refreshTabs()
    })
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
 * Says up front what a batch needs from the person running it, before it takes over their tab.
 *
 * The page being captured has to be the one on screen: a browser draws nothing for a tab that is
 * not showing, and a screenshot is of what it draws. Leaving it does not lose anything -- the
 * capture pauses and carries on when they come back -- but someone who was not told would read a
 * batch sitting still as a batch that broke.
 */
function askToStart(selected: Row[] | 'new'): void {
  pendingRows = selected
  startDialog.showModal()
  startConfirm.focus()
}

/**
 * The permission request comes first and synchronously. Firefox honours `permissions.request` only
 * inside the click that asked for it, and anything awaited before the call can end that window --
 * which is why it happens here, on the dialog's button, and not after it closes.
 */
function onConfirmStart(): void {
  startDialog.close()
  if (running) return
  let selected: Row[]
  if (pendingRows === 'new') {
    const pages =
      source === 'urls'
        ? parseBatchUrls(urlsInput.value).urls.map((url) => ({ url, title: url, tabId: undefined }))
        : pickedTabs().map(({ tab }) => ({ url: tab.url as string, title: tab.title || (tab.url as string), tabId: tab.id }))
    if (pages.length === 0) return
    currentRun = undefined
    rows = pages.map((page, index) => createRow(page.url, page.title, index + 1, page.tabId))
    report.replaceChildren(...rows.map((row) => row.element))
    reportGroup.hidden = false
    selected = rows
  } else {
    selected = pendingRows
  }
  requestAccessThenRun(selected)
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

/**
 * Stops now rather than after the page in hand: while anyone is on this tab to press it, that page
 * is not on screen and its capture is paused, so "after this page" would mean "never".
 */
function stop(): void {
  stopRequested = true
  stopButton.disabled = true
  publishProgress()
  interruptCurrent()
}

/** Gives up on the page in hand and goes on to the next one. */
function skip(): void {
  if (!running || stopRequested || currentRow === undefined || skipRequested) return
  skipRequested = true
  publishProgress()
  interruptCurrent()
}

function interruptCurrent(): void {
  for (const wake of loadWaiters) wake()
  if (currentJobId !== undefined) {
    void chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE', jobId: currentJobId } satisfies RuntimeRequest).catch(() => undefined)
  }
}

/** Whether the page in hand should give up: the batch is stopping, or this page was skipped. */
function interrupted(): boolean {
  return stopRequested || skipRequested
}

/** Shown only while someone is looking at this tab mid-batch, which is exactly when it is true. */
function drawPausedNotice(): void {
  const here = running && document.visibilityState === 'visible'
  backButton.hidden = !here || captureTabId === undefined
  if (here) {
    showStatus(
      'The page being captured is paused while you are on this tab. Go back to it to carry on, or press Stop.',
      true,
    )
  } else if (running) {
    hideStatus()
  }
}

async function runBatch(selected: Row[]): Promise<void> {
  running = true
  stopRequested = false
  setRunning(true)
  hideStatus()
  // The options and the list above it are done with; what matters now is the page in hand.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  reportGroup.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
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

  let lastDownloadId: number | undefined
  let abortMessage: string | undefined
  const own = await chrome.tabs.getCurrent().catch(() => undefined)
  runRows = selected
  ownTabId = own?.id
  publishProgress()
  try {
    if (own?.id === undefined) throw new BatchAbort('This page could not find its own tab.')
    for (const [index, row] of selected.entries()) {
      if (stopRequested) break
      document.title = `(${index + 1}/${selected.length}) ${PAGE_TITLE}`
      const downloadId = await captureRow(row, run, own)
      if (downloadId !== undefined) lastDownloadId = downloadId
    }
  } catch (error) {
    abortMessage = error instanceof Error ? error.message : String(error)
  } finally {
    if (openedTabId !== undefined) await chrome.tabs.remove(openedTabId).catch(() => undefined)
    openedTabId = undefined
    captureTabId = undefined
    currentJobId = undefined
    for (const row of selected) {
      if (row.state === 'waiting') setRowState(row, 'skipped', 'Not captured: the batch stopped first')
    }
    running = false
    endProgress()
    setRunning(false)
    document.title = PAGE_TITLE
    backButton.hidden = true
    if (own?.id !== undefined) await chrome.tabs.update(own.id, { active: true }).catch(() => undefined)
    scheduleTabRefresh()
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
 * One page, start to finish: an address in a fresh tab beside this one, or an open tab where it is.
 *
 * Returns the download's id, so the folder can be shown at the end.
 */
async function captureRow(row: Row, run: Run, own: chrome.tabs.Tab): Promise<number | undefined> {
  skipRequested = false
  currentRow = row
  setRowState(row, 'loading', row.tabId === undefined ? 'Loading' : 'Switching to it')
  try {
    const { tabId, loaded } = row.tabId === undefined ? await openPage(row, run, own) : await showTab(row.tabId, run)
    if (run.options.renderWaitMs > 0) {
      setRowState(row, 'rendering', 'Letting it render')
      await sleepUnlessInterrupted(run.options.renderWaitMs)
    }
    if (closedTabs.has(tabId)) throw new TabClosed()

    setRowState(row, 'capturing', 'Capturing')
    const job = await captureInWorker(tabId, run.options.mode, row.tabId !== undefined)
    // A capture stopped partway is kept by the worker as a partial, which is right for a single
    // capture and wrong here: Stop and Skip in a batch both mean "not this one either".
    if (interrupted()) {
      await deleteCapture(job.id).catch(() => undefined)
      throw new Stopped()
    }
    setRowState(row, 'saving', 'Saving')
    const downloadId = await saveJob(job, row, run)
    setRowState(row, 'saved', savedDescription(job, loaded))
    return downloadId
  } catch (error) {
    // Closing the tab a listed address was opened in is how someone stops a batch by hand; closing
    // one of their own tabs is only a change of mind about that tab.
    if (error instanceof TabClosed && row.tabId !== undefined) {
      setRowState(row, 'failed', 'The tab was closed, so it was not captured.')
      return undefined
    }
    if (error instanceof TabClosed || error instanceof BatchAbort) {
      const abort = error instanceof BatchAbort ? error : new BatchAbort('The tab being captured was closed, so the batch stopped.')
      setRowState(row, 'failed', abort.message)
      throw abort
    }
    if (error instanceof Stopped || (interrupted() && error instanceof CaptureFailure)) {
      setRowState(row, 'skipped', stopRequested ? 'Not captured: stopped' : 'Skipped')
      return undefined
    }
    setRowState(row, 'failed', error instanceof Error ? error.message : String(error))
    return undefined
  } finally {
    currentJobId = undefined
    currentRow = undefined
    skipRequested = false
  }
}

/**
 * An address, in a fresh tab beside this one; the previous page's tab is closed.
 *
 * A fresh tab rather than navigating one tab through the list, because it makes a page that never
 * answered unmistakable: the tab is still on its blank first document, which refuses the content
 * script, so the page is reported as not loaded. Navigating a single tab would still be showing the
 * *previous* page, and would save it under this page's number.
 */
async function openPage(row: Row, run: Run, own: chrome.tabs.Tab): Promise<{ tabId: number; loaded: boolean }> {
  const previousTabId = openedTabId
  const tab = await chrome.tabs.create({ windowId: own.windowId, index: own.index + 1, url: row.url, active: true })
  const tabId = tab.id as number
  captureTabId = openedTabId = tabId
  if (previousTabId !== undefined) await chrome.tabs.remove(previousTabId).catch(() => undefined)
  const loaded = await waitForLoad(tabId, run.options.loadTimeoutMs, () => tabLoads.get(tabId)?.complete === true)
  return { tabId, loaded }
}

/**
 * An open tab, brought to the front as it is. One the browser put to sleep, or one still loading,
 * loads first under the same limit as an address; one already loaded is captured straight away.
 *
 * Asked of the tab rather than learnt from its events: it may have finished loading long before
 * this page was there to hear it.
 */
async function showTab(tabId: number, run: Run): Promise<{ tabId: number; loaded: boolean }> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined || closedTabs.has(tabId)) throw new TabClosed()
  // The tab may have moved on to a page that refuses extensions since it was listed.
  if (!tabCapturable(tab.url)) throw new CaptureFailure('RESTRICTED_PAGE', failureText('RESTRICTED_PAGE', '', true))
  captureTabId = tabId
  await chrome.tabs.update(tabId, { active: true })
  const ready = (): Promise<boolean> =>
    chrome.tabs.get(tabId).then(
      (current) => current.status === 'complete' && !current.discarded,
      () => false,
    )
  const loaded = await waitForLoad(tabId, run.options.loadTimeoutMs, ready)
  return { tabId, loaded }
}

/** `true` when the page said it had loaded, `false` when the limit came first. */
function waitForLoad(tabId: number, timeoutMs: number, ready: () => boolean | Promise<boolean>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      loadWaiters.delete(check)
      if (timer !== undefined) window.clearTimeout(timer)
      settle()
    }
    function check(): void {
      if (interrupted()) finish(() => reject(new Stopped()))
      else if (closedTabs.has(tabId)) finish(() => reject(new TabClosed()))
      else {
        void Promise.resolve(ready()).then((isReady) => {
          if (isReady) finish(() => resolve(true))
        })
      }
    }
    if (timeoutMs > 0) timer = window.setTimeout(() => finish(() => resolve(false)), timeoutMs)
    loadWaiters.add(check)
    check()
  })
}
/** The render wait, cut short by Stop. A single timer, so a background tab's throttling barely touches it. */
function sleepUnlessInterrupted(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      loadWaiters.delete(onWake)
      window.clearTimeout(timer)
      if (interrupted()) reject(new Stopped())
      else resolve()
    }
    // Woken by every tab update as well as by Stop and Skip, so only those two end it early.
    const onWake = (): void => {
      if (interrupted()) finish()
    }
    const timer = window.setTimeout(finish, ms)
    loadWaiters.add(onWake)
  })
}

async function captureInWorker(tabId: number, mode: BatchMode, openTab: boolean): Promise<CaptureJob> {
  const request: RuntimeRequest = { type: 'START_BATCH_CAPTURE', tabId, mode }
  const started = (await chrome.runtime.sendMessage(request)) as RuntimeResponse
  if (!started.ok) throw new CaptureFailure(started.error.code, failureText(started.error.code, started.error.message, openTab))
  const jobId = started.jobId as string
  currentJobId = jobId
  // Stop or Skip may have been pressed while the request was in flight, before there was a job to cancel.
  if (interrupted()) interruptCurrent()
  for (;;) {
    await settledOrBackstop(jobId)
    const response = (await chrome.runtime.sendMessage({ type: 'GET_JOB', jobId } satisfies RuntimeRequest)) as RuntimeResponse
    if (!response.ok) throw new CaptureFailure(response.error.code, failureText(response.error.code, response.error.message, openTab))
    const job = response.job
    if (job === undefined) throw new Error('The capture disappeared before it finished.')
    if (job.status === 'capturing') continue
    if (job.status === 'complete') return job
    throw new CaptureFailure(job.error?.code, failureText(job.error?.code, job.error?.message ?? 'The capture did not finish.', openTab))
  }
}

function settledOrBackstop(jobId: string): Promise<void> {
  return new Promise((resolve) => {
    const wake = (): void => {
      // Not Stop: it cancels the capture, and the cancelled capture then settles like any other.
      if (!settledJobs.has(jobId) && !expired) return
      settleWaiters.delete(wake)
      window.clearTimeout(timer)
      resolve()
    }
    let expired = false
    const timer = window.setTimeout(() => {
      expired = true
      wake()
    }, JOB_BACKSTOP_MS)
    settleWaiters.add(wake)
    wake()
  })
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
        // No yield between pages: nobody is watching this tab while a batch runs, and a background
        // tab's throttled timers would turn each yield into a long wait.
        () => Promise.resolve(),
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
function failureText(code: string | undefined, message: string, openTab: boolean): string {
  if (code === 'RESTRICTED_PAGE') {
    // An open tab was never loaded by the batch, so the address is not the thing to check.
    return openTab
      ? `${BROWSER.name} doesn't let extensions capture this page. Its own pages and error pages are among them.`
      : `The page didn't load, or ${BROWSER.name} doesn't let extensions capture it. Check the address and retry.`
  }
  return message
}

function createRow(url: string, title: string, position: number, tabId?: number): Row {
  const element = document.createElement('li')
  // The number while the row waits; a turning ring, a tick, a cross or a skip mark once it has a state.
  const number = document.createElement('span')
  number.className = 'position'
  const digits = document.createElement('span')
  digits.className = 'num'
  digits.textContent = String(position)
  number.append(digits, rowMarks.content.cloneNode(true))
  const page = document.createElement('span')
  page.className = 'page'
  const address = document.createElement('span')
  address.className = 'address'
  address.textContent = title
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
  const row: Row = { url, title, tabId, position, state: 'waiting', element, stateText, retry }
  retry.addEventListener('click', () => {
    if (!running) askToStart([row])
  })
  setRowState(row, 'waiting', 'Waiting')
  return row
}

function setRowState(row: Row, state: RowState, text: string): void {
  row.state = state
  row.element.dataset.state = state
  row.element.dataset.active = String(isActive(state))
  row.stateText.textContent = text
  row.retry.hidden = running || (state !== 'failed' && state !== 'skipped')
  if (running) publishProgress()
}

function isActive(state: RowState): boolean {
  return state === 'loading' || state === 'rendering' || state === 'capturing' || state === 'saving'
}

/**
 * Where the batch has got to, for the popup and the toolbar icon. Both are looked at from the page
 * being captured, which is the one place this page cannot be seen from.
 */
function publishProgress(): void {
  drawNow()
  if (ownTabId === undefined || runRows.length === 0) return
  const done = finishedRows().length
  const current = currentRunRow()
  const skippable = skippableRow()
  try {
    writeStatus(localStorage, {
      tabId: ownTabId,
      source,
      total: runRows.length,
      done,
      current: current === undefined ? '' : current.title || current.url,
      currentPosition: skippable?.position ?? 0,
      stopping: stopRequested,
    })
  } catch {
    // The popup then shows its usual buttons; the batch, and this page's own list, carry on.
  }
  void chrome.runtime
    .sendMessage({ type: 'BATCH_PROGRESS', done, total: runRows.length } satisfies RuntimeRequest)
    .catch(() => undefined)
}

function finishedRows(): Row[] {
  return runRows.filter((row) => row.state === 'saved' || row.state === 'failed' || row.state === 'skipped')
}

function currentRunRow(): Row | undefined {
  return runRows.find((row) => isActive(row.state))
}

/**
 * The page Skip would give up on. Offered only while there is one, it has not been skipped already,
 * and it is not already being saved: by then there is nothing left to save time on.
 */
function skippableRow(): Row | undefined {
  const current = currentRunRow()
  return current !== undefined && current.state !== 'saving' && !skipRequested && !stopRequested ? current : undefined
}

const STEPS: readonly RowState[] = ['loading', 'rendering', 'capturing', 'saving']

/** The card at the top of Progress: the page in hand, its steps, and the batch so far. */
function drawNow(): void {
  const total = runRows.length
  const current = currentRunRow()
  const saved = runRows.filter((row) => row.state === 'saved').length
  const notSaved = runRows.filter((row) => row.state === 'failed' || row.state === 'skipped').length
  const done = saved + notSaved

  nowCount.textContent =
    current !== undefined ? `Page ${runRows.indexOf(current) + 1} of ${total}` : total > 0 ? `${done} of ${total} done` : ''
  nowTally.textContent = [saved > 0 ? `${saved} saved` : '', notSaved > 0 ? `${notSaved} not saved` : '']
    .filter(Boolean)
    .join(' · ')
  nowTitle.textContent = stopRequested ? 'Stopping' : current !== undefined ? current.title || current.url : 'Starting the next page'
  // An address typed in has no title of its own until it loads, so its address line would only repeat it.
  const address = current !== undefined && !stopRequested && current.title !== current.url ? current.url.replace(/^https?:\/\//, '') : ''
  nowAddress.textContent = address
  nowAddress.title = current?.url ?? ''

  // Steps before the one in hand are done; a render wait of none is not a step at all.
  const at = current === undefined ? -1 : STEPS.indexOf(current.state)
  for (const item of nowSteps.querySelectorAll<HTMLLIElement>('li')) {
    const index = STEPS.indexOf(item.dataset.step as RowState)
    item.dataset.at = index < at ? 'done' : index === at ? 'now' : ''
    if (item.dataset.step === 'rendering') item.hidden = currentRun?.options.renderWaitMs === 0
  }

  const segments = segmentCount(total)
  if (nowBar.children.length !== segments) {
    nowBar.replaceChildren(...Array.from({ length: segments }, () => Object.assign(document.createElement('span'), { className: 'tick' })))
  }
  const filled = filledSegments(done, total, segments)
  const working = current !== undefined ? filledSegments(done + 1, total, segments) : filled
  for (const [index, segment] of [...nowBar.children].entries()) {
    segment.className = `tick${index < filled ? ' done' : index < working ? ' now' : ''}`
  }
  nowBar.setAttribute('aria-valuemin', '0')
  nowBar.setAttribute('aria-valuemax', String(total))
  nowBar.setAttribute('aria-valuenow', String(done))

  skipButton.disabled = skippableRow() === undefined
}

function endProgress(): void {
  runRows = []
  try {
    clearStatus(localStorage)
  } catch {
    // Nothing was written, or nothing can be: either way nothing is left to report.
  }
  void chrome.runtime.sendMessage({ type: 'BATCH_FINISHED' } satisfies RuntimeRequest).catch(() => undefined)
}

function setRunning(on: boolean): void {
  urlsInput.disabled = on
  for (const entry of tabEntries) entry.checkbox.disabled = on || !tabCapturable(entry.tab.url)
  tabsAllButton.disabled = on
  tabsNoneButton.disabled = on
  for (const control of formControls()) control.disabled = on
  startButton.hidden = on
  nowCard.hidden = !on
  stopButton.disabled = false
  for (const row of rows) row.retry.hidden = on || (row.state !== 'failed' && row.state !== 'skipped')
  retryFailedButton.hidden = on || !rows.some((row) => row.state === 'failed' || row.state === 'skipped')
  drawSummary()
}

function formControls(): (HTMLInputElement | HTMLSelectElement)[] {
  return [
    ...sourceGroup.querySelectorAll('input'),
    ...modeGroup.querySelectorAll('input'),
    ...formatGroup.querySelectorAll('input'),
    loadTimeoutSelect,
    renderWaitSelect,
    subfolderSwitch,
    showFolderSwitch,
  ]
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

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element as T
}
