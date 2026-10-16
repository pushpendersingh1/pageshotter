import { BROWSER, SHORTCUTS_PAGE } from '../shared/browser'
import { DEFAULT_HISTORY_LIMITS, HISTORY_RETENTION_CHOICES, formatBytes } from '../shared/history-policy'
import { pruneHistory } from '../shared/history-prune'
import {
  DEFAULT_LONG_PAGE_POLICY,
  FOLLOW_EXTRA_SECTIONS,
  LONG_PAGE_CHOICES,
  type LongPagePolicy,
  getLongPagePolicy,
  setLongPagePolicy,
} from '../shared/capture-depth'
import {
  DEFAULT_IMAGE_WAIT_MS,
  DEFAULT_SECTION_WAIT_MS,
  IMAGE_WAIT_CHOICES,
  SECTION_WAIT_CHOICES,
  getImageWaitMs,
  getSectionWaitMs,
  sectionWaitCostMs,
  setImageWaitMs,
  setSectionWaitMs,
} from '../shared/capture-wait'
import {
  DEFAULT_AUTO_DOWNLOAD,
  DEFAULT_DOWNLOAD_FOLDER,
  DEFAULT_HISTORY_SETTINGS,
  getAutoDownload,
  setAutoDownload,
  getDownloadFolder,
  clearDownloadFolderRevokedBefore,
  getHistorySettings,
  setDownloadFolder,
  setHistorySettings,
} from '../shared/history-settings'
import { folderProblem, sanitiseFolder } from '../shared/download-folder'
import { deleteHistoryEntries, listHistory } from '../shared/capture-db'
import { captureShortcut } from '../shared/shortcut'
import { applyStoredTheme, wireThemeButton } from '../shared/theme'
import {
  EXPORT_FORMATS,
  EXPORT_SCALES,
  JPEG_QUALITY_MAX,
  JPEG_QUALITY_MIN,
  JPEG_QUALITY_STEP,
  exportScaleLabel,
  type ExportFormat,
} from '../result/export-options'
import {
  DEFAULT_EXPORT_PREFERENCES,
  DEFAULT_JPEG_QUALITY,
  PDF_PAGE_SIZES,
  getExportPreferences,
  setExportFormat,
  setExportPreferences,
  setExportScale,
  setJpegQuality,
  setPdfOptions,
  type ExportPreferences,
} from '../result/export-preferences'
import { PDF_PAPERS, type PdfPageSizeName } from '../result/pdf-layout'
import { commitFolderDraft } from './download-folder-setting'

// Chrome follows the theme; the preference is read by every page and can be changed from any of
// them, so the button behaves identically here, in the popup, and on the result page.
void applyStoredTheme(document.documentElement)
wireThemeButton(requiredElement<HTMLButtonElement>('theme'), document.documentElement)

