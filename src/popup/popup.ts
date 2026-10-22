import { extensionDetailsPage, openShortcutSettings } from '../shared/browser'
import { openBatchPanel } from './batch-panel'
import { showRunningBatch } from './batch-running'
import { filledSegments, segmentCount } from './progress-bar'
import { captureEtaLabel } from '../shared/capture-eta'
import { wireThemeButton } from '../shared/theme'
import { keycaps, parseChromeShortcut } from '../shared/keycaps'
import type {
  CaptureError,
  CaptureMode,
  CaptureJob,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/messages'

const idle = requiredElement<HTMLElement>('idle')
const capturing = requiredElement<HTMLElement>('capturing')
const errorPanel = requiredElement<HTMLElement>('error')
const errorMessage = requiredElement<HTMLElement>('error-message')
const progressTitle = requiredElement<HTMLElement>('progress-title')
const progressCount = requiredElement<HTMLElement>('progress-count')
const progressCurrent = requiredElement<HTMLElement>('progress-current')
const progressTotal = requiredElement<HTMLElement>('progress-total')
const progressStatus = requiredElement<HTMLElement>('progress-status')
const progressEta = requiredElement<HTMLElement>('progress-eta')
const segs = requiredElement<HTMLElement>('segs')
const errorAction = requiredElement<HTMLButtonElement>('error-action')
const captureFull = requiredElement<HTMLButtonElement>('capture-full')
const themeButton = requiredElement<HTMLButtonElement>('theme')

/** The words each mode is called by, so the panel names what is running rather than "Capturing...". */
const MODE_LABELS: Record<CaptureMode, string> = {
  full: 'Full page',
  visible: 'Visible area',
  region: 'Selection',
}

/** Which manifest command drives which button. */
const SHORTCUT_CHIPS: ReadonlyArray<{ chipId: string; command: string }> = [
  { chipId: 'shortcut-full', command: 'capture-full-page' },
  { chipId: 'shortcut-visible', command: 'capture-visible-area' },
  { chipId: 'shortcut-region', command: 'capture-selection' },
]

let activeJobId: string | undefined
let lastMode: CaptureMode = 'full'
let pollTimer: number | undefined
/** How many segments are currently drawn, so an unchanged estimate does not rebuild the bar. */
let drawnSegments = 0

captureFull.addEventListener('click', () => {
  // The shutter marks the exposure, once, on the primary action. Reading a layout box between the
  // removal and the re-add flushes the change, so a second capture in the same popup fires the
  // animation again instead of silently keeping the finished one.
  captureFull.classList.remove('shooting')
  captureFull.getBoundingClientRect()
  captureFull.classList.add('shooting')
  void start('full')
})
requiredElement<HTMLButtonElement>('capture-visible').addEventListener('click', () => void start('visible'))
requiredElement<HTMLButtonElement>('capture-region').addEventListener('click', () => void start('region'))
requiredElement<HTMLButtonElement>('cancel').addEventListener('click', () => void cancel())
requiredElement<HTMLButtonElement>('retry').addEventListener('click', () => void start(lastMode))
requiredElement<HTMLButtonElement>('open-history').addEventListener('click', () => openHistory())
for (const [id, source] of [['capture-tabs', 'tabs'], ['open-batch', 'urls']] as const) {
  const row = requiredElement<HTMLButtonElement>(id)
  row.addEventListener('click', () => openBatchPanel(source, row))
}
requiredElement<HTMLButtonElement>('open-settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
  window.close()
})

// First, and before anything else is drawn: a stored palette that arrives late is a visible flash.
void wireThemeButton(themeButton, document.documentElement)
void drawShortcuts()
showRunningBatch()

function openHistory(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('history.html') })
  window.close()
}

/**
 * Chrome only applies `suggested_key` when that combination is still free at install time, and the
 * user can rebind or clear it afterwards. Printing the manifest's suggestion would therefore promise
 * a shortcut that may do nothing, so each chip shows whatever Chrome actually assigned.
 *
 * A chip with no binding reads "Set" rather than disappearing. Hiding it once a binding exists
 * assumed the only reason to visit the shortcuts page was to create one, but a shortcut Chrome
 * assigned automatically is exactly the kind that collides with another extension's, and the user
 * would then have no way to find the rebind page.
 */
