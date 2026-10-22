import { BATCH_STATUS_KEY, clearStatus, readStatus, requestSkip, requestStop, type BatchStatus } from '../batch/batch-status'
import { filledSegments, segmentCount } from './progress-bar'

/*
 * A batch in progress, followed from the popup. The Batch page runs it from a tab in the background
 * and reports where it has got to (see batch-status.ts); this draws that report in place of the
 * capture controls, keeps it current while the popup is open, and passes Stop back.
 */

const idle = requiredElement<HTMLElement>('idle')
const panel = requiredElement<HTMLElement>('batch-running')
const title = requiredElement<HTMLElement>('batch-run-title')
const doneCount = requiredElement<HTMLElement>('batch-run-done')
const totalCount = requiredElement<HTMLElement>('batch-run-total')
const segs = requiredElement<HTMLElement>('batch-segs')
const status = requiredElement<HTMLElement>('batch-run-status')
const stopButton = requiredElement<HTMLButtonElement>('batch-stop')
const skipButton = requiredElement<HTMLButtonElement>('batch-skip')
/** The page Skip would skip, as last reported; `0` while there is none. */
let skippable = 0

skipButton.addEventListener('click', () => {
  if (skippable === 0) return
  skipButton.disabled = true
  status.textContent = 'Skipping'
  try {
    requestSkip(localStorage, skippable, Date.now())
  } catch {
    skipButton.disabled = false
  }
})

stopButton.addEventListener('click', () => {
  stopButton.disabled = true
  skipButton.disabled = true
  status.textContent = 'Stopping'
  try {
    requestStop(localStorage, Date.now())
  } catch {
    stopButton.disabled = false
  }
})

/**
 * Shows the running batch, if there is one, and follows it.
 *
 * Drawn from the record straight away, so the popup does not open on its controls and then jump to
 * the panel. The Batch page is checked for after: one that crashed or was killed never got to clear
 * its record, and a popup offering to stop a batch nobody is running would be lying.
 */
export function showRunningBatch(): void {
  let current: BatchStatus | undefined
  try {
    current = readStatus(localStorage.getItem(BATCH_STATUS_KEY))
  } catch {
    return
  }
  if (current === undefined) return
  draw(current)
  window.addEventListener('storage', (event) => {
    if (event.key !== BATCH_STATUS_KEY) return
    const next = readStatus(event.newValue)
    // The record goes when the batch ends, and the Batch page comes to the front with its report.
    if (next === undefined) window.close()
    else draw(next)
  })
  void chrome.tabs.get(current.tabId).catch(() => {
    try {
      clearStatus(localStorage)
    } catch {
      // Unreadable next time too, so nothing is shown from it either way.
    }
    document.body.classList.remove('busy')
    panel.hidden = true
    idle.hidden = false
  })
}

function draw(current: BatchStatus): void {
  document.body.classList.add('busy')
  idle.hidden = true
  panel.hidden = false
  title.textContent = current.source === 'tabs' ? 'All tabs' : 'List of URLs'
  doneCount.textContent = String(current.done)
  totalCount.textContent = String(current.total)

  const segments = segmentCount(current.total)
  if (segs.children.length !== segments) {
    segs.replaceChildren(...Array.from({ length: segments }, () => Object.assign(document.createElement('span'), { className: 'seg' })))
  }
  // The page in hand is the one after the finished ones, so it is the segment that breathes.
  const filled = filledSegments(current.done, current.total, segments)
  const working = current.done < current.total && !current.stopping ? filledSegments(current.done + 1, current.total, segments) : filled
  for (const [index, segment] of [...segs.children].entries()) {
    segment.className = `seg${index < filled ? ' done' : index < working ? ' now' : ''}`
  }
  segs.setAttribute('aria-valuemin', '0')
  segs.setAttribute('aria-valuemax', String(current.total))
  segs.setAttribute('aria-valuenow', String(current.done))

  stopButton.disabled = current.stopping
  skippable = current.currentPosition
  skipButton.disabled = current.stopping || skippable === 0
  status.textContent = current.stopping ? 'Stopping' : current.current === '' ? 'Starting the next page' : current.current
  status.title = current.current
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element as T
}