const retentionSelect = requiredElement<HTMLSelectElement>('history-retention')
const longPageSelect = requiredElement<HTMLSelectElement>('long-page')
const longPageNote = requiredElement<HTMLParagraphElement>('long-page-note')
const sectionWaitSelect = requiredElement<HTMLSelectElement>('section-wait')
const sectionWaitNote = requiredElement<HTMLParagraphElement>('section-wait-note')
const imageWaitSelect = requiredElement<HTMLSelectElement>('image-wait')
const imageWaitNote = requiredElement<HTMLParagraphElement>('image-wait-note')
const retentionNote = requiredElement<HTMLParagraphElement>('retention-note')
const status = requiredElement<HTMLParagraphElement>('settings-status')
const shortcutTitle = requiredElement<HTMLElement>('shortcut-title')
const shortcutBody = requiredElement<HTMLParagraphElement>('shortcut-body')
const storageLine = requiredElement<HTMLParagraphElement>('storage-line')
const deleteAll = requiredElement<HTMLButtonElement>('delete-all')
const deleteAllNote = requiredElement<HTMLParagraphElement>('delete-all-note')
const deleteAllDialog = requiredElement<HTMLDialogElement>('delete-all-dialog')
const deleteAllDetail = requiredElement<HTMLParagraphElement>('delete-all-detail')
const downloadFolder = requiredElement<HTMLInputElement>('download-folder')
const folderProblemNote = requiredElement<HTMLParagraphElement>('folder-problem')
const folderPermissionRow = requiredElement<HTMLDivElement>('folder-permission-row')
const folderExplain = requiredElement<HTMLDetailsElement>('folder-explain')
const permState = requiredElement<HTMLSpanElement>('perm-state')
const permNote = requiredElement<HTMLParagraphElement>('perm-note')
const permAction = requiredElement<HTMLButtonElement>('perm-action')
const folderCommit = requiredElement<HTMLButtonElement>('folder-commit')
const folderStatus = requiredElement<HTMLParagraphElement>('folder-status')
const autoDownload = requiredElement<HTMLInputElement>('auto-download')
const autoDownloadCaution = requiredElement<HTMLParagraphElement>('auto-download-caution')
const exportFormatGroup = requiredElement<HTMLElement>('export-format')
const exportQualitySelect = requiredElement<HTMLSelectElement>('export-quality')
const exportQualityCaution = requiredElement<HTMLParagraphElement>('export-quality-caution')
const exportScaleSelect = requiredElement<HTMLSelectElement>('export-scale')
const pdfPageSizeGroup = requiredElement<HTMLElement>('pdf-page-size')
const pdfSplitSwitch = requiredElement<HTMLInputElement>('pdf-split')
const pdfSplitCaution = requiredElement<HTMLParagraphElement>('pdf-split-caution')
const pdfTextSwitch = requiredElement<HTMLInputElement>('pdf-text')
const pdfLinksSwitch = requiredElement<HTMLInputElement>('pdf-links')
const resetDefaults = requiredElement<HTMLButtonElement>('reset-defaults')
const resetDefaultsDialog = requiredElement<HTMLDialogElement>('reset-defaults-dialog')
const actionAlert = requiredElement<HTMLParagraphElement>('settings-action-alert')

let savedDownloadFolder = ''
let permissionGranted = false
let folderCommitBusy = false
let exportPreferences: ExportPreferences = structuredClone(DEFAULT_EXPORT_PREFERENCES)

void initialise()

