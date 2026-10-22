import { readDraft, writeDraft, writeHandoff } from '../batch/batch-handoff'
import {
  BATCH_PERMISSIONS,
  LOAD_TIMEOUT_CHOICES,
  RENDER_WAIT_CHOICES,
  getBatchOptions,
  parseBatchUrls,
  setBatchOptions,
  siteCount,
  tabCapturable,
  type BatchMode,
  type BatchOptions,
  type BatchSource,
} from '../batch/batch-plan'
import { EXPORT_FORMATS, type ExportFormat } from '../result/export-options'
import { getExportPreferences } from '../result/export-preferences'

/*
 * The batch panel: All tabs and List of URLs, chosen inside the popup.
 *
 * Only the choosing happens here. Start hands the choice to the Batch page, which asks for access,
 * runs the batch and reports on it: a batch brings each page's tab to the front, and the browser
 * closes a popup the moment another tab does, taking any run inside it with it.
 */

const home = requiredElement<HTMLElement>('home')
const panel = requiredElement<HTMLElement>('batch-panel')
const title = requiredElement<HTMLHeadingElement>('batch-title')
const tabsPane = requiredElement<HTMLElement>('tabs-pane')
const urlsPane = requiredElement<HTMLElement>('urls-pane')
const tabList = requiredElement<HTMLUListElement>('tab-list')
const tabTools = requiredElement<HTMLElement>('tab-tools')
const tabSummary = requiredElement<HTMLParagraphElement>('tab-summary')
const tabsToggle = requiredElement<HTMLInputElement>('tabs-toggle')
const tabsToggleLabel = requiredElement<HTMLSpanElement>('tabs-toggle-label')
const tabsAccess = requiredElement<HTMLElement>('tabs-access')
const urlsInput = requiredElement<HTMLTextAreaElement>('urls')
const urlSummary = requiredElement<HTMLParagraphElement>('url-summary')
const more = requiredElement<HTMLDetailsElement>('batch-more')
const moreSummary = requiredElement<HTMLElement>('more-summary')
const modeSelect = requiredElement<HTMLSelectElement>('opt-mode')
const formatSelect = requiredElement<HTMLSelectElement>('opt-format')
const loadSelect = requiredElement<HTMLSelectElement>('opt-load')
const renderSelect = requiredElement<HTMLSelectElement>('opt-render')
const subfolderBox = requiredElement<HTMLInputElement>('opt-subfolder')
const showFolderBox = requiredElement<HTMLInputElement>('opt-show')
const startRow = requiredElement<HTMLElement>('start-row')
const startButton = requiredElement<HTMLButtonElement>('batch-start')
const startLabel = requiredElement<HTMLSpanElement>('batch-start-label')

const MODE_LABELS: Record<BatchMode, string> = { full: 'Full page', visible: 'Visible part' }
const FORMAT_LABELS: Record<ExportFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', pdf: 'PDF' }

interface TabEntry {
  id: number
  checkbox: HTMLInputElement
}

let source: BatchSource = 'tabs'
let opener: HTMLElement | undefined
let tabEntries: TabEntry[] = []
let settingsFormat: ExportFormat = 'png'
const optionsReady = loadOptions()

requiredElement<HTMLButtonElement>('batch-back').addEventListener('click', closeBatchPanel)
requiredElement<HTMLButtonElement>('tabs-allow').addEventListener('click', () => void openBatchPage('tabs'))
tabsToggle.addEventListener('change', () => {
  for (const entry of offeredTabs()) entry.checkbox.checked = tabsToggle.checked
  drawTabSummary()
})
urlsInput.addEventListener('input', () => {
  try {
    writeDraft(localStorage, urlsInput.value)
  } catch {
    // A blocked store costs the draft if the popup closes, nothing more.
  }
  drawUrlSummary()
})
startButton.addEventListener('click', () => void start())

export function openBatchPanel(chosen: BatchSource, from: HTMLElement): void {
  source = chosen
  opener = from
  title.textContent = chosen === 'tabs' ? 'All tabs' : 'List of URLs'
  tabsPane.hidden = chosen !== 'tabs'
  urlsPane.hidden = chosen !== 'urls'
  // The tabs pane hides these while it has no access to list anything.
  startRow.hidden = false
  more.hidden = false
  startButton.disabled = true
  if (chosen === 'urls') {
    try {
      urlsInput.value = readDraft(localStorage)
    } catch {
      urlsInput.value = ''
    }
    drawUrlSummary()
  } else {
    void drawTabs()
  }
  home.hidden = true
  panel.hidden = false
  if (chosen === 'urls') urlsInput.focus()
  else title.focus()
}

function closeBatchPanel(): void {
  panel.hidden = true
  home.hidden = false
  opener?.focus()
}

async function drawTabs(): Promise<void> {
  tabList.replaceChildren()
  tabEntries = []
  const granted = await chrome.permissions.contains(BATCH_PERMISSIONS).catch(() => false)
  tabsAccess.hidden = granted
  tabList.hidden = !granted
  tabTools.hidden = !granted
  startRow.hidden = !granted
  more.hidden = !granted
  if (!granted) return

  const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => [])
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    const capturable = tabCapturable(tab.url)
    const item = document.createElement('li')
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = capturable
    checkbox.disabled = !capturable
    checkbox.addEventListener('change', drawTabSummary)
    const page = document.createElement('span')
    page.className = 'page'
    const name = document.createElement('span')
    name.className = 'name'
    // Without its address the tab is one PageShotter has no access to: a browser or extension page.
    name.textContent = tab.title || tab.url || "A page PageShotter can't read"
    const where = document.createElement('span')
    where.className = 'where'
    where.textContent = capturable ? hostOf(tab.url as string) : "Can't be captured"
    page.title = tab.url ?? ''
    page.append(name, where)
    label.append(checkbox, page)
    item.append(label)
    tabList.append(item)
    tabEntries.push({ id: tab.id, checkbox })
  }
  drawTabSummary()
}

