import { badgeText } from '../batch/batch-status'

/*
 * The toolbar icon while a batch runs: a ring turning around the icon, and the pages finished on the
 * badge. It is the one place a running batch is visible from the page being captured, and the badge
 * is the count behind it, so the motion never stands in for progress it cannot show.
 *
 * Drawn here rather than by the Batch page, which runs the batch from a tab in the background, where
 * the browser slows timers to once a second and later once a minute. The worker's are not slowed,
 * and each `setIcon` is an extension call, which keeps the worker alive for as long as it turns.
 */

/** Light-theme `--accent` and `--line`. The toolbar sits on the browser's own frame, not on ours. */
const ACCENT = '#e11900'
const TRACK = 'rgba(128, 128, 128, 0.35)'
const FRAME_MS = 80
/** A twelfth of a turn a frame: one revolution a second. */
const STEP = Math.PI / 6
const SIZES = [16, 32] as const

let batchTabId: number | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let angle = 0
let icon: Promise<ImageBitmap | undefined> | undefined

/** The Batch page is gone, so whatever it last reported is no longer true. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === batchTabId) hideBatchProgress()
})

export function showBatchProgress(tabId: number, done: number, total: number): void {
  batchTabId = tabId
  void chrome.action.setBadgeBackgroundColor({ color: ACCENT }).catch(() => undefined)
  void chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => undefined)
  void chrome.action.setBadgeText({ text: badgeText(done, total) }).catch(() => undefined)
  if (timer === undefined) void turn()
}

export function hideBatchProgress(): void {
  batchTabId = undefined
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  void chrome.action.setBadgeText({ text: '' }).catch(() => undefined)
  restoreIcon()
}

function restoreIcon(): void {
  const manifestIcon = chrome.runtime.getManifest().action?.default_icon
  if (manifestIcon !== undefined) void chrome.action.setIcon({ path: manifestIcon }).catch(() => undefined)
}

async function turn(): Promise<void> {
  // Set before the first await, so a second report arriving meanwhile does not start a second loop.
  timer = setTimeout(() => void turn(), FRAME_MS)
  icon ??= loadIcon()
  const bitmap = await icon
  if (batchTabId === undefined) return
  const imageData: Record<string, ImageData> = {}
  for (const size of SIZES) imageData[size] = drawFrame(size, angle, bitmap)
  angle = (angle + STEP) % (Math.PI * 2)
  await chrome.action.setIcon({ imageData }).catch(() => undefined)
  // A frame still on its way when the batch ended would otherwise land after the icon was restored.
  if (batchTabId === undefined) restoreIcon()
}

async function loadIcon(): Promise<ImageBitmap | undefined> {
  try {
    const response = await fetch(chrome.runtime.getURL('icons/icon-32.png'))
    return await createImageBitmap(await response.blob())
  } catch {
    return undefined
  }
}

/** The icon at a little over half size, inside a track with a quarter-turn of accent going round it. */
function drawFrame(size: number, start: number, bitmap: ImageBitmap | undefined): ImageData {
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const line = size / 8
  const radius = size / 2 - line / 2
  const centre = size / 2
  if (bitmap !== undefined) {
    const inner = Math.round(size * 0.56)
    const offset = (size - inner) / 2
    context.drawImage(bitmap, offset, offset, inner, inner)
  }
  context.lineWidth = line
  context.lineCap = 'round'
  context.strokeStyle = TRACK
  context.beginPath()
  context.arc(centre, centre, radius, 0, Math.PI * 2)
  context.stroke()
  context.strokeStyle = ACCENT
  context.beginPath()
  context.arc(centre, centre, radius, start, start + Math.PI / 2)
  context.stroke()
  return context.getImageData(0, 0, size, size)
}