async function initialise(): Promise<void> {
  for (const choice of HISTORY_RETENTION_CHOICES) {
    const option = document.createElement('option')
    option.value = String(choice.days)
    option.textContent = withDefaultMark(choice.label, choice.days === DEFAULT_HISTORY_SETTINGS.retentionDays)
    retentionSelect.append(option)
  }

  savedDownloadFolder = await getDownloadFolder()
  downloadFolder.value = savedDownloadFolder
  refreshFolderNotes()
  await refreshPermission()

  /*
   * Chrome can grant or revoke this outside the page from chrome://extensions. Without these
   * listeners the badge would say whatever it said when the tab was opened, which is worse than not
   * showing a state at all.
   */
  chrome.permissions.onAdded.addListener(() => void refreshPermission())
  chrome.permissions.onRemoved.addListener((removed) => {
    if (removed.permissions?.includes('downloads')) void clearFolderAfterRevocation(Date.now())
  })

  autoDownload.checked = await getAutoDownload()
  drawAutoDownloadCaution()
  autoDownload.addEventListener('change', () => {
    void setAutoDownload(autoDownload.checked)
      .then(drawAutoDownloadCaution)
      .catch(() => showSettingsAlert('That setting could not be saved.', true))
  })

  permAction.addEventListener('click', () => void removeFolderAccess())
  folderCommit.addEventListener('click', () => void commitFolder())

  /*
   * Typing edits a draft. The explicit action is what gives Chrome a direct user gesture for its
   * permission prompt, and the setting is not written until Chrome has answered yes.
   */
  downloadFolder.addEventListener('input', () => {
    hideFolderStatus()
    refreshFolderNotes()
  })

  for (const choice of LONG_PAGE_CHOICES) {
    const option = document.createElement('option')
    option.value = choice.policy
    option.textContent = withDefaultMark(choice.label, choice.policy === DEFAULT_LONG_PAGE_POLICY)
    longPageSelect.append(option)
  }
  longPageSelect.value = await getLongPagePolicy()
  drawLongPageNote()
  longPageSelect.addEventListener('change', () => {
    void (async () => {
      await setLongPagePolicy(longPageSelect.value as LongPagePolicy)
      drawLongPageNote()
    })()
  })

  for (const choice of SECTION_WAIT_CHOICES) {
    const option = document.createElement('option')
    option.value = String(choice.ms)
    option.textContent = withDefaultMark(choice.label, choice.ms === DEFAULT_SECTION_WAIT_MS)
    sectionWaitSelect.append(option)
  }
  sectionWaitSelect.value = String(await getSectionWaitMs())
  drawSectionWaitNote()
  sectionWaitSelect.addEventListener('change', () => {
    void (async () => {
      await setSectionWaitMs(Number(sectionWaitSelect.value))
      drawSectionWaitNote()
    })()
  })

  for (const choice of IMAGE_WAIT_CHOICES) {
    const option = document.createElement('option')
    option.value = String(choice.ms)
    option.textContent = withDefaultMark(choice.label, choice.ms === DEFAULT_IMAGE_WAIT_MS)
    imageWaitSelect.append(option)
  }
  imageWaitSelect.value = String(await getImageWaitMs())
  drawImageWaitNote()
  imageWaitSelect.addEventListener('change', () => {
    void (async () => {
      await setImageWaitMs(Number(imageWaitSelect.value))
      drawImageWaitNote()
    })()
  })

  const settings = await getHistorySettings()
  retentionSelect.value = String(settings.retentionDays)
  // States the cap as well as the period, because the period alone is not the whole rule: "Forever"
  // means no expiry, not unlimited storage, and someone who is not told that will eventually find
  // screenshots missing and conclude the setting was ignored.
  retentionNote.textContent =
    `Deleted automatically once older than this. A ${formatBytes(DEFAULT_HISTORY_LIMITS.maxBytes)} ` +
    `and ${DEFAULT_HISTORY_LIMITS.maxEntries}-screenshot cap also applies, oldest first, even on “Forever”.`

  // Applied immediately, then reported. A setting that quietly waits for some later capture to take
  // effect reads as a setting that did nothing.
  retentionSelect.addEventListener('change', () => {
    void apply({ retentionDays: Number(retentionSelect.value) })
  })

  await initialiseExportSettings()

  // Chrome owns the binding: an extension can read it and link to the page that changes it, and
  // nothing more. Saying so plainly beats a control here that would only ever open that page.
  requiredElement<HTMLButtonElement>('open-shortcuts').addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_PAGE })
  })
  await drawShortcut()

  /*
   * Behind a dialog rather than the click-again confirmation History uses for a selection.
   *
   * Both are deletions, but they are not the same size: one removes the rows you ticked, this
   * removes everything, and the thing that makes it safe -- that the screenshots never left this
   * computer -- is exactly what makes it unrecoverable. A dialog states the count before it happens
   * and puts the safe answer under the pointer, which a button that arms itself for four seconds
   * cannot. It is a native `<dialog>`, so Escape and the backdrop both mean "keep them".
   */
  deleteAll.addEventListener('click', () => {
    deleteAllDialog.showModal()
  })
  deleteAllDialog.addEventListener('close', () => {
    if (deleteAllDialog.returnValue === 'delete') void removeEverything()
  })

  resetDefaults.addEventListener('click', () => {
    resetDefaultsDialog.returnValue = ''
    resetDefaultsDialog.showModal()
  })
  resetDefaultsDialog.addEventListener('close', () => {
    if (resetDefaultsDialog.returnValue === 'reset') void resetToDefaults()
  })

  await report()
}

/** The factory default is named in the option itself, so it is identifiable without reading any note. */
function withDefaultMark(label: string, isDefault: boolean): string {
  return isDefault ? `${label} (default)` : label
}