function offeredTabs(): TabEntry[] {
  return tabEntries.filter((entry) => !entry.checkbox.disabled)
}

function pickedTabs(): TabEntry[] {
  return offeredTabs().filter((entry) => entry.checkbox.checked)
}

function drawTabSummary(): void {
  const offered = offeredTabs().length
  const picked = pickedTabs().length
  tabSummary.textContent = offered === 0 ? 'No tab in this window can be captured.' : `${picked} of ${plural(offered, 'tab')} picked`
  // Some but not all reads as the dash the browser draws for a part-ticked box, as on History.
  tabsToggle.checked = offered > 0 && picked === offered
  tabsToggle.indeterminate = picked > 0 && picked < offered
  tabsToggleLabel.textContent = tabsToggle.checked ? 'Select none' : 'Select all'
  tabsToggle.disabled = offered === 0
  drawStart(picked, 'tab')
}

function drawUrlSummary(): void {
  const { urls, rejected } = parseBatchUrls(urlsInput.value)
  const parts: string[] = []
  if (urls.length > 0) parts.push(`${plural(urls.length, 'page')} on ${plural(siteCount(urls), 'site')}.`)
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 2).map((entry) => `“${entry.line}” (${entry.reason})`)
    const others = rejected.length > 2 ? ` and ${rejected.length - 2} more` : ''
    parts.push(`Skipped: ${shown.join(', ')}${others}.`)
  }
  urlSummary.textContent = parts.join(' ')
  drawStart(urls.length, 'page')
}

function drawStart(count: number, noun: string): void {
  startButton.disabled = count === 0
  startLabel.textContent = count === 0 ? 'Capture' : `Capture ${plural(count, noun)}`
}

async function loadOptions(): Promise<void> {
  const [options, preferences] = await Promise.all([
    getBatchOptions().catch(() => undefined),
    getExportPreferences().catch(() => undefined),
  ])
  settingsFormat = preferences?.format ?? 'png'
  for (const mode of ['full', 'visible'] as const) appendOption(modeSelect, mode, MODE_LABELS[mode])
  for (const format of EXPORT_FORMATS) appendOption(formatSelect, format, FORMAT_LABELS[format])
  for (const choice of LOAD_TIMEOUT_CHOICES) appendOption(loadSelect, String(choice.ms), choice.label)
  for (const choice of RENDER_WAIT_CHOICES) appendOption(renderSelect, String(choice.ms), choice.label)
  if (options) {
    modeSelect.value = options.mode
    formatSelect.value = options.format ?? settingsFormat
    loadSelect.value = String(options.loadTimeoutMs)
    renderSelect.value = String(options.renderWaitMs)
    subfolderBox.checked = options.subfolder
    showFolderBox.checked = options.showFolder
  }
  for (const control of [modeSelect, formatSelect, loadSelect, renderSelect, subfolderBox, showFolderBox]) {
    control.addEventListener('change', () => {
      drawMoreSummary()
      void setBatchOptions(currentOptions()).catch(() => undefined)
    })
  }
  drawMoreSummary()
}

/** The two choices that change what lands on disk, so a closed section still says what it will do. */
function drawMoreSummary(): void {
  const mode = MODE_LABELS[modeSelect.value as BatchMode] ?? ''
  const format = FORMAT_LABELS[formatSelect.value as ExportFormat] ?? ''
  moreSummary.textContent = [mode, format].filter(Boolean).join(' · ')
}

function currentOptions(): BatchOptions {
  const format = formatSelect.value as ExportFormat
  return {
    mode: modeSelect.value === 'visible' ? 'visible' : 'full',
    // Stored only once it differs from Settings, as on the Batch page, so a batch keeps following the
    // Settings file type until someone picks another one for batches.
    ...(format !== settingsFormat ? { format } : {}),
    loadTimeoutMs: Number(loadSelect.value),
    renderWaitMs: Number(renderSelect.value),
    subfolder: subfolderBox.checked,
    showFolder: showFolderBox.checked,
  }
}

async function start(): Promise<void> {
  if (startButton.disabled) return
  startButton.disabled = true
  await optionsReady
  // Saved before the Batch page opens, because it reads the options as it loads.
  await setBatchOptions(currentOptions()).catch(() => undefined)
  try {
    writeHandoff(localStorage, {
      source,
      urls: source === 'urls' ? urlsInput.value : '',
      tabIds: source === 'tabs' ? pickedTabs().map((entry) => entry.id) : [],
      at: Date.now(),
    })
    // The list now lives on the Batch page; a draft left here would come back as a second batch.
    if (source === 'urls') writeDraft(localStorage, '')
  } catch {
    // Without the handoff the Batch page opens empty, on the same source, and the choice is made there.
  }
  await openBatchPage(source)
}

async function openBatchPage(on: BatchSource): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`batch.html${on === 'tabs' ? '?source=tabs' : ''}`) })
  window.close()
}

/** The host alone fits the popup's width; the full address is the row's tooltip. */
function hostOf(url: string): string {
  try {
    const { protocol, host } = new URL(url)
    return protocol === 'file:' ? 'Local file' : host
  } catch {
    return url
  }
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  select.append(option)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element as T
}