function drawChip(chip: HTMLElement, shortcut: string): void {
  chip.replaceChildren()
  for (const cap of keycaps(parseChromeShortcut(shortcut), false)) {
    if (cap.kind !== 'glyph') {
      chip.append(cap.text)
      continue
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 12 12')
    svg.setAttribute('class', 'chip-glyph')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', cap.label)
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', cap.path)
    svg.append(path)
    chip.append(svg)
  }
}

async function drawShortcuts(): Promise<void> {
  let assigned = new Map<string, string>()
  try {
    const commands = await chrome.commands.getAll()
    assigned = new Map(commands.map((command) => [command.name ?? '', command.shortcut ?? '']))
  } catch {
    // An unreadable command list is indistinguishable from an unassigned shortcut here, and both are
    // served correctly by offering the shortcuts page.
  }

  for (const { chipId, command } of SHORTCUT_CHIPS) {
    const chip = requiredElement<HTMLButtonElement>(chipId)
    const shortcut = assigned.get(command) ?? ''
    if (shortcut === '') chip.textContent = 'Set'
    else drawChip(chip, shortcut)
    chip.classList.toggle('unset', shortcut === '')
    chip.title = shortcut === '' ? 'Set a keyboard shortcut' : 'Change shortcut'
    chip.setAttribute(
      'aria-label',
      shortcut === '' ? 'Set a keyboard shortcut' : `Change shortcut, currently ${shortcut}`,
    )
    chip.hidden = false
    chip.addEventListener('click', () => {
      openShortcutSettings()
      window.close()
    })
  }
}

async function start(mode: CaptureMode): Promise<void> {
  lastMode = mode
  showProgress(mode)
  const response = await send({ type: 'START_CAPTURE', mode })
  if (!response.ok || !response.jobId) {
    showError(
      response.ok ? { code: 'CAPTURE_FAILED', message: 'Capture did not start.' } : response.error,
    )
    return
  }
  activeJobId = response.jobId
  // Region select hands the page back to the user, and they cannot drag on it while the popup holds
  // focus. Closing here also avoids a progress panel that would sit at "0 sections" for as long as
  // the person takes to choose — the overlay is the progress indicator for this mode.
  if (mode === 'region') {
    window.close()
    return
  }
  await poll()
}

async function poll(): Promise<void> {
  if (!activeJobId) return
  const response = await send({ type: 'GET_JOB', jobId: activeJobId })
  if (response.ok && !response.job) {
    /*
     * The job record is gone, and the only thing that removes a fresh one is the result page moving
     * it into history -- so the capture finished and was delivered. Chrome closes the popup when the
     * result tab opens and never got here; Firefox keeps it open, and reported a successful capture
     * as "status unavailable" whenever this poll lost the race to the result page.
     */
    window.close()
    return
  }
  if (!response.ok || !response.job) {
    showError(response.ok ? { code: 'CAPTURE_FAILED', message: 'Capture status was unavailable.' } : response.error)
    return
  }

  updateProgress(response.job)
  if (response.job.status === 'capturing') {
    pollTimer = window.setTimeout(() => void poll(), 250)
  } else if (response.job.status === 'failed') {
    showError(
      response.job.error ?? { code: 'CAPTURE_FAILED', message: 'The page could not be captured.' },
    )
  } else if (response.job.status === 'complete') {
    // The result page has it from here. Chrome closes the popup as that tab opens; Firefox leaves it
    // open, and a background save opens no tab in front in either, so the popup closes itself.
    window.close()
  } else if (response.job.status === 'cancelled') {
    showActions()
  }
}

async function cancel(): Promise<void> {
  if (!activeJobId) return
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  await send({ type: 'CANCEL_CAPTURE', jobId: activeJobId })
  // A stop now finishes the capture rather than discarding it, so the page is restored *and* the
  // sections already taken are assembled into a result.
  progressStatus.textContent = 'Finishing'
  pollTimer = window.setTimeout(() => void poll(), 200)
}

function updateProgress(job: CaptureJob): void {
  const { current, estimatedTotal } = job.progress

  // The bar draws one segment per section the job says it is going to take. When there is no count
  // to draw -- a single-frame grab, or a page that has not been measured yet -- it is absent rather
  // than faked, because a bar that moves on a guess is a bar that lies.
  /*
   * A growing page gets a count with no denominator. The bar drew one segment per expected section
   * and the expectation grew with the count, so it filled up and then got longer -- which reads as
   * a capture that is going backwards. Sections taken is the only number that is true throughout.
   */
  const growing = job.growingPage === true
  const countable = current > 0 && estimatedTotal > 1 && !growing
  progressCount.hidden = !countable
  segs.classList.toggle('unmeasured', !countable)

  if (countable) {
    // Capped, because one segment per section stops being a bar and starts being a window-resize:
    // see `progress-bar.ts`. The count beside it still reads in whole sections, and so does the
    // accessible value -- it is only the drawing that buckets.
    const segments = segmentCount(estimatedTotal)
    if (drawnSegments !== segments) {
      segs.replaceChildren(
        ...Array.from({ length: segments }, () => {
          const segment = document.createElement('span')
          segment.className = 'seg'
          return segment
        }),
      )
      drawnSegments = segments
      segs.setAttribute('aria-valuemin', '0')
      segs.setAttribute('aria-valuemax', String(estimatedTotal))
    }
    const filled = filledSegments(current, estimatedTotal, segments)
    const drawn = [...segs.children]
    for (const [index, segment] of drawn.entries()) {
      const state = index < filled - 1 ? ' done' : index === filled - 1 ? ' now' : ''
      segment.className = `seg${state}`
    }
    segs.setAttribute('aria-valuenow', String(current))
    progressCurrent.textContent = String(current)
    progressTotal.textContent = String(estimatedTotal)
  }

  progressStatus.textContent =
    current === 0
      ? 'Measuring the page'
      : growing
        ? `This page loads more as it scrolls — ${current} ${current === 1 ? 'section' : 'sections'} so far`
        : countable
          ? 'Grabbing sections'
          : 'Grabbing the frame'
  progressEta.textContent = growing
    ? 'Stop when you have enough'
    : captureEtaLabel(current, estimatedTotal, Date.now() - job.createdAt)
}

function showProgress(mode: CaptureMode): void {
  document.body.classList.add('busy')
  // Distinct from `busy`, which the error state shares: only a running capture collapses the window
  // to the panel. An error is read and acted on, so it keeps the layout it was shown in.
  document.body.classList.add('capturing')
  idle.hidden = true
  errorPanel.hidden = true
  capturing.hidden = false
  progressTitle.textContent = MODE_LABELS[mode]
  progressStatus.textContent = 'Measuring the page'
  progressEta.textContent = ''
  progressCount.hidden = true
  segs.classList.add('unmeasured')
  segs.replaceChildren()
  drawnSegments = 0
}

/*
 * Chrome blocks `chrome://` links in page content, so this is a button -- but an extension may
 * navigate a tab there, and `?id=` lands on PageShotter's own details page, where the file access
 * toggle is, rather than on a list the reader then has to search for their own extension in.
 */
const detailsPage = extensionDetailsPage()
errorAction.addEventListener('click', () => {
  if (detailsPage) void chrome.tabs.create({ url: detailsPage })
})

function showError(error: CaptureError): void {
  document.body.classList.add('busy')
  document.body.classList.remove('capturing')
  idle.hidden = true
  capturing.hidden = true
  errorPanel.hidden = false
  errorMessage.textContent = error.message
  // Telling someone to turn on a toggle without taking them to it leaves them hunting through
  // chrome://extensions for their own extension.
  // Where the browser will not open its extensions page, the message's own steps are the remedy.
  errorAction.hidden = error.code !== 'FILE_ACCESS_DENIED' || detailsPage === null
}

function showActions(): void {
  activeJobId = undefined
  document.body.classList.remove('busy')
  document.body.classList.remove('capturing')
  capturing.hidden = true
  errorPanel.hidden = true
  idle.hidden = false
  captureFull.classList.remove('shooting')
}

async function send(request: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    return (await chrome.runtime.sendMessage(request)) as RuntimeResponse
  } catch (error) {
    // Chrome's messaging errors name internal ports and read like a stack trace, so they are logged
    // rather than shown.
    console.warn('PageShotter: background unavailable', error)
    return {
      ok: false,
      error: {
        code: 'BACKGROUND_UNAVAILABLE',
        message: 'PageShotter is unavailable. Try reloading the page.',
      },
    }
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element as T
}