async function initialiseExportSettings(): Promise<void> {
  const formatLabels: Record<ExportFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', pdf: 'PDF' }
  for (const format of EXPORT_FORMATS) {
    appendSegment(
      exportFormatGroup,
      'export-format-choice',
      format,
      formatLabels[format],
      format === DEFAULT_EXPORT_PREFERENCES.format,
    )
  }
  for (let quality = JPEG_QUALITY_MIN; quality <= JPEG_QUALITY_MAX; quality += JPEG_QUALITY_STEP) {
    appendOption(
      exportQualitySelect,
      String(quality),
      withDefaultMark(`${quality}%`, quality === DEFAULT_JPEG_QUALITY),
    )
  }
  for (const scale of EXPORT_SCALES) {
    appendOption(
      exportScaleSelect,
      String(scale),
      withDefaultMark(
        scale === 1 ? '100%, captured size' : exportScaleLabel(scale),
        scale === DEFAULT_EXPORT_PREFERENCES.scale,
      ),
    )
  }
  for (const pageSize of PDF_PAGE_SIZES) {
    appendPageSizeChoice(pageSize, pageSize === DEFAULT_EXPORT_PREFERENCES.pdf.pageSize)
  }

  exportPreferences = await getExportPreferences()
  drawExportSettings()

  exportFormatGroup.addEventListener('change', () => {
    exportPreferences.format = checkedValue(exportFormatGroup) as ExportFormat
    drawExportCautions()
    void setExportFormat(exportPreferences.format).catch(() => showSettingsAlert('The export format could not be saved.', true))
  })
  exportQualitySelect.addEventListener('change', () => {
    exportPreferences.jpegQuality = Number(exportQualitySelect.value)
    void setJpegQuality(exportPreferences.jpegQuality).catch(() => showSettingsAlert('The image quality could not be saved.', true))
  })
  exportScaleSelect.addEventListener('change', () => {
    exportPreferences.scale = Number(exportScaleSelect.value)
    void setExportScale(exportPreferences.scale).catch(() => showSettingsAlert('The image scale could not be saved.', true))
  })
  for (const control of [pdfPageSizeGroup, pdfSplitSwitch, pdfTextSwitch, pdfLinksSwitch]) {
    control.addEventListener('change', () => {
      exportPreferences.pdf = {
        pageSize: checkedValue(pdfPageSizeGroup) as PdfPageSizeName,
        splitToPages: pdfSplitSwitch.checked,
        textSearchable: pdfTextSwitch.checked,
        directLinks: pdfLinksSwitch.checked,
      }
      drawExportCautions()
      void setPdfOptions(exportPreferences.pdf).catch(() => showSettingsAlert('The PDF defaults could not be saved.', true))
    })
  }
}

/** One item of a segmented control: a radio, so the platform owns roving focus and the announcement. */
function appendSegment(
  group: HTMLElement,
  name: string,
  value: string,
  label: string,
  isDefault: boolean,
): void {
  const item = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = name
  input.value = value
  const text = document.createElement('span')
  text.textContent = label
  item.append(input, text)
  if (isDefault) input.setAttribute('aria-label', `${label} (default)`)
  group.append(item)
}

/**
 * One page size, drawn at the proportions of the paper the PDF writer actually emits.
 *
 * Both the glyph's shape and the printed dimension come from `PDF_PAPERS`, so neither can drift
 * from the output. `fit` has no paper, so it gets an open-ended strip and says what it means
 * instead of quoting a size it does not have.
 */
function appendPageSizeChoice(pageSize: PdfPageSizeName, isDefault: boolean): void {
  const names: Record<PdfPageSizeName, string> = {
    fit: 'Fit content',
    a4: 'A4',
    letter: 'Letter',
    legal: 'Legal',
  }
  const choice = document.createElement('label')
  choice.className = 'choice'

  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'pdf-page-size-choice'
  input.value = pageSize

  const glyph = document.createElement('span')
  glyph.className = 'page-glyph'
  glyph.dataset.paper = pageSize
  // A fitted page has no paper, so its shape is a choice rather than a fact: the dashed border is
  // what says "open-ended", and the ratio stays close to Legal's so no card is driven taller than
  // the row beside it.
  glyph.style.aspectRatio =
    pageSize === 'fit' ? '3 / 5' : `${PDF_PAPERS[pageSize].width} / ${PDF_PAPERS[pageSize].height}`

  const name = document.createElement('span')
  name.className = 'choice-name'
  name.textContent = names[pageSize]

  const dimension = document.createElement('span')
  dimension.className = 'choice-dim'
  dimension.textContent = pageSize === 'fit' ? 'Sized to your capture' : paperDimension(pageSize)

  const stack = document.createElement('span')
  stack.className = 'choice-text'
  stack.append(name, dimension)

  if (isDefault) input.setAttribute('aria-label', `${names[pageSize]} (default)`)
  choice.append(input, glyph, stack)
  pdfPageSizeGroup.append(choice)
}

/** Points converted to the unit the paper is actually sold in, rounded the way a person writes it. */
function paperDimension(pageSize: Exclude<PdfPageSizeName, 'fit'>): string {
  const metric = pageSize === 'a4'
  const paper = PDF_PAPERS[pageSize]
  const convert = (points: number): number =>
    metric ? Math.round((points / 72) * 25.4) : Math.round((points / 72) * 10) / 10
  return `${convert(paper.width)} × ${convert(paper.height)} ${metric ? 'mm' : 'in'}`
}

function checkedValue(group: HTMLElement): string {
  return group.querySelector<HTMLInputElement>('input:checked')?.value ?? ''
}

function checkRadio(group: HTMLElement, value: string): void {
  const input = group.querySelector<HTMLInputElement>(`input[value="${value}"]`)
  if (input) input.checked = true
}

/*
 * Two interactions that are true only sometimes, said only when they are true.
 *
 * The static sentence under a control says what that control does. These say what the current
 * *combination* does, which is otherwise only discoverable by exporting and looking at the file.
 */
function drawExportCautions(): void {
  const formatIgnoresQuality = exportPreferences.format === 'png' || exportPreferences.format === 'pdf'
  exportQualityCaution.hidden = !formatIgnoresQuality
  if (formatIgnoresQuality) {
    exportQualityCaution.textContent =
      `Your file type is ${exportPreferences.format.toUpperCase()}, which ignores quality. It still ` +
      `applies when you pick JPEG or WebP in the Download menu.`
  }

  // Unsplit plus a named paper keeps the paper's width and takes whatever height the capture needs,
  // so the export is not a stack of that sheet. See `planPdfPages`.
  const unsplitPaper = !exportPreferences.pdf.splitToPages && exportPreferences.pdf.pageSize !== 'fit'
  pdfSplitCaution.hidden = !unsplitPaper
  if (unsplitPaper) {
    pdfSplitCaution.textContent =
      `With splitting off, the PDF is one page at that paper's width and the capture's full height, ` +
      `not a stack of sheets.`
  }
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  select.append(option)
}

function drawExportSettings(): void {
  checkRadio(exportFormatGroup, exportPreferences.format)
  exportQualitySelect.value = String(exportPreferences.jpegQuality)
  exportScaleSelect.value = String(exportPreferences.scale)
  checkRadio(pdfPageSizeGroup, exportPreferences.pdf.pageSize)
  pdfSplitSwitch.checked = exportPreferences.pdf.splitToPages
  pdfTextSwitch.checked = exportPreferences.pdf.textSearchable
  pdfLinksSwitch.checked = exportPreferences.pdf.directLinks
  drawExportCautions()
}

/**
 * One reset for the whole page: every control goes back to the default
 * its owning module exports — no default is copied here — and each one is written the same way a
 * manual change would be, so the side effects run: retention pruning, the cost and policy notes,
 * the folder sanitisation. Downloads access stays granted; Screenshots, editor documents and the
 * theme are not part of this form and are not touched.
 */
async function resetToDefaults(): Promise<void> {
  resetDefaults.disabled = true
  try {
    await Promise.all([
      setLongPagePolicy(DEFAULT_LONG_PAGE_POLICY),
      setSectionWaitMs(DEFAULT_SECTION_WAIT_MS),
      setImageWaitMs(DEFAULT_IMAGE_WAIT_MS),
      setAutoDownload(DEFAULT_AUTO_DOWNLOAD),
      setDownloadFolder(DEFAULT_DOWNLOAD_FOLDER),
      setExportPreferences(DEFAULT_EXPORT_PREFERENCES),
    ])
    await apply({ retentionDays: DEFAULT_HISTORY_SETTINGS.retentionDays })

    retentionSelect.value = String(DEFAULT_HISTORY_SETTINGS.retentionDays)
    longPageSelect.value = DEFAULT_LONG_PAGE_POLICY
    sectionWaitSelect.value = String(DEFAULT_SECTION_WAIT_MS)
    imageWaitSelect.value = String(DEFAULT_IMAGE_WAIT_MS)
    autoDownload.checked = DEFAULT_AUTO_DOWNLOAD
    savedDownloadFolder = DEFAULT_DOWNLOAD_FOLDER
    downloadFolder.value = DEFAULT_DOWNLOAD_FOLDER
    exportPreferences = structuredClone(DEFAULT_EXPORT_PREFERENCES)
    drawLongPageNote()
    drawSectionWaitNote()
    drawImageWaitNote()
    drawAutoDownloadCaution()
    drawExportSettings()
    refreshFolderNotes()
    showFolderStatus('The folder is back to the default PageShotter. Downloads access was not changed.')
    showSettingsAlert(
      'Factory defaults restored. Screenshots, editor documents, editor defaults, colour theme and Downloads access were not changed.',
    )
  } catch {
    showSettingsAlert('The settings could not all be reset. Nothing stored in History was deleted.', true)
  } finally {
    resetDefaults.disabled = false
  }
}

/**
 * The one combination in which this setting silently does nothing.
 *
 * Saving into a folder needs the optional `downloads` permission, and nothing can request a
 * permission without a click -- there is no click when a capture finishes on its own. So a folder
 * plus no permission means the capture opens normally, and saying so here is the difference between
 * a setting that looks broken and one that explains itself. It is re-read whenever the permission or
 * the folder changes, so granting access clears it.
 */
function drawAutoDownloadCaution(): void {
  const blocked = autoDownload.checked && savedDownloadFolder !== '' && !permissionGranted
  autoDownloadCaution.hidden = !blocked
  if (blocked) {
    autoDownloadCaution.textContent =
      'Saving into a folder needs Downloads access, which cannot be asked for while nobody is ' +
      'watching. Until it is granted above, captures will open as usual.'
  }
}

function showSettingsAlert(message: string, problem = false): void {
  actionAlert.textContent = message
  actionAlert.dataset.state = problem ? 'problem' : 'done'
  actionAlert.hidden = false
  actionAlert.scrollIntoView({ block: 'nearest' })
}

/**
 * Ask Chrome whether the permission is actually held, and say so.
 *
 * Asked rather than remembered. The answer can change here or from chrome://extensions, so a stored
 * flag would be another version of the truth and the one most likely to be wrong.
 */
async function refreshPermission(): Promise<void> {
  try {
    permissionGranted = await chrome.permissions.contains({ permissions: ['downloads'] })
  } catch {
    permissionGranted = false
  }
  permState.dataset.state = permissionGranted ? 'granted' : 'not-granted'
  permState.textContent = permissionGranted ? 'Granted' : 'Not granted'
  permAction.hidden = !permissionGranted
  permAction.disabled = folderCommitBusy
  permNote.textContent = permissionGranted
    ? 'PageShotter uses this access only to start downloads in the folder above. It never changes existing files or searches or erases download history.'
    : `Set folder asks ${BROWSER.name} for access. The folder is not saved unless access is granted.`
  drawAutoDownloadCaution()
  refreshFolderNotes()
}

async function commitFolder(): Promise<void> {
  folderCommitBusy = true
  refreshFolderNotes()
  try {
    const result = await commitFolderDraft(savedDownloadFolder, downloadFolder.value, permissionGranted, {
      requestPermission: () => chrome.permissions.request({ permissions: ['downloads'] }),
      removePermission: () => chrome.permissions.remove({ permissions: ['downloads'] }),
      saveFolder: setDownloadFolder,
    })

    if (result.kind === 'permission-denied') {
      showFolderStatus('Access was not granted. The folder was not changed, and captures still save to Downloads.')
    } else if (result.kind === 'set') {
      savedDownloadFolder = result.folder
      downloadFolder.value = result.folder
      showFolderStatus(`Folder set to Downloads/${sanitiseFolder(result.folder)}.`)
    } else if (result.kind === 'cleared') {
      savedDownloadFolder = ''
      downloadFolder.value = ''
      showFolderStatus(
        result.permissionRemoved
          ? 'Future captures save to Downloads. Existing files were not changed.'
          : `Future captures save to Downloads. ${BROWSER.name} still shows access, so you can remove it below.`,
      )
    }
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : ''
    showFolderStatus(`The folder could not be changed.${detail}`)
  }
  await refreshPermission()
  folderCommitBusy = false
  refreshFolderNotes()
}

async function removeFolderAccess(): Promise<void> {
  folderCommitBusy = true
  refreshFolderNotes()
  try {
    await setDownloadFolder('')
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : ''
    showFolderStatus(`The folder preference could not be cleared. Access was not changed.${detail}`)
    folderCommitBusy = false
    await refreshPermission()
    return
  }

  savedDownloadFolder = ''
  downloadFolder.value = ''
  try {
    await chrome.permissions.remove({ permissions: ['downloads'] })
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : ''
    showFolderStatus(`The folder preference was cleared, but ${BROWSER.name} could not remove access.${detail}`)
  }
  await refreshPermission()
  if (!permissionGranted) {
    showFolderStatus('Folder access was removed. Existing files were not changed.')
  } else if (!folderStatus.textContent?.includes('could not remove')) {
    showFolderStatus(`The folder preference was cleared, but ${BROWSER.name} still shows access. Try Remove access again.`)
  }
  folderCommitBusy = false
  refreshFolderNotes()
}

async function clearFolderAfterRevocation(revokedAt: number): Promise<void> {
  // Invalidate the cached permission before the first await. Otherwise Set folder could observe the
  // old `true`, skip Chrome's prompt and persist a folder while revocation cleanup is still opening
  // IndexedDB.
  permissionGranted = false
  folderCommitBusy = true
  refreshFolderNotes()
  const draft = downloadFolder.value
  const cleared = await clearDownloadFolderRevokedBefore(revokedAt).catch(() => false)
  if (cleared) {
    savedDownloadFolder = ''
    downloadFolder.value = draft
    showFolderStatus(
      draft.trim() === ''
        ? 'Folder access was removed. Existing files were not changed.'
        : 'Folder access was removed. The text above is an unsaved draft; existing files were not changed.',
    )
  }
  await refreshPermission()
  folderCommitBusy = false
  refreshFolderNotes()
}

function refreshFolderNotes(): void {
  drawAutoDownloadCaution()
  const problem = folderProblem(downloadFolder.value)
  const draft = downloadFolder.value.trim()
  downloadFolder.classList.toggle('invalid', problem !== undefined)
  downloadFolder.setAttribute('aria-invalid', problem === undefined ? 'false' : 'true')
  folderProblemNote.textContent = problem ?? ''
  folderProblemNote.hidden = problem === undefined
  /*
   * The permission note appears only once a folder is actually wanted. Explaining a permission the
   * user has not asked to need reads as a warning about the product rather than an answer to a
   * question they have.
   */
  const canRestoreStaleFolder = draft !== '' && !permissionGranted
  const changed = draft !== savedDownloadFolder
  folderCommit.disabled = folderCommitBusy || problem !== undefined || (!changed && !canRestoreStaleFolder)
  downloadFolder.disabled = folderCommitBusy
  permAction.disabled = folderCommitBusy
  folderCommit.textContent = draft === '' && savedDownloadFolder !== '' ? 'Use Downloads' : 'Set folder'

  const folderIsRelevant = draft !== '' || savedDownloadFolder !== '' || permissionGranted
  folderPermissionRow.hidden = !folderIsRelevant
  folderExplain.hidden = !folderIsRelevant
}

function showFolderStatus(message: string): void {
  folderStatus.textContent = message
  folderStatus.hidden = false
}

function hideFolderStatus(): void {
  folderStatus.textContent = ''
  folderStatus.hidden = true
}

/**
 * The shortcut as Chrome actually bound it, which is often not what the manifest asked for -- see
 * `shared/shortcut.ts`. Printing the suggestion instead would promise a key that may do nothing.
 */
async function drawShortcut(): Promise<void> {
  const assigned = await captureShortcut()
  if (assigned === '') {
    shortcutTitle.textContent = 'No shortcut is assigned'
    shortcutBody.textContent =
      `${BROWSER.name} could not take the suggested combination, most likely because another extension ` +
      'already had it. Pick your own and full-page capture works without opening the popup.'
    return
  }

  shortcutTitle.textContent = 'Capture without opening the popup'
  const key = document.createElement('kbd')
  key.className = 'key'
  key.textContent = assigned
  shortcutBody.replaceChildren('Press ', key, ' on any page.')
}

/**
 * What the chosen policy actually does, in the terms the user will judge it by -- a screenshot that
 * is cut short, or a capture that will not stop. The choice is a trade between those two, and a
 * label alone ("Follow it a little further") states neither side of it.
 */
function drawLongPageNote(): void {
  const notes: Record<LongPagePolicy, string> = {
    freeze:
      'Stops at the height the page had when you started. Fastest, but anything that loads in ' +
      'during the capture is left out.',
    follow:
      `Stops ${FOLLOW_EXTRA_SECTIONS} screens past the starting height. Catches a page that fills ` +
      'in as you scroll, and still ends on a feed that never does.',
    unbounded:
      'Follows the page for as long as it grows. On a feed this ends only at the time or section ' +
      'limit, and still will not reach the end.',
  }
  longPageNote.textContent = notes[longPageSelect.value as LongPagePolicy]
}

/** How many sections the cost is quoted against. A long article, not a worst case. */
const TYPICAL_SECTIONS = 20

/*
 * States the cost in the unit it is paid in. The floor is charged on every section, so the number
 * that matters is not the setting but the setting times the page -- and a reader who is only shown
 * "2 seconds" has no way to arrive at "about 40 seconds longer" on their own.
 */
function drawSectionWaitNote(): void {
  const ms = Number(sectionWaitSelect.value)
  if (ms <= 0) {
    sectionWaitNote.textContent =
      'Each section is photographed once it stops changing, which is enough almost everywhere.'
    return
  }
  const seconds = Math.round(sectionWaitCostMs(ms, TYPICAL_SECTIONS) / 1000)
  sectionWaitNote.textContent =
    `Holds every section this long even when the page looks finished, which catches placeholders ` +
    `that are the right size but empty. A ${TYPICAL_SECTIONS}-section page takes about ` +
    `${seconds} seconds longer.`
}

/**
 * Why raising this is cheap and turning it off is not obviously free.
 *
 * The distinction worth stating is that this is a ceiling rather than a delay: unlike the pause
 * above, it ends as soon as the images arrive, so a page of cached images pays none of it. Someone
 * reading the two settings together would otherwise reasonably assume both cost what they say.
 */
function drawImageWaitNote(): void {
  const ms = Number(imageWaitSelect.value)
  if (ms <= 0) {
    imageWaitNote.textContent =
      'Photographed without waiting, so an image that never loads cannot hold up every section. ' +
      'Pictures still loading come out blank.'
    return
  }
  const seconds = ms / 1000
  imageWaitNote.textContent =
    `A ceiling, not a delay: each section moves on the moment its pictures load, up to ` +
    `${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Raise it if images come out blank.`
}

async function apply(change: { retentionDays: number }): Promise<void> {
  await setHistorySettings(change)
  const removed = await pruneHistory().catch(() => 0)
  await report(removed)
}

async function report(removed = 0): Promise<void> {
  const entries = await listHistory()
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  const stored =
    entries.length === 0
      ? 'Nothing is stored.'
      : `${entries.length} ${entries.length === 1 ? 'screenshot' : 'screenshots'} stored, using ${formatBytes(bytes)}.`
  status.textContent = removed > 0 ? `${stored} ${removed} deleted just now.` : stored
  // The same figure the history page puts in the same place, so the sidebar does not appear to
  // change what it reports depending on which section you are in.
  storageLine.textContent =
    entries.length === 0
      ? ''
      : `${entries.length} ${entries.length === 1 ? 'screenshot' : 'screenshots'} · ${formatBytes(bytes)}`

  // Nothing to delete is a disabled button that says so, not a live one that would do nothing.
  const count = `${entries.length} ${entries.length === 1 ? 'screenshot' : 'screenshots'}`
  deleteAll.disabled = entries.length === 0
  deleteAllNote.textContent =
    entries.length === 0
      ? 'There is nothing stored to delete.'
      : `Removes all ${count} and the ${formatBytes(bytes)} they use, at once.`
  deleteAllDetail.textContent = `This removes ${count}, using ${formatBytes(bytes)}.`
}

async function removeEverything(): Promise<void> {
  const entries = await listHistory()
  if (entries.length === 0) return
  // The same call the history page makes, which is what also clears each capture's tiles and its
  // harvested page text -- a delete that left those behind would keep the words of a screenshot
  // whose picture is gone.
  await deleteHistoryEntries(entries.map((entry) => entry.id))
  await report(entries.length)
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element as T
}
