import { chromeTemplateFor } from '../result/chrome-template'
import { ExportMenu, saveWithAnchor } from '../result/export-menu'
import {
  exportActionLabel,
  exportBusyLabel,
  exportFileExtension,
  type ExportFormat,
} from '../result/export-options'
import { restoreTiledImage } from '../result/history-io'
import { createPdfBlob } from '../result/pdf-export'
import {
  PRESENT_KEY,
  presentAddress,
  readPresentOptions,
  stampText,
} from '../result/presentation-options'
import { encodeImage, type TiledImage } from '../result/stitcher'
import { deleteHistoryEntries, getEditorDoc, getHistoryEntry, getSetting, putEditorDoc, putSetting } from '../shared/capture-db'
import { confirmDelete, printImage } from '../shared/confirm-delete'
import { applyStoredTheme, wireThemeButton } from '../shared/theme'
import { cropTiledImage, loadBundledFonts, renderEditedImage } from './export-renderer'
import { readInspectorField } from './inspector-fields'
import {
  applyToolDefaults,
  DEFAULT_EDITOR_DEFAULTS,
  DEFAULTABLE_KEYS,
  extractToolDefault,
  getEditorDefaultsState,
  putEditorDefaults,
  resetEditorDefaults,
  type EditorDefaults,
} from './editor-defaults'
import { EditorDefaultsDialog } from './editor-defaults-dialog'
import { Inspector } from './inspector'
import { LayersPanel } from './layers-panel'
import { readRecentEmoji, withRecentEmoji } from './emoji'
import { EmojiPicker } from './emoji-picker'
import { paintKeycaps } from './keycap'
import { ShortcutOverlay } from './shortcut-overlay'
import {
  PreviewRenderer,
  isStrokeTool,
  shapeTypeOf,
  STAGE_PADDING,
  measureTextHeight,
  SELECT_FALLBACK,
  type DraftStyle,
  type DrawTool,
} from './preview-renderer'
import { shiftZoomChoice, typingOwnsKey } from './shortcuts'
import {
  DEFAULT_STROKE,
  IDENTITY,
  MIN_SHAPE_SIZE,
  clickTarget,
  cloneSubtree,
  composeLocal,
  defaultCrop,
  detachNode,
  duplicateNodesInPlace,
  emptyDoc,
  constrainDrag,
  nodeFromDrag,
  nextCount,
  placeLens,
  smoothStroke,
  STROKE_SPACING,
  findNode,
  foldScale,
  groupNodes,
  hitTest,
  isGroupNode,
  isImageSource,
  countAnnotations,
  layerNames,
  newNodeId,
  nodePath,
  nodesInRect,
  parentMatrixOf,
  parentOf,
  parseSceneDoc,
  reorderNodes,
  renderRect,
  selectionBounds,
  hasStroke,
  textFontFamily,
  textInset,
  resizeTextBox,
  textFontStyle,
  ungroupNode,
  type CropPreset,
  type KnownNode,
  type Matrix,
  type OrderMove,
  type Rect,
  type SceneDoc,
  type SceneNode,
  type ShapeNode,
  type TextNode,
} from './scene'

type Tool = 'move' | 'hand' | DrawTool | 'emoji'

const title = requiredElement<HTMLElement>('title')
const dimensions = requiredElement<HTMLElement>('dimensions')
const editorMain = requiredElement<HTMLElement>('editor-main')
const canvas = requiredElement<HTMLElement>('canvas')
const canvasScroll = requiredElement<HTMLElement>('canvas-scroll')
const stageHost = requiredElement<HTMLDivElement>('stage-host')
const canvasSpace = requiredElement<HTMLElement>('canvas-space')
// Up here, not beside `insertImages`: `wireImageDrop` runs during start-up and reads them.
/** The pictures a canvas draws without tainting; `isImageSource` holds the saved copy to the same four. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** A bigger picture is scaled down on the way in, so a phone photo does not bloat the saved document. */
const IMAGE_MAX_SIDE = 4096
const errorMessage = requiredElement<HTMLElement>('editor-error')
const textEditor = requiredElement<HTMLTextAreaElement>('text-editor')
const downloadButton = requiredElement<HTMLButtonElement>('download')
const exportOptionsButton = requiredElement<HTMLButtonElement>('export-options')
const copyButton = requiredElement<HTMLButtonElement>('copy')
const printButton = requiredElement<HTMLButtonElement>('print')
const deleteButton = requiredElement<HTMLButtonElement>('delete-capture')
const doneButton = requiredElement<HTMLButtonElement>('done')
const hostLabel = requiredElement<HTMLElement>('host')
const statusSelection = requiredElement<HTMLElement>('status-selection')
const undoButton = requiredElement<HTMLButtonElement>('undo')
const redoButton = requiredElement<HTMLButtonElement>('redo')
const cropButton = requiredElement<HTMLButtonElement>('crop-tool')
const presentButton = requiredElement<HTMLButtonElement>('present-tool')
const zoomValue = requiredElement<HTMLButtonElement>('zoom-value')
const preview = new PreviewRenderer(stageHost, canvasSpace, {
  begin: (duplicate) => beginCanvasGesture(duplicate),
  commit: (delta) => commitCanvasGesture(delta),
  pointsChanged: (id, points, live) => commitPoints(id, points, live),
  cropChanged: (rect) => updateCrop(rect, undefined, false),
})

/**
 * Panel and inspector both read the document through these callbacks rather than holding it, because
 * undo replaces the document object wholesale and a held reference would quietly edit the old one.
 *
 * `structure` and `state` stay separate all the way up here: `setSelection` and `setHovered` call
 * only the state halves, and nothing but a document change calls `changed()`.
 */
const layers = new LayersPanel(
  requiredElement<HTMLElement>('layers-list'),
  requiredElement<HTMLElement>('layers-empty'),
  requiredElement<HTMLElement>('frame-row'),
  requiredElement<HTMLTemplateElement>('layer-row-template'),
  requiredElement<HTMLElement>('layer-icons'),
  {
    size: requiredElement<HTMLElement>('frame-size'),
  },
  {
    doc: () => doc,
    selection: () => selection,
    select: (ids) => setSelection(ids),
    hover: (id) => setHovered(id, false),
    beginEdit: () => pushUndo(),
    changed: () => void changed(),
    frameSelected: () => frameSelected,
    selectFrame: () => selectFrame(),
  },
)

const inspector = new Inspector(
  requiredElement<HTMLElement>('inspector'),
  {
    title: requiredElement<HTMLElement>('inspector-title'),
    hide: requiredElement<HTMLButtonElement>('inspector-hide'),
    remove: requiredElement<HTMLButtonElement>('inspector-delete'),
    sectionMenu: requiredElement<HTMLTemplateElement>('section-menu-template'),
  },
  {
    doc: () => doc,
    selection: () => selection,
    beginEdit: () => pushUndo(),
    cancelEdit: () => void undoStack.pop(),
    changed: () => void changed(),
    outputLabel: () => outputLabel(),
    frameSelected: () => frameSelected,
    crop: () => cropMode,
    cropChanged: (rect, preset) => updateCrop(rect, preset),
    clearCrop: () => clearCrop(),
    toggleVisibility: () => toggleSelectionVisibility(),
    deleteSelection: () => deleteSelection(),
    toolDefault: (action) => applyToolDefault(action),
  },
)

let selection: string[] = []
let frameSelected = false
let hovered: string | undefined
let recentEmoji: string[] = []
const emojiPicker = new EmojiPicker(requiredElement<HTMLElement>('emoji-picker'), {
  choose: (char) => void chooseEmoji(char),
  dismiss: () => dismissEmojiPicker(),
})
const shortcutOverlay = new ShortcutOverlay(requiredElement<HTMLDialogElement>('shortcut-overlay'), {
  close: () => closeShortcuts(),
})
let entryId = ''
let image: TiledImage | undefined
let doc: SceneDoc | undefined
let activeTool: Tool = 'move'
let viewScale = 1
let fitted = true
let drawStart: { x: number; y: number } | undefined
/** The raw pointer samples of a stroke in progress, in scene space. Smoothed only on commit. */
let strokeRaw: number[] | undefined
let marqueeStart: { x: number; y: number } | undefined
/**
 * Whether the last press belonged to a gesture that owns its own release: a rubber band that swept
 * an area, or a press on a resize or rotate handle.
 *
 * The band ends with a `click` on empty stage, and `canvasClick`'s job on an empty click is to clear
 * the selection — so without this the marquee selected its shapes and then immediately dropped them
 * again. A handle is worse: Konva ends a transform on the window's `mouseup`, which runs
 * after the stage's `pointerup` and `click`, so either one changing the selection detached the handles
 * before `transformend` and the resize was never written.
 */
let pressOwned = false
/** The open text edit, if any: which node, what it said before, and whether it was just placed. */
let editing: { id: string; before: string; fresh: boolean } | undefined
let spaceDown = false
let duplicateGesture = false
let renderToken = 0
let editVersion = 0
let exportCache: { version: number; image: TiledImage } | undefined
let pageTitle = ''
let pageUrl: string | undefined
let capturedAt = new Date()
let cropMode: { rect: Rect; preset: CropPreset; canClear: boolean; dirty: boolean } | undefined
/**
 * The saved defaults new objects start from, read once at load and refreshed on every save
 * or reset, so creating a shape never waits on IndexedDB.
 */
let editorDefaults: EditorDefaults = structuredClone(DEFAULT_EDITOR_DEFAULTS)

new EditorDefaultsDialog({
  defaults: () => editorDefaults,
  save: async (defaults) => {
    editorDefaults = await putEditorDefaults(defaults)
    return editorDefaults
  },
  reset: async () => {
    editorDefaults = await resetEditorDefaults()
    return editorDefaults
  },
  alert: (message) => showEditorAlert(message),
})

const exportMenu: ExportMenu = new ExportMenu(
  document,
  () => {
    if (!doc) return undefined
    const output = renderRect(doc, chromeBand(doc))
    return { x: 0, y: 0, width: output.width, height: output.height }
  },
  (format) => syncExportButton(format),
  (): { width: number; height: number } | null => {
    if (!doc) return null
    // Unscaled, on purpose. The menu applies the export scale itself, at both the places that need
    // it; pre-scaling here left the outcome line saying "full resolution" over a halved file.
    const output = renderRect(doc, chromeBand(doc))
    return { width: output.width, height: output.height }
  },
  // Present draws its own background over the canvas, so the export is only transparent when the
  // canvas is transparent and no frame is covering it.
  () => doc?.canvas.background === 'none' && doc?.present.on !== true,
  // The same blob Download would produce, through the same cache, so looking at the size warms the
  // export rather than spending it. `editedImage` is cached per edit, so only the encode repeats.
  async () => (doc && image ? (await encode(exportMenu.current(), exportMenu.scale())).size : undefined),
)

void applyStoredTheme(document.documentElement)
// Every shortcut in the editor wears the same drawn caps: the menus, the dock's `?` and the sheet.
paintKeycaps(document)
wireDock()
wireCanvas()
wireImageDrop()
wirePanels()
wireZoom()
textEditor.addEventListener('keydown', (event) => {
  event.stopPropagation()
  // Enter and Esc both commit: Esc should not cancel the content, only leave the
  // edit. Shift+Enter is a line break, because a multi-line annotation is ordinary.
  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape') {
    event.preventDefault()
    endTextEdit(true)
  }
})
textEditor.addEventListener('blur', () => endTextEdit(true))
textEditor.addEventListener('input', () => {
  fitTextEditor()
  // The document follows the typing, so the box's handles and a filled box's pointer grow with the
  // text rather than jumping when the edit closes. The undo snapshot was taken
  // when the edit opened, so this is still one step.
  const node = editing && doc ? findNode(doc.nodes, editing.id) : undefined
  if (!doc || !node || isGroupNode(node) || node.type !== 'text') return
  node.text = textEditor.value
  preview.refreshNode(doc, node.id)
})
downloadButton.addEventListener('click', () => void download())
copyButton.addEventListener('click', () => void copy())
printButton.addEventListener('click', () => void print())
deleteButton.addEventListener('click', () => void deleteCaptureAndClose())
doneButton.addEventListener('click', () => void done())
requiredElement<HTMLButtonElement>('home').addEventListener('click', () => void done())
undoButton.addEventListener('click', () => undo())
redoButton.addEventListener('click', () => redo())
wireMoreMenu()
window.addEventListener('resize', () => {
  preview.resize()
  if (fitted) fit()
})
window.addEventListener('pagehide', () => preview.destroy(), { once: true })
void loadEditor()

async function loadEditor(): Promise<void> {
  try {
    entryId = new URL(location.href).searchParams.get('job') ?? ''
    if (!entryId) throw new Error('The capture identifier is missing.')
    const entry = await getHistoryEntry(entryId)
    if (!entry) throw new Error('This screenshot is no longer in History.')
    image = await restoreTiledImage(entry)
    const density = entry.imageScale?.x ?? entry.scaleX ?? 1
    if (entry.regionCrop) {
      image = await cropTiledImage(image, entry.regionCrop, density)
    }
    const storedDoc = await getEditorDoc(entryId)
    const defaultsState = await getEditorDefaultsState()
    editorDefaults = defaultsState.defaults
    doc = parseSceneDoc(storedDoc, image.width, image.height, density)
    if (!doc.capture.width || !doc.capture.height) doc = emptyDoc(image.width, image.height, density)
    if (storedDoc === undefined) {
      /*
       * A new document opens with the saved Present and canvas defaults when there are any;
       * otherwise the pre-v5 fallback stands, and then the factory values do.
       */
      if (defaultsState.stored) {
        doc.present = { ...doc.present, ...editorDefaults.present }
        doc.canvas = { ...doc.canvas, ...editorDefaults.canvas }
      } else {
        const legacy = readPresentOptions(await getSetting<unknown>(PRESENT_KEY).catch(() => undefined))
        doc.present = { ...legacy }
        doc.canvas = {
          background: legacy.background,
          customColor: legacy.customColor,
          margin: legacy.padding,
        }
      }
    }
    pageTitle = entry.title
    pageUrl = entry.url
    hostLabel.textContent = hostOf(entry.url)
    capturedAt = new Date(entry.createdAt)
    title.textContent = entry.title
    await exportMenu.load()
    exportMenu.setAvailable(false, 'Edited PDFs contain the finished picture; source-page text and links are not overlaid.')
    exportMenu.setPresenting(doc.present.on)
    await restorePanelState()
    layers.structure()
    inspector.render()
    // Before the first draw: Konva measures a text box once, in whatever font is loaded then.
    await loadBundledFonts()
    await render()
    fit()
    downloadButton.disabled = false
    exportOptionsButton.disabled = false
    copyButton.disabled = typeof ClipboardItem === 'undefined'
    printButton.disabled = false
    deleteButton.disabled = false
    doneButton.disabled = false
    cropButton.disabled = false
    presentButton.disabled = false
    syncFrameButtons()
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The editor could not load this screenshot.')
  }
}

async function render(): Promise<void> {
  if (!doc || !image) return
  const token = ++renderToken
  // The checkerboard marks transparency; an opaque backdrop sits on plain --stage instead.
  canvas.classList.toggle('transparent-ground', doc.canvas.background === 'none')
  const renderedDoc = cropMode ? { ...doc, crop: undefined } : doc
  await preview.render(renderedDoc, image, chromeBand(renderedDoc), renderDetails())
  if (token !== renderToken) return
  // `syncStatus` owns this string, size and object count together; writing it twice let the two halves
  // drift apart for one frame.
  syncStatus()
  syncViewport()
  preview.setOutlines(doc, selection, hovered)
}

/** The host of the captured page, for the top bar. A capture of a local file has no host to show. */
function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * The status bar's right half, and the undo/redo buttons' enabled state.
 *
 * Called from `render`, `setSelection` and `syncFrameButtons`, which between them cover every path
 * that can change what it says. The size on the left is written by `render` from `outputLabel()` --
 * the same call the inspector's Output row and the export menu read, so the three cannot disagree.
 */
function syncStatus(): void {
  undoButton.disabled = undoStack.length === 0
  redoButton.disabled = redoStack.length === 0
  if (!doc) {
    statusSelection.textContent = 'Nothing selected'
    statusSelection.dataset.selected = 'false'
    return
  }
  const objects = countAnnotations(doc)
  const objectText = `${objects.toLocaleString()} ${objects === 1 ? 'object' : 'objects'}`
  dimensions.textContent = [outputLabel(), objectText].filter(Boolean).join(' \u00b7 ')
  if (frameSelected) {
    statusSelection.textContent = 'Capture selected'
    statusSelection.dataset.selected = 'true'
    return
  }
  if (selection.length === 0) {
    statusSelection.textContent = 'Nothing selected'
    statusSelection.dataset.selected = 'false'
    return
  }
  if (selection.length > 1) {
    statusSelection.textContent = `${selection.length} selected`
    statusSelection.dataset.selected = 'true'
    return
  }
  const name = layerNames(doc).get(selection[0] as string)
  statusSelection.textContent = name ? `${name} selected` : '1 selected'
  statusSelection.dataset.selected = 'true'
}

/**
 * The overflow menu. Editor defaults and Delete moved into it from the top bar and the inspector
 * head; both kept their ids, so every handler that already wires them is untouched.
 */
function wireMoreMenu(): void {
  const button = requiredElement<HTMLButtonElement>('more')
  const menu = requiredElement<HTMLElement>('more-menu')
  const open = (next: boolean): void => {
    menu.hidden = !next
    button.setAttribute('aria-expanded', String(next))
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    open(menu.hidden !== false)
  })
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) open(false)
  })
  requiredElement<HTMLButtonElement>('more-shortcuts').addEventListener('click', () => {
    open(false)
    openShortcuts()
  })
  // Both moved items close the menu themselves; their own handlers do the work.
  for (const id of ['editor-defaults', 'delete-capture']) {
    requiredElement<HTMLButtonElement>(id).addEventListener('click', () => open(false))
  }
}

function outputLabel(): string {
  if (!doc) return ''
  if (cropMode) {
    const output = renderRect({ ...doc, crop: cropMode.rect }, chromeBand(doc))
    return `${output.width.toLocaleString()} × ${output.height.toLocaleString()} px`
  }
  const output = renderRect(doc, chromeBand(doc))
  return `${output.width.toLocaleString()} × ${output.height.toLocaleString()} px`
}

/**
 * One document change: the canvas repaints, the panel rebuilds its rows and the inspector its
 * fields. Selection and hover never come through here — they are class work.
 */
async function changed(): Promise<void> {
  editVersion += 1
  exportCache = undefined
  layers.structure()
  inspector.render()
  exportMenu.setPresenting(doc?.present.on === true)
  syncFrameButtons()
  await render()
}

/** Selection is state: the panel and inspector are told, the canvas repaints nothing. */
function setSelection(ids: string[]): void {
  const doc_ = doc
  selection = doc_ ? ids.filter((id) => findNode(doc_.nodes, id) !== undefined) : []
  if (selection.length > 0) frameSelected = false
  for (const id of selection) layers.revealAncestors(id)
  layers.state()
  inspector.render()
  syncStatus()
  syncHandles()
}

function selectFrame(): void {
  frameSelected = true
  setSelection([])
  syncFrameButtons()
}

/**
 * The handles follow the selection, but only under Move.
 *
 * Under a draw tool they come off entirely: the transformer's own area is draggable, so leaving
 * it up would swallow the first drag of every new shape started over something already selected.
 */
function syncHandles(): void {
  preview.setHandles(doc, !cropMode && activeTool === 'move' ? selection : [])
  // After the handles, because the outlines skip whatever the transformer's border already draws;
  // drawn first, they would be judged against the previous selection's handles.
  if (doc) preview.setOutlines(doc, selection, hovered)
}

async function enterCrop(): Promise<void> {
  const current = doc
  if (!current || cropMode) return
  endTextEdit(true)
  cropMode = {
    rect: { ...(current.crop ?? defaultCrop(current, chromeBand(current))) },
    preset: 'free',
    canClear: current.crop !== undefined,
    dirty: false,
  }
  setTool('move')
  syncFrameButtons()
  inspector.render()
  await render()
  if (cropMode) preview.setCrop(cropMode.rect)
}

function updateCrop(rect: Rect, preset: CropPreset = 'free', redraw = true): void {
  if (!cropMode) return
  cropMode = { ...cropMode, rect, preset, dirty: cropMode.dirty || !sameRect(cropMode.rect, rect) }
  if (redraw) preview.setCrop(rect)
  dimensions.textContent = outputLabel()
  inspector.render()
}

function commitCrop(): void {
  const current = doc
  const mode = cropMode
  if (!current || !mode) return
  cropMode = undefined
  preview.setCrop(undefined)
  syncFrameButtons()
  setTool(activeTool)
  if (!mode.dirty || sameRect(current.crop, mode.rect)) {
    inspector.render()
    void render()
    return
  }
  pushUndo()
  current.crop = { ...mode.rect }
  void changed()
}

function cancelCrop(): void {
  if (!cropMode) return
  cropMode = undefined
  preview.setCrop(undefined)
  syncFrameButtons()
  setTool(activeTool)
  inspector.render()
  void render()
}

function clearCrop(): void {
  const current = doc
  if (!current || !cropMode) return
  cropMode = undefined
  preview.setCrop(undefined)
  syncFrameButtons()
  setTool(activeTool)
  if (!current.crop) {
    inspector.render()
    void render()
    return
  }
  pushUndo()
  delete current.crop
  void changed()
}

function sameRect(left: Rect | undefined, right: Rect): boolean {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  )
}

function togglePresent(): void {
  const current = doc
  if (!current || cropMode) return
  pushUndo()
  current.present.on = !current.present.on
  selectFrame()
  void changed()
}

let alertTimer = 0

/**
 * The editor's one toast, bottom right. `kind` is the voice: a warning keeps the `--accent` hairline
 * it has always had, a confirmation gets the neutral one and a blue check glyph, and both rise.
 *
 * A second toast replaces the first rather than queueing behind it, and cancels its timer -- two
 * defaults saved in a row used to leave the second one hidden after the first timer fired.
 */
function showEditorAlert(message: string, kind: 'warning' | 'success' = 'warning'): void {
  const alert = requiredElement<HTMLElement>('editor-action-alert')
  requiredElement<HTMLElement>('editor-alert-text').textContent = message
  alert.dataset.kind = kind
  alert.hidden = false
  // Restart the entrance: the animation only plays on the frame the element becomes visible.
  alert.style.animation = 'none'
  void alert.offsetWidth
  alert.style.animation = ''
  window.clearTimeout(alertTimer)
  alertTimer = window.setTimeout(() => {
    alert.hidden = true
  }, kind === 'success' ? 2600 : 5000)
}

function syncFrameButtons(): void {
  cropButton.setAttribute('aria-pressed', String(cropMode !== undefined))
  presentButton.setAttribute('aria-pressed', String(doc?.present.on === true))
  presentButton.disabled = doc === undefined || cropMode !== undefined
  cropButton.disabled = doc === undefined
  downloadButton.disabled = cropMode !== undefined
  exportOptionsButton.disabled = cropMode !== undefined
  copyButton.disabled = cropMode !== undefined || typeof ClipboardItem === 'undefined'
  printButton.disabled = cropMode !== undefined
  deleteButton.disabled = cropMode !== undefined
  doneButton.disabled = cropMode !== undefined
  requiredElement<HTMLButtonElement>('image-tool').disabled = cropMode !== undefined
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tool-button[data-tool]')) {
    const tool = button.dataset.tool as Tool
    button.disabled = cropMode !== undefined && (isDrawTool(tool) || tool === 'emoji')
    button.setAttribute('aria-pressed', String(cropMode === undefined && tool === activeTool))
  }
  syncStatus()
}

/**
 * One canvas gesture, written into the document once.
 *
 * `delta` is the gesture's net effect in scene space, and every selected node takes it through its
 * own parent's frame (`composeLocal`). A **group** takes it on its own transform and its children
 * are not touched, which is the whole argument for storing children in their parent's frame.
 *
 * Two guards, both of which are wrong answers if left out:
 *
 * - A node whose ancestor is also selected is skipped, or the delta lands on it twice — once through
 *   the group and once on its own account — and it moves at double speed.
 * - A gesture whose delta is the identity commits nothing and drops the undo snapshot, so a press
 *   that moved nothing does not leave a step to undo.
 */
function beginCanvasGesture(duplicate: boolean): boolean {
  pushUndo()
  duplicateGesture = duplicate && duplicateSelection(true)
  return duplicateGesture
}

function commitCanvasGesture(delta: Matrix): void {
  const duplicated = duplicateGesture
  duplicateGesture = false
  commitGesture(delta, duplicated)
}

function commitGesture(delta: Matrix, duplicated = false): void {
  const current = doc
  if (!current) return
  if (isIdentity(delta)) {
    if (duplicated) void changed()
    else {
      undoStack.pop()
      // Nothing re-renders, so the outlines the gesture hid come back here.
      preview.setOutlines(current, selection, hovered)
    }
    return
  }
  const selected = new Set(selection)
  const targets = selection.filter((id) => {
    const path = nodePath(current.nodes, id)
    return (
      path !== undefined &&
      !path.some((node) => node.locked === true) &&
      !path.slice(0, -1).some((ancestor) => selected.has(ancestor.id))
    )
  })
  // Parent frames are read before anything is written: a selected group's own transform is part of
  // its children's frame, and reading them afterwards would measure against the new one.
  const frames = new Map(targets.map((id) => [id, parentMatrixOf(current, id)] as const))
  for (const id of targets) {
    const node = findNode(current.nodes, id)
    const frame = frames.get(id)
    if (!node || !frame) continue
    node.transform = composeLocal(delta, node.transform, frame)
    // A leaf's scale folds into its own geometry so the stroke keeps its weight and the inspector's
    // W and H stay the numbers it was showing. A group owns no geometry, so its scale stays put.
    if (!isGroupNode(node)) foldScale(node)
  }
  void changed()
}

/** Within a hundredth of a scene unit of no change at all. */
function isIdentity(delta: Matrix): boolean {
  const [a, b, c, d, e, f] = delta
  return (
    Math.abs(a - 1) < 1e-4 &&
    Math.abs(b) < 1e-4 &&
    Math.abs(c) < 1e-4 &&
    Math.abs(d - 1) < 1e-4 &&
    Math.abs(e) < 0.01 &&
    Math.abs(f) < 0.01
  )
}

function setHovered(id: string | undefined, fromCanvas = true): void {
  if (hovered === id) return
  hovered = id
  if (fromCanvas) layers.setHovered(id)
  if (doc) preview.setOutlines(doc, selection, hovered)
}

function renderDetails(): { address: string; stamp: string | null } {
  const current = doc
  return {
    address: current ? presentAddress(current.present.url, pageUrl, pageTitle) : '',
    stamp: current ? stampText(current.present.stamp, capturedAt) : null,
  }
}

/** The Present chrome band in design units — not to be confused with `planBands`' 8,192px export band. */
function chromeBand(scene: SceneDoc): number {
  return chromeTemplateFor(scene.present.frame).band
}

function wireCanvas(): void {
  canvasScroll.addEventListener('scroll', () => {
    syncViewport()
  })
  stageHost.addEventListener(
    'wheel',
    (event) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault()
        // Zoom at the pointer, which is the one place the anchor is not the canvas centre.
        const box = stageHost.getBoundingClientRect()
        setZoom(viewScale * (event.deltaY < 0 ? 1.1 : 0.9), false, { x: event.clientX - box.left, y: event.clientY - box.top })
        return
      }
      event.preventDefault()
      canvasScroll.scrollLeft += event.shiftKey ? event.deltaY : event.deltaX
      canvasScroll.scrollTop += event.shiftKey ? 0 : event.deltaY
    },
    { passive: false },
  )

  preview.stage.on('pointerdown', (event) => {
    if (event.evt.button !== 0) return
    pressOwned = preview.isHandle(event.target)
    if (pressOwned) return
    if (isDrawTool(activeTool)) {
      drawStart = preview.scenePoint() ?? undefined
      // A stroke tool keeps the pointer's whole path, not just where it started.
      strokeRaw = drawStart && isStrokeTool(activeTool) ? [drawStart.x, drawStart.y] : undefined
      return
    }
    // The rubber band starts only where a click would have cleared the selection anyway, so it can
    // never steal the first pixel of a drag on a shape.
    if (activeTool !== 'move' || !doc) return
    const point = preview.scenePoint()
    const hit = point ? hitTest(doc, point.x, point.y) : undefined
    if (!hit) {
      if (point) marqueeStart = point
      return
    }
    // A press on something not yet selected selects what a click would and arms the drag in the same
    // gesture, as Figma does. A modifier press is left to the click, which
    // toggles membership instead.
    if (event.evt.shiftKey || event.evt.metaKey || event.evt.ctrlKey) return
    const target = clickTarget(doc, selection, hit.id)
    if (selection.includes(target)) return
    setSelection([target])
    preview.armDrag(hit.id)
  })
  preview.stage.on('pointermove', () => {
    const point = preview.scenePoint()
    if (!point) return
    if (strokeRaw && isDrawTool(activeTool)) {
      // Every sample is kept while drawing and the draft is the raw path, so the line stays exactly
      // under the pointer. The resample and smooth happen once, on commit -- doing them per move
      // would make the line squirm behind the hand as earlier points were re-averaged.
      strokeRaw.push(point.x, point.y)
      preview.showStroke(strokeRaw, draftStyle(activeTool), activeTool === 'marker')
      return
    }
    if (drawStart && isDrawTool(activeTool)) {
      // The draft is drawn from the constrained drag, never the raw one, so what you see under
      // the pointer is what `finishDraw` commits.
      const drag = constrainDrag(shapeTypeOf(activeTool), drawStart, point, preview.drawModifiers())
      preview.showDraft(activeTool, drag.start, drag.end, draftStyle(activeTool))
      return
    }
    if (marqueeStart) {
      const rect = rectBetween(marqueeStart, point)
      if (rect.width >= MIN_SHAPE_SIZE || rect.height >= MIN_SHAPE_SIZE) pressOwned = true
      preview.showMarquee(rect)
    }
  })
  preview.stage.on('pointerup pointercancel', () => {
    if (marqueeStart) {
      finishMarquee()
      return
    }
    void finishDraw()
  })
  // Hover is the canvas half of the bidirectional highlight. It only ever draws the overlay layer
  // and toggles one row class, so it cannot re-enter itself through the node under the cursor.
  preview.stage.on('pointermove', () => {
    if (drawStart || marqueeStart || activeTool !== 'move' || !doc) return
    const point = preview.scenePoint()
    setHovered(point ? hitTest(doc, point.x, point.y)?.id : undefined)
  })
  preview.stage.on('pointerleave', () => setHovered(undefined))
  preview.stage.on('click', (event) => canvasClick(false, event.evt))
  preview.stage.on('dblclick', (event) => canvasClick(true, event.evt))
  wirePan()
}

/**
 * A canvas click selects the **outermost** group; a double-click descends one level along the path
 * to what was actually hit, and `Esc` ascends. The panel is the other half of this and selects at
 * whatever depth the row sits — which is the reason both exist.
 */
function canvasClick(descend: boolean, event: MouseEvent): void {
  // A swept band or a handle gesture owns its release (`pressOwned`). The flag is cleared by the
  // next press rather than by this click, because Konva also fires `dblclick` for a second click
  // inside its 400ms window, and that would arrive after the flag had been spent.
  if (pressOwned) return
  if (activeTool !== 'move' || !doc) return
  const point = preview.scenePoint()
  const hit = point ? hitTest(doc, point.x, point.y) : undefined
  if (!hit) {
    frameSelected = false
    setSelection([])
    return
  }
  const path = nodePath(doc.nodes, hit.id) ?? [hit]
  // A double-click on a text node enters it. Descending into a group is the other meaning of a
  // double-click, and a text node is a leaf, so the two never compete for the same gesture.
  if (descend && hit.type === 'text') {
    setSelection([hit.id])
    beginTextEdit(hit.id)
    return
  }
  if (descend) {
    const current = path.findIndex((node) => selection.includes(node.id))
    setSelection([(path[Math.min(path.length - 1, current + 1)] ?? hit).id])
    return
  }
  // Descending stays descended: clicking a shape already selected inside a group keeps that depth.
  const target = clickTarget(doc, selection, hit.id)
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    setSelection(selection.includes(target) ? selection.filter((id) => id !== target) : [...selection, target])
    return
  }
  setSelection([target])
}

/** The arrows nudge 1 scene unit, `Shift` and the arrows nudge 10. */
const NUDGE: Record<string, { x: number; y: number } | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

/**
 * How far a duplicate or a paste is offset from its original, in scene units. Enough that the copy
 * is visibly a second object rather than looking like nothing happened.
 */
const PASTE_OFFSET = 10

/**
 * Copied nodes live here rather than on the system clipboard.
 *
 * The system clipboard would mean serialising the document out of the page, which is a new kind of
 * data leaving the editor for something a user expects to stay inside one session. Nothing here is
 * persisted, so it changes no disclosure surface.
 */
let clipboard: SceneNode[] = []

/** A nudge is one gesture and therefore one undo step, exactly like a drag. */
function nudgeSelection(x: number, y: number): void {
  pushUndo()
  commitGesture([1, 0, 0, 1, x, y])
}

function copySelection(): void {
  clipboard = selectedNodes().map((node) => structuredClone(node) as SceneNode)
}

function duplicateSelection(inPlace = false): boolean {
  if (inPlace) return doc ? duplicateNodesInPlace(doc.nodes, selection) : false
  insertCopies(selectedNodes())
  return selection.length > 0
}

function reorderSelection(move: OrderMove): void {
  const current = doc
  if (!current || selection.length === 0) return
  const nodes = structuredClone(current.nodes)
  if (!reorderNodes(nodes, selection, move)) return
  pushUndo()
  current.nodes = nodes
  void changed()
}

function paste(): void {
  insertCopies(clipboard)
}

/**
 * Puts fresh copies of `nodes` at the top of the document, offset, and selects them.
 *
 * They land at the root rather than back inside whatever group they came from: a paste into a group
 * the user cannot see the boundary of is the kind of surprise that costs an undo to discover, and
 * `Cmd G` puts them back in one keystroke if that is what was wanted.
 */
function insertCopies(nodes: readonly SceneNode[]): void {
  const current = doc
  if (!current || nodes.length === 0) return
  pushUndo()
  const copies = nodes.map((node) => cloneSubtree(node))
  for (const copy of copies) {
    const transform = (copy as KnownNode).transform
    if (transform) {
      transform.x += PASTE_OFFSET
      transform.y += PASTE_OFFSET
    }
    current.nodes.push(copy)
  }
  setSelection(copies.map((copy) => copy.id))
  void changed()
}

function selectedNodes(): KnownNode[] {
  const current = doc
  if (!current) return []
  return selection.map((id) => findNode(current.nodes, id)).filter((node): node is KnownNode => node !== undefined)
}

function deleteSelection(): void {
  if (!doc || selection.length === 0) return
  pushUndo()
  for (const id of selection) detachNode(doc.nodes, id)
  setSelection([])
  void changed()
}

/**
 * The Appearance menu: this object's style becomes what the next one of its kind starts from, or
 * that type's default goes back to factory.
 *
 * `extractToolDefault` is the same reader the defaults dialog writes through, density and all, so a
 * stroke saved from a 2x capture comes back the same visual weight on a 1x one. Reset writes the
 * factory entry for that one type; `resetEditorDefaults` is the whole-file reset and stays in the
 * defaults dialog, where it says so.
 */
async function applyToolDefault(action: 'save' | 'reset'): Promise<boolean> {
  const node = selectedNodes()[0]
  if (!doc || !node || selection.length !== 1 || isGroupNode(node) || !DEFAULTABLE_KEYS[node.type]) return false
  const type = node.type
  editorDefaults = await putEditorDefaults({
    ...editorDefaults,
    tools: {
      ...editorDefaults.tools,
      [type]: action === 'save'
        ? extractToolDefault(node, doc.capture.density)
        : structuredClone(DEFAULT_EDITOR_DEFAULTS.tools[type]),
    },
  })
  showEditorAlert(
    action === 'save' ? `Saved as the ${type} default` : `${type[0]?.toUpperCase()}${type.slice(1)} default reset`,
    'success',
  )
  return true
}

function toggleSelectionVisibility(): void {
  const nodes = selectedNodes()
  if (nodes.length === 0) return
  pushUndo()
  const hide = nodes.some((node) => node.hidden !== true)
  for (const node of nodes) node.hidden = hide
  void changed()
}

function groupSelection(): void {
  if (!doc || selection.length < 2) return
  pushUndo()
  const group = groupNodes(doc.nodes, selection)
  if (!group) {
    undoStack.pop()
    return
  }
  setSelection([group.id])
  void changed()
}

function ungroupSelection(): void {
  const current = doc
  if (!current) return
  const groups = selectedNodes().filter(isGroupNode)
  if (groups.length === 0) return
  pushUndo()
  const freed = groups.flatMap((group) => ungroupNode(current.nodes, group.id))
  setSelection(freed)
  void changed()
}

/** `Esc` ascends a group level, then clears the selection, then returns to Move. */
function escape(): void {
  if (cropMode) {
    cancelCrop()
    return
  }
  const current = doc
  const first = selection[0]
  const parent = current && first !== undefined ? parentOf(current.nodes, first) : undefined
  if (parent) {
    setSelection([parent.id])
    return
  }
  if (selection.length > 0 || frameSelected) {
    frameSelected = false
    setSelection([])
    return
  }
  setTool('move')
}

/**
 * Hand-tool, Space+drag and middle-drag panning. Native listeners on the stage host rather than
 * Konva events, so a pan cannot be mistaken for a draw.
 */
function wirePan(): void {
  let pan: { x: number; y: number; scrollLeft: number; scrollTop: number } | undefined
  stageHost.addEventListener('pointerdown', (event) => {
    if (event.button !== 1 && (event.button !== 0 || (activeTool !== 'hand' && !spaceDown))) return
    event.preventDefault()
    pan = { x: event.clientX, y: event.clientY, scrollLeft: canvasScroll.scrollLeft, scrollTop: canvasScroll.scrollTop }
    stageHost.setPointerCapture(event.pointerId)
    // A closed hand for the length of the pan, whichever of Hand, Space or middle-drag started it.
    stageHost.dataset.pan = 'dragging'
  })
  stageHost.addEventListener('pointermove', (event) => {
    if (!pan) return
    canvasScroll.scrollLeft = pan.scrollLeft - (event.clientX - pan.x)
    canvasScroll.scrollTop = pan.scrollTop - (event.clientY - pan.y)
  })
  const endPan = (event: PointerEvent): void => {
    if (!pan) return
    stageHost.releasePointerCapture(event.pointerId)
    pan = undefined
    if (spaceDown) stageHost.dataset.pan = 'ready'
    else delete stageHost.dataset.pan
  }
  stageHost.addEventListener('pointerup', endPan)
  stageHost.addEventListener('pointercancel', endPan)
}

/** The rectangle two scene points span, whichever way round they were given. */
function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/**
 * The end of a rubber band. A band smaller than a shape is a click that missed, and the click
 * handler is already about to clear the selection — so it selects nothing rather than everything
 * under a one-pixel rectangle.
 */
function finishMarquee(): void {
  const start = marqueeStart
  marqueeStart = undefined
  preview.clearDraft()
  const end = preview.scenePoint()
  if (!start || !end || !doc) return
  const rect = rectBetween(start, end)
  if (rect.width < MIN_SHAPE_SIZE && rect.height < MIN_SHAPE_SIZE) return
  setSelection(nodesInRect(doc, rect))
}

/** Scene units at density 1; the handles and the inspector's Size row take it from there. */
const EMOJI_SIZE = 48

/** E and the dock button open the picker; the Emoji tool shows pressed while it is open. */
function openEmojiPicker(): void {
  if (cropMode || !doc) return
  setTool('emoji')
  emojiPicker.open(recentEmoji)
}

function dismissEmojiPicker(): void {
  emojiPicker.close()
  setTool('move')
}

/** `?`, the zoom pill's ? button and the zoom menu's Keyboard shortcuts row open the overlay; Esc, a scrim click or `?` again closes it. */
function openShortcuts(): void {
  shortcutOverlay.open()
  syncShortcutExpanded()
}

function closeShortcuts(): void {
  shortcutOverlay.close()
  syncShortcutExpanded()
}

function syncShortcutExpanded(): void {
  requiredElement<HTMLButtonElement>('shortcut-help').setAttribute('aria-expanded', String(shortcutOverlay.isOpen))
}

/**
 * Clicking an emoji adds it at once (not click-to-place), centred in the visible
 * canvas at a default size: one undo step, selected, then back to Move so it can be dragged into place.
 */
async function chooseEmoji(char: string): Promise<void> {
  emojiPicker.close()
  if (!doc) return
  const point = preview.sceneAt(preview.stage.width() / 2, preview.stage.height() / 2)
  const size = EMOJI_SIZE * doc.capture.density
  const node: ShapeNode = {
    id: newNodeId(),
    transform: { ...IDENTITY, x: point.x - size / 2, y: point.y - size / 2 },
    type: 'emoji',
    char,
    fontSize: size,
    width: size,
    height: size,
    opacity: 1,
  }
  applyToolDefaults(node, editorDefaults.tools.emoji, doc.capture.density)
  pushUndo()
  doc.nodes.push(node)
  setTool('move')
  recentEmoji = withRecentEmoji(recentEmoji, char)
  void putSetting('editorEmojiRecent', recentEmoji).catch(() => undefined)
  await changed()
  setSelection([node.id])
}

/**
 * Adds pictures from the Image tool's file chooser or a drop on the canvas: centred on the drop point,
 * or on the visible canvas, at their own pixel size unless that overflows most of the view. One undo
 * step, all selected, then back to Move so they can be dragged into place, as an emoji is.
 */
async function insertImages(files: readonly File[], at?: { x: number; y: number }): Promise<void> {
  if (!doc || cropMode) return
  const pictures = files.filter((file) => IMAGE_TYPES.includes(file.type))
  if (pictures.length === 0) {
    showEditorAlert('Only PNG, JPEG, WebP and GIF pictures can be added.')
    return
  }
  const topLeft = preview.sceneAt(0, 0)
  const bottomRight = preview.sceneAt(preview.stage.width(), preview.stage.height())
  const centre = at ?? { x: (topLeft.x + bottomRight.x) / 2, y: (topLeft.y + bottomRight.y) / 2 }
  const read = await Promise.all(pictures.map((file) => readPicture(file).catch(() => undefined)))
  const current = doc
  if (!current) return
  const nodes: ShapeNode[] = []
  for (const picture of read) {
    if (!picture) continue
    const fit = Math.min(1, ((bottomRight.x - topLeft.x) * 0.8) / picture.width, ((bottomRight.y - topLeft.y) * 0.8) / picture.height)
    const width = picture.width * fit
    const height = picture.height * fit
    // Several dropped at once fan out rather than stacking exactly.
    const offset = nodes.length * 24 * current.capture.density
    nodes.push({ id: newNodeId(), transform: { ...IDENTITY, x: centre.x - width / 2 + offset, y: centre.y - height / 2 + offset }, type: 'image', src: picture.src, width, height, opacity: 1 })
  }
  if (nodes.length === 0) {
    showEditorAlert('That picture could not be read.')
    return
  }
  pushUndo()
  current.nodes.push(...nodes)
  setTool('move')
  await changed()
  setSelection(nodes.map((node) => node.id))
}

async function readPicture(file: File): Promise<{ src: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  let blob: Blob = file
  if (scale < 1) {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
    // WebP keeps transparency, and at this size it is a fraction of a PNG.
    blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
  }
  bitmap.close()
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(blob)
  })
  if (!isImageSource(src)) throw new Error('unsupported picture')
  return { src, width, height }
}

/**
 * Files dragged over the canvas raise the drop zone; dropped, they become pictures where they land.
 * Anywhere else in the editor a dropped file is swallowed, or Chrome would navigate away to it and
 * take the unsaved edits with it.
 */
function wireImageDrop(): void {
  const canvas = requiredElement<HTMLElement>('canvas')
  const zone = requiredElement<HTMLElement>('drop-zone')
  const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true
  const show = (on: boolean): void => {
    zone.hidden = !on
  }
  window.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    const inside = canvas.contains(event.target as Node) && doc !== undefined && !cropMode
    if (event.dataTransfer) event.dataTransfer.dropEffect = inside ? 'copy' : 'none'
    show(inside)
  })
  window.addEventListener('dragleave', (event) => {
    // Leaving for another element inside the canvas is not leaving.
    if (!event.relatedTarget || !canvas.contains(event.relatedTarget as Node)) show(false)
  })
  window.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    show(false)
    if (!canvas.contains(event.target as Node)) return
    const box = stageHost.getBoundingClientRect()
    void insertImages([...(event.dataTransfer?.files ?? [])], preview.sceneAt(event.clientX - box.left, event.clientY - box.top))
  })
  const chooser = requiredElement<HTMLInputElement>('image-file')
  chooser.accept = IMAGE_TYPES.join(',')
  chooser.addEventListener('change', () => {
    void insertImages([...(chooser.files ?? [])])
    chooser.value = ''
  })
  requiredElement<HTMLButtonElement>('image-tool').addEventListener('click', () => chooser.click())

  // A copy in the editor takes over the system clipboard too, so a picture copied elsewhere earlier
  // cannot win over the shapes just copied here: the most recent copy is what Cmd+V pastes.
  const claim = (event: ClipboardEvent): void => {
    if (!copiedHere) return
    copiedHere = false
    event.preventDefault()
    event.clipboardData?.setData('application/x-pageshotter-shapes', '1')
  }
  document.addEventListener('copy', claim)
  document.addEventListener('cut', claim)
  document.addEventListener('paste', (event) => {
    if (typingTarget(event.target)) return
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => IMAGE_TYPES.includes(file.type))
    event.preventDefault()
    if (files.length > 0) void insertImages(files)
    else if (clipboard.length > 0) paste()
  })
}

/** Set by the Cmd+C / Cmd+X that copied shapes, for the clipboard event that follows. */
let copiedHere = false

function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
}

/**
 * The Text tool adds a text box at once (not click-to-place), centred in the
 * visible canvas and open for typing with its placeholder selected, so the first keystroke replaces it.
 */
async function insertText(): Promise<void> {
  if (!doc || cropMode || editing) return
  const density = doc.capture.density
  const width = 180 * density
  const fontSize = 20 * density
  const point = preview.sceneAt(preview.stage.width() / 2, preview.stage.height() / 2)
  const node: ShapeNode = {
    id: newNodeId(),
    transform: { ...IDENTITY, x: point.x - width / 2, y: point.y - fontSize * 0.6 },
    type: 'text',
    width,
    height: fontSize * 1.2,
    text: 'Enter text here',
    fontSize,
    fontWeight: 500,
    align: 'left',
    color: DEFAULT_STROKE,
    stroke: 'none',
    strokeWidth: 2 * density,
    opacity: 1,
  }
  applyToolDefaults(node, editorDefaults.tools.text, density)
  pushUndo()
  doc.nodes.push(node)
  setTool('move')
  // Opened before the render resolves: keys typed straight after T would otherwise reach the
  // document while it draws and fire tool shortcuts instead of landing in the text.
  beginTextEdit(node.id, true)
  await changed()
  setSelection([node.id])
  // The render built a fresh, visible copy of the node under the textarea, if the edit is still open.
  if (!textEditor.hidden) preview.concealNode(node.id)
}

async function finishDraw(): Promise<void> {
  const start = drawStart
  const raw = strokeRaw
  drawStart = undefined
  strokeRaw = undefined
  preview.clearDraft()
  if (!start || !doc || !isDrawTool(activeTool)) return
  if (raw) {
    await finishStroke(raw, activeTool)
    return
  }
  const end = preview.scenePoint()
  if (!end) return
  const drag = constrainDrag(shapeTypeOf(activeTool), start, end, preview.drawModifiers())
  const node = nodeFromDrag(shapeTypeOf(activeTool), drag.start, drag.end, doc.capture.density)
  if (!node) return
  // A freshly drawn shape starts from the tool's saved defaults, not the factory ones.
  applyToolDefaults(node, editorDefaults.tools[node.type], doc.capture.density)
  // `nodeFromDrag` cannot see the document, so the badge arrives as a 1 and gets its real number
  // here, against everything already placed.
  if (node.type === 'counter') node.count = nextCount(doc.nodes)
  // The lens starts to the right of what it magnifies; with no room there, to the left.
  if (node.type === 'magnifier') placeLens(node, doc.capture.width, doc.capture.height)
  pushUndo()
  doc.nodes.push(node)
  // Every tool is one-shot, the counter included: place one and it is selected under Move. The counter
  // used to stay armed for a run of numbers; it goes back to Move like the rest.
  setTool('move')
  await changed()
  setSelection([node.id])
  // A new text node is opened for typing straight away, and cancelling removes it again, so a
  // stray click with the Text tool leaves nothing behind.
  if (node.type === 'text') beginTextEdit(node.id, true)
}

/**
 * A finished pen or marker stroke.
 *
 * The raw samples are resampled and smoothed **once, here**, and only the result is stored -- the
 * pointer's own jitter is never written into the document. A stroke that went nowhere (a click, or
 * a twitch) is dropped rather than committed as a dot nobody can see or select.
 */
async function finishStroke(raw: number[], tool: DrawTool): Promise<void> {
  if (!doc) return
  const density = doc.capture.density
  const points = smoothStroke(raw, STROKE_SPACING * density)
  if (points.length < 4) return
  const originX = points[0] ?? 0
  const originY = points[1] ?? 0
  const node: ShapeNode = {
    id: newNodeId(),
    transform: { ...IDENTITY, x: originX, y: originY },
    type: 'freehand',
    // Stored relative to the first point, as a segment's are, so moving the stroke is a transform
    // write and never a walk over every point.
    points: points.map((value, index) => value - (index % 2 === 0 ? originX : originY)),
    stroke: DEFAULT_STROKE,
    strokeWidth: Math.max(2, 3 * density),
    ...(tool === 'marker' ? { marker: true as const } : {}),
    opacity: 1,
  }
  // Keyed by the **tool**, not the node type. Pen and Marker make the same node and must not share
  // a default: they did at first, and a Marker drawing in the pen's thin blue is indistinguishable
  // from a Pen, because a `multiply` stroke over a white page is pixel-identical to a normal one.
  applyToolDefaults(node, editorDefaults.tools[tool === 'marker' ? 'marker' : 'freehand'], density)
  // The tool decides the composite, and nothing else does.
  if (tool === 'marker') node.marker = true
  else delete node.marker
  pushUndo()
  doc.nodes.push(node)
  // Like the counter, a stroke tool stays armed: drawing is a run of strokes, not one.
  await changed()
}

/**
 * Text editing: a transparent `textarea` over the node, matching its font, size, colour, line
 * height and alignment, with only that node hidden underneath.
 *
 * On the canvas rather than in the inspector because typing belongs where the text is, and in the
 * DOM rather than on the canvas because Konva has no caret, no selection and no IME. The whole edit
 * commits as **one** undo step, not one per keystroke.
 */
function beginTextEdit(id: string, fresh = false): void {
  const current = doc
  const node = current ? findNode(current.nodes, id) : undefined
  if (!current || !node || isGroupNode(node) || node.type !== 'text' || editing) return
  // Snapshotted now, not at the end: the text is written into the document as it is typed. A fresh
  // node already has its snapshot, from being placed. Pushed directly rather than by `pushUndo`,
  // which clears redo: opening an edit and leaving it unchanged must not cost the redo history.
  if (!fresh) {
    undoStack.push(snapshot(current))
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  }
  editing = { id, before: node.text, fresh }
  textEditor.hidden = false
  textEditor.value = node.text
  placeTextEditor(node)
  // Laid out at the node's own size and scaled by the view, because the canvas draws the text at
  // `fontSize` and scales the result. Setting `fontSize × scale` instead let the system font pick a
  // different optical size, so every line changed width when the edit opened and closed.
  textEditor.style.width = `${node.width}px`
  // The canvas copy is concealed while this is open, so a filled box has to be drawn here, or white
  // letters are typed onto a white page. `border-box`: the box is the node's size, the text inset.
  const inset = textInset(node)
  textEditor.style.boxSizing = 'border-box'
  textEditor.style.padding = `${inset.y}px ${inset.x}px`
  textEditor.style.background = node.fill ?? ''
  textEditor.style.borderRadius = node.fill === undefined ? '' : `${Math.min(node.fontSize * 0.3, node.width / 2)}px`
  textEditor.style.font = `${textFontStyle(node)} ${node.fontSize}px/1.2 ${textFontFamily(node)}`
  // The outline as the canvas draws it: stroke under the fill, so the text does not change while typed.
  textEditor.style.webkitTextStroke = hasStroke(node) ? `${node.strokeWidth}px ${node.stroke}` : ''
  textEditor.style.paintOrder = 'stroke fill'
  textEditor.style.color = node.color
  textEditor.style.textAlign = node.align
  fitTextEditor()
  preview.concealNode(id)
  textEditor.focus()
  textEditor.select()
}

/**
 * Puts the open textarea over its node at the current zoom and scroll. Run on every viewport change
 * as well as on opening: placed once, it kept the old zoom's size and position when the view zoomed
 * or scrolled mid-edit.
 */
function placeTextEditor(node: TextNode): void {
  const at = preview.stageAt(node.transform.x, node.transform.y)
  const host = stageHost.getBoundingClientRect()
  const canvasBox = canvas.getBoundingClientRect()
  textEditor.style.left = `${host.left - canvasBox.left + at.x}px`
  textEditor.style.top = `${host.top - canvasBox.top + at.y}px`
  textEditor.style.transformOrigin = '0 0'
  textEditor.style.transform = `scale(${preview.viewScale()}) rotate(${node.transform.rotation}deg)`
}

/** Every zoom and scroll comes through here, so an open text edit follows the view. */
function syncViewport(): void {
  preview.setViewport(viewScale, canvasScroll.scrollLeft, canvasScroll.scrollTop)
  const node = editing && doc ? findNode(doc.nodes, editing.id) : undefined
  if (node && !isGroupNode(node) && node.type === 'text') placeTextEditor(node)
}

/**
 * Grows the textarea to what has been typed, never below the box, so typing is never hidden:
 * an auto-height box grows with it, and a fixed box shows its overflow while the edit is open.
 */
function fitTextEditor(): void {
  const node = editing && doc ? findNode(doc.nodes, editing.id) : undefined
  if (!node || isGroupNode(node) || node.type !== 'text') return
  // Scene units: the view scale is a transform on the textarea, which leaves its layout box unscaled.
  const floor = node.fixedHeight ? node.height : node.fontSize * 1.2 + textInset(node).y * 2
  textEditor.style.height = `${floor}px`
  textEditor.style.height = `${Math.max(textEditor.clientHeight, textEditor.scrollHeight)}px`
}

/**
 * Ends the edit. `commit` false is `Esc`: the text goes back to what it said, and a node that was
 * placed by this gesture is removed rather than left as an invisible empty node nobody can click.
 */
function endTextEdit(commit: boolean): void {
  const edit = editing
  const current = doc
  if (!edit || !current) return
  editing = undefined
  textEditor.hidden = true
  preview.concealNode(undefined)
  const node = findNode(current.nodes, edit.id)
  if (!node || isGroupNode(node) || node.type !== 'text') return
  const value = commit ? textEditor.value : edit.before
  if (value.trim() === '') {
    // An empty text node draws nothing and cannot be picked on the canvas. Deleting it is the only
    // honest outcome; the undo snapshot from the placement puts the whole thing back.
    detachNode(current.nodes, edit.id)
    setSelection([])
    void changed()
    return
  }
  if (value === edit.before) {
    // Nothing changed after all (or Esc): the typing is put back, and an edit of an existing node
    // drops the snapshot it took on opening, so it leaves no empty undo step.
    node.text = edit.before
    if (!edit.fresh) undoStack.pop()
    void changed()
    return
  }
  // A real change: now redo goes, as any other edit's `pushUndo` would have cleared it.
  redoStack.length = 0
  node.text = value
  // Typing past a fixed box grows it instead of clipping what was just typed; only a deliberate
  // resize makes a box shorter than its text.
  if (node.fixedHeight) resizeTextBox(node, node.width, Math.max(node.height, measureTextHeight(node)))
  void changed()
}

/**
 * Undo is a stack of whole-document snapshots, one per **user gesture**.
 *
 * Every editing path calls `pushUndo` exactly once before it touches the document — a drag, a
 * rename, an eye, a lock, a reorder, a group, a scrub of an inspector field — so a scrub from 40 to
 * 90 is one step and not fifty, and a group drag that moves six children is one step and not six.
 * The snapshot is the document rather than only its nodes, because the canvas section edits
 * background, margin and crop, and an undo that restored the shapes but not the margin would be
 * telling half the truth.
 *
 * Snapshots rather than commands: the document is a few kilobytes of plain data, `snapshot` is one
 * call, and an inverse operation per gesture is a second implementation of every edit to get
 * wrong. The capture's pixels are never in here — they live in the tiles, untouched.
 */
/**
 * A deep copy that **shares strings** rather than copying them, as `structuredClone` would. An added
 * picture is a data URL of a megabyte or more, and fifty undo steps must not hold fifty copies of it.
 */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)])) as T
}

const undoStack: SceneDoc[] = []
const redoStack: SceneDoc[] = []
const UNDO_LIMIT = 50

function pushUndo(): void {
  if (!doc) return
  undoStack.push(snapshot(doc))
  if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  redoStack.length = 0
}

function undo(): void {
  step(undoStack, redoStack)
}

function redo(): void {
  step(redoStack, undoStack)
}

function step(from: SceneDoc[], to: SceneDoc[]): void {
  const previous = from.pop()
  if (!previous || !doc) return
  to.push(snapshot(doc))
  doc = previous
  setSelection(selection)
  void changed()
}

/**
 * The appearance the shape being dragged should have: the one its committed node will actually get.
 *
 * Built by running the same two functions the commit runs -- `nodeFromDrag` for the factory values
 * and `applyToolDefaults` for the user's -- over a throwaway probe node, then reading the result
 * back through `readInspectorField`. Doing it that way rather than re-deriving the values is the
 * point: the draft used to be a hard-coded #E11900 at 6px, so a drag looked red whatever the
 * defaults said and then snapped to the real colour on release.
 *
 * The probe is 1000x1000 so it clears `MIN_SHAPE_SIZE` and a style exists even for a drag that is
 * still too small to commit.
 */
function draftStyle(tool: DrawTool): DraftStyle {
  const density = doc?.capture.density ?? 1
  /*
   * A blur has no colour of its own -- `DEFAULTABLE_KEYS.blur` is radius and opacity -- so there is
   * no annotation colour to draw its draft in, and falling back to `DEFAULT_STROKE` outlined the
   * region being blurred in red. A blur's outline is chrome saying "this area", which is `--select`,
   * the same blue the committed blur's selection outline uses.
   */
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--select').trim() || SELECT_FALLBACK
  const hasOwnColour = tool !== 'blur'
  const fallback: DraftStyle = {
    stroke: hasOwnColour ? DEFAULT_STROKE : chrome,
    strokeWidth: Math.max(2, 3 * density),
    fill: undefined,
    opacity: 0.75,
  }
  const probe = nodeFromDrag(shapeTypeOf(tool), { x: 0, y: 0 }, { x: 1000, y: 1000 }, density)
  if (!probe) return fallback
  // By tool, so the Marker draft is drawn in the marker's weight and colour rather than the pen's.
  applyToolDefaults(probe, editorDefaults.tools[tool === 'marker' ? 'marker' : probe.type], density)
  // `color` is what highlight and text carry instead of `stroke`.
  const stroke = readInspectorField(probe, 'stroke') ?? readInspectorField(probe, 'color')
  const fill = readInspectorField(probe, 'fill') ?? (probe.type === 'highlight' ? readInspectorField(probe, 'color') : undefined)
  const strokeWidth = readInspectorField(probe, 'strokeWidth')
  const opacity = readInspectorField(probe, 'opacity')
  return {
    stroke: typeof stroke === 'string' && stroke !== 'none' ? stroke : fallback.stroke,
    strokeWidth: typeof strokeWidth === 'number' && strokeWidth > 0 ? strokeWidth : fallback.strokeWidth,
    fill: typeof fill === 'string' && fill !== 'none' ? fill : undefined,
    opacity: typeof opacity === 'number' ? opacity : 1,
  }
}

/**
 * One endpoint of a straight arrow or line moved. The undo step was already pushed by the gesture's
 * `begin`, so this only writes the points and lets the usual change pass redraw everything.
 *
 * `live` is every frame of the drag, and takes the cheap half: the inspector reads the angle it has
 * just written, and nothing re-renders the canvas, re-tiles the export or bumps `editVersion` --
 * Konva is already drawing the segment itself from the handle's own `dragmove`.
 */
function commitPoints(id: string, points: number[], live = false): void {
  const current = doc
  if (!current) return
  const node = findNode(current.nodes, id)
  if (node?.type === 'magnifier') {
    // The lens's handles: its centre, already in the node's parent frame, and its zoom.
    const [x = 0, y = 0, zoom = node.lens.zoom] = points
    node.lens = { x, y, zoom }
    if (!live) void changed()
    return
  }
  if (node?.type === 'counter' || (node?.type === 'text' && node.fill !== undefined)) {
    // The counter's one handle is its pin tip, carried through the same channel a segment's ends
    // use rather than a second commit path: one point in, `tip` out.
    const [x = 0, y = 0] = points
    node.tip = { x, y }
    if (live) {
      inspector.render()
      return
    }
    void changed()
    return
  }
  if (!node || (node.type !== 'arrow' && node.type !== 'line')) return
  node.points = points.slice(0, 4)
  // An arrow's third handle is where its curve passes halfway; stored as a bend off the ends' midpoint.
  if (node.type === 'arrow' && points.length >= 6) {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, mx = 0, my = 0] = points
    const bend = { x: mx - (x1 + x2) / 2, y: my - (y1 + y2) / 2 }
    if (Math.hypot(bend.x, bend.y) < 0.5) delete node.bend
    else node.bend = bend
  }
  if (live) {
    inspector.render()
    return
  }
  void changed()
}

function wireDock(): void {
  // The tooltip is the dock's own, not the browser's: `data-tip` carries the name and the key, and
  // `editor.css` draws it. A dock of icon-only buttons is unreadable without both.
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tool-dock button')) {
    const label = button.getAttribute('aria-label')
    if (label) button.dataset.tip = label
  }
  /*
   * The theme toggle, shared with every other extension surface. Two things need doing after
   * `wireThemeButton`, because it rewrites the label on every click: copy the new label into
   * `data-tip` so the dock's own tooltip does not go stale, and drop the `title` it sets, which
   * would otherwise raise the browser's tooltip on top of the dock's.
   */
  const themeButton = requiredElement<HTMLButtonElement>('editor-theme')
  const syncThemeTip = (): void => {
    themeButton.dataset.tip = themeButton.getAttribute('aria-label') ?? 'Theme'
    themeButton.removeAttribute('title')
  }
  void wireThemeButton(themeButton, document.documentElement).then(syncThemeTip)
  themeButton.addEventListener('click', syncThemeTip)
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.addEventListener('click', () => {
      if (button.disabled) return
      if (button.dataset.tool === 'emoji') openEmojiPicker()
      else if (button.dataset.tool === 'text') void insertText()
      else setTool(button.dataset.tool as Tool)
    })
  }
  cropButton.addEventListener('click', () => {
    if (cropMode) commitCrop()
    else void enterCrop()
  })
  presentButton.addEventListener('click', () => togglePresent())
  for (const grouped of document.querySelectorAll<HTMLElement>('.grouped-tool')) wireFlyout(grouped)
  document.addEventListener('click', (event) => {
    const target = event.target as Node
    if (emojiPicker.isOpen && !requiredElement<HTMLElement>('emoji-slot').contains(target)) dismissEmojiPicker()
    for (const grouped of document.querySelectorAll<HTMLElement>('.grouped-tool')) {
      if (!grouped.contains(target)) openFlyout(grouped, false)
    }
  })
  document.addEventListener('keydown', (event) => {
    const command = event.metaKey || event.ctrlKey
    const orderMove: OrderMove | undefined =
      command && (event.key === ']' || event.key === '}')
        ? event.shiftKey
          ? 'front'
          : 'forward'
        : command && (event.key === '[' || event.key === '{')
          ? event.shiftKey
            ? 'back'
            : 'backward'
          : undefined
    // The sheet's own `cancel` handler hands Escape to `closeShortcuts` too, but Escape also reaches
    // here, where it would ascend a group and deselect underneath a dialog that is merely closing.
    if (shortcutOverlay.isOpen && event.key === 'Escape') {
      event.preventDefault()
      closeShortcuts()
      return
    }
    // Nothing else reaches the canvas from inside the sheet: with focus on one of its buttons, a bare
    // `R` would otherwise switch tools behind the modal. `?` still toggles it shut.
    if (shortcutOverlay.isOpen && event.key !== '?') return
    if (cropMode && event.key === 'Escape') {
      event.preventDefault()
      cancelCrop()
      return
    }
    if (cropMode && event.key === 'Enter') {
      event.preventDefault()
      if (event.target instanceof HTMLElement) event.target.blur()
      commitCrop()
      return
    }
    // A focused field owns its keys, so `⌘A` selects its text and `⌘Z` undoes its typing
    // instead of reaching the canvas. Esc and Enter above still serve crop mode's own fields.
    if (typingOwnsKey(event.target instanceof HTMLElement ? event.target : null, event)) return
    if (cropMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      cancelCrop()
      return
    }
    if (cropMode) {
      const key = event.key.toLowerCase()
      const commandEdit =
        command &&
        (orderMove !== undefined || ['g', 'a', 'd', 'c', 'v', 'x'].includes(key) || (event.shiftKey && key === 'h'))
      const canvasEdit =
        event.key === 'Delete' ||
        event.key === 'Backspace' ||
        key in NUDGE ||
        ['r', 'o', 'a', 'l', 't', 'b', 'u', 'e', 'n', 'd', 'k'].includes(key)
      if (commandEdit || canvasEdit) {
        event.preventDefault()
        return
      }
    }
    if (command && event.key === '\\') {
      event.preventDefault()
      toggleMinimized()
      return
    }
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (command && event.key.toLowerCase() === 'g') {
      event.preventDefault()
      if (event.shiftKey) ungroupSelection()
      else groupSelection()
      return
    }
    if (command && event.shiftKey && event.key.toLowerCase() === 'h') {
      event.preventDefault()
      toggleSelectionVisibility()
      return
    }
    if (command && event.key.toLowerCase() === 'a' && doc) {
      event.preventDefault()
      setSelection(doc.nodes.map((node) => node.id))
      return
    }
    if (command && ['+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault()
      setZoom(viewScale + (event.key === '+' || event.key === '=' ? 0.1 : -0.1), false)
      return
    }
    if (command && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      duplicateSelection()
      return
    }
    if (command && event.key.toLowerCase() === 'c' && selection.length > 0) {
      copiedHere = true
      copySelection()
      return
    }
    // Cut is copy then delete, and `deleteSelection` makes it one undo step.
    if (command && event.key.toLowerCase() === 'x' && selection.length > 0) {
      // Not prevented: the `cut` event that follows claims the system clipboard (`wireImageDrop`).
      copiedHere = true
      copySelection()
      deleteSelection()
      return
    }
    // Not handled here: the `paste` event decides between a picture and copied shapes (`wireImageDrop`).
    if (command && event.key.toLowerCase() === 'v') return
    if (orderMove) {
      event.preventDefault()
      reorderSelection(orderMove)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '?') {
      event.preventDefault()
      if (shortcutOverlay.isOpen) closeShortcuts()
      else openShortcuts()
      return
    }
    if (event.key === ' ') {
      // Space pans while held; a held key repeats, which is harmless for a boolean.
      event.preventDefault()
      spaceDown = true
      // An open hand while Space is held, unless a pan is already under way.
      if (stageHost.dataset.pan !== 'dragging') stageHost.dataset.pan = 'ready'
      return
    }
    if (event.key === 'Enter' && selection.length === 1) {
      const only = selection[0]
      const node = only === undefined ? undefined : findNode(doc?.nodes ?? [], only)
      if (node && !isGroupNode(node) && node.type === 'text') {
        event.preventDefault()
        beginTextEdit(only as string)
        return
      }
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      deleteSelection()
      return
    }
    // The layers panel owns the arrows while it has focus -- it walks its rows with them and calls
    // `preventDefault` -- so the canvas only nudges when the panel did not already answer.
    const zoomChoice = shiftZoomChoice(event)
    if (zoomChoice) {
      event.preventDefault()
      applyZoomChoice(zoomChoice)
      return
    }
    const nudge = NUDGE[event.key]
    if (nudge && !event.defaultPrevented && selection.length > 0) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      nudgeSelection(nudge.x * step, nudge.y * step)
      return
    }
    if (event.key.toLowerCase() === 'c') {
      if (cropMode) commitCrop()
      else void enterCrop()
      return
    }
    if (event.key.toLowerCase() === 'p') {
      togglePresent()
      return
    }
    if (event.key.toLowerCase() === 'i') {
      if (!cropMode) requiredElement<HTMLInputElement>('image-file').click()
      return
    }
    if (event.key.toLowerCase() === 'e') {
      // Default prevented so the E does not land in the search field the picker focuses.
      event.preventDefault()
      openEmojiPicker()
      return
    }
    const tools = { v: 'move', h: 'hand', r: 'rectangle', o: 'ellipse', a: 'arrow', l: 'line', t: 'text', b: 'blur', u: 'highlight', n: 'counter', m: 'magnifier', d: 'freehand', k: 'marker' } as const
    const tool: (typeof tools)[keyof typeof tools] | undefined = tools[event.key.toLowerCase() as keyof typeof tools]
    if (tool === 'text') {
      // Default prevented so the T does not land in the textarea `insertText` focuses, as with E.
      event.preventDefault()
      void insertText()
    } else if (tool) setTool(tool)
    if (event.key === 'Escape') escape()
  })
  document.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return
    spaceDown = false
    if (stageHost.dataset.pan === 'ready') delete stageHost.dataset.pan
  })
}

function wireFlyout(grouped: HTMLElement): void {
  const caret = requiredChild<HTMLButtonElement>(grouped, '.tool-caret')
  const main = requiredChild<HTMLButtonElement>(grouped, '.group-main')
  let held = false
  let timer = 0
  caret.addEventListener('click', (event) => {
    event.stopPropagation()
    openFlyout(grouped, caret.getAttribute('aria-expanded') !== 'true')
  })
  main.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openFlyout(grouped, true)
  })
  main.addEventListener('pointerdown', () => {
    held = false
    timer = window.setTimeout(() => {
      held = true
      openFlyout(grouped, true)
    }, 400)
  })
  main.addEventListener('pointerup', () => window.clearTimeout(timer))
  main.addEventListener('click', (event) => {
    if (held) event.stopImmediatePropagation()
  }, true)
}

function openFlyout(grouped: HTMLElement, open: boolean): void {
  const flyout = requiredChild<HTMLElement>(grouped, '.tool-flyout')
  const caret = requiredChild<HTMLButtonElement>(grouped, '.tool-caret')
  flyout.hidden = !open
  caret.setAttribute('aria-expanded', String(open))
}

function setTool(tool: Tool): void {
  if (cropMode && (isDrawTool(tool) || tool === 'emoji')) return
  if (tool !== 'emoji') emojiPicker.close()
  activeTool = tool
  // The grouped slots adopt the tool **first**, because they carry it on their own `data-tool` and
  // the pressed loop below reads that attribute. Marking pressed first meant a slot showing
  // Rectangle was never marked when `O` chose Ellipse -- and since Move lives in a slot, the dock
  // showed no active tool at all for the keyboard or either flyout.
  for (const grouped of document.querySelectorAll<HTMLElement>('.grouped-tool')) {
    const choice = grouped.querySelector<HTMLButtonElement>(`.tool-flyout [data-tool="${tool}"]`)
    if (!choice) continue
    const main = requiredChild<HTMLButtonElement>(grouped, '.group-main')
    const icon = requiredChild<SVGElement>(choice, '.icon')
    const mainIcon = requiredChild<SVGElement>(main, '[data-tool-icon]')
    main.dataset.tool = tool
    // The member's own name and key, so a grouped slot's tooltip says `Ellipse (O)` rather than
    // losing the key the moment the slot changes what it shows.
    const name = choice.querySelector('span')?.textContent?.trim() ?? tool
    const key = choice.querySelector('kbd')?.textContent?.trim() ?? ''
    const label = key === '' ? name : `${name} (${key})`
    main.setAttribute('aria-label', label)
    main.dataset.tip = label
    mainIcon.replaceChildren(...[...icon.childNodes].map((node) => node.cloneNode(true)))
    for (const row of grouped.querySelectorAll<HTMLButtonElement>('.tool-flyout [data-tool]')) {
      row.setAttribute('aria-checked', String(row.dataset.tool === tool))
    }
    openFlyout(grouped, false)
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tool-button[data-tool]')) {
    button.setAttribute('aria-pressed', String(cropMode === undefined && button.dataset.tool === tool))
  }
  // The canvas cursor follows the tool; `editor.css` maps this to a native cursor.
  stageHost.dataset.tool = tool
  syncHandles()
}

/**
 * A record rather than an array, because the keys of `Record<DrawTool, true>` are checked for
 * exhaustiveness and the members of a `DrawTool[]` are not. Counter was added to `DrawTool` and to
 * every switch the compiler guards, and this list -- the one thing standing between a tool and the
 * draw gesture -- silently stayed at seven. The tool built, typechecked and did nothing on click.
 */
const DRAW_TOOLS: Record<DrawTool, true> = {
  rectangle: true,
  ellipse: true,
  arrow: true,
  line: true,
  text: true,
  blur: true,
  highlight: true,
  counter: true,
  magnifier: true,
  freehand: true,
  marker: true,
}

function isDrawTool(tool: Tool): tool is DrawTool {
  return tool in DRAW_TOOLS
}

function wireZoom(): void {
  requiredElement<HTMLButtonElement>('zoom-out').addEventListener('click', () => setZoom(viewScale - 0.1, false))
  requiredElement<HTMLButtonElement>('zoom-in').addEventListener('click', () => setZoom(viewScale + 0.1, false))
  requiredElement<HTMLButtonElement>('zoom-fit').addEventListener('click', () => applyZoomChoice('fit'))
  requiredElement<HTMLButtonElement>('shortcut-help').addEventListener('click', () =>
    shortcutOverlay.isOpen ? closeShortcuts() : openShortcuts(),
  )
  const menu = requiredElement<HTMLElement>('zoom-menu')
  const openMenu = (open: boolean): void => {
    menu.hidden = !open
    zoomValue.setAttribute('aria-expanded', String(open))
  }
  zoomValue.addEventListener('click', (event) => {
    event.stopPropagation()
    // `hidden` widened to `boolean | 'until-found'`, and only an explicit false means open.
    openMenu(menu.hidden !== false)
  })
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) openMenu(false)
  })
  for (const entry of menu.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
    entry.addEventListener('click', () => {
      applyZoomChoice(entry.dataset.zoom ?? '')
      if (entry.dataset.zoom !== 'grid') openMenu(false)
    })
  }
}

/**
 * The zoom menu's seven entries. `Snap to grid` sits among them because that is where it
 * belongs — the only control in the editor that changes how a drag behaves without changing the document.
 */
function applyZoomChoice(choice: string): void {
  if (choice === 'grid') {
    preview.setGridSnap(!preview.gridSnapOn())
    requiredElement<HTMLButtonElement>('zoom-grid').setAttribute('aria-checked', String(preview.gridSnapOn()))
    return
  }
  if (choice === 'keys') return openShortcuts()
  if (choice === 'fit') return fit()
  if (choice === 'fill') return fill()
  if (choice === 'selection') return zoomToSelection()
  const scale = Number(choice)
  if (Number.isFinite(scale) && scale > 0) setZoom(scale, false)
}

/** Fill covers the canvas with the composition, so the *larger* ratio wins where Fit takes the smaller. */
function fill(): void {
  if (!doc) return
  const output = renderRect(doc, chromeBand(doc))
  const width = Math.max(1, canvas.clientWidth - 80)
  const height = Math.max(1, canvas.clientHeight - 80)
  setZoom(Math.max(width / output.width, height / output.height), false)
}

/** `Shift 2`: the selection fills the canvas, and stays centred on itself. */
function zoomToSelection(): void {
  const current = doc
  const bounds = current ? selectionBounds(current, selection) : undefined
  if (!current || !bounds) return
  const width = Math.max(1, canvas.clientWidth - 80)
  const height = Math.max(1, canvas.clientHeight - 80)
  setZoom(Math.min(4, width / Math.max(1, bounds.width), height / Math.max(1, bounds.height)), false)
  const output = renderRect(current, chromeBand(current))
  canvasScroll.scrollLeft =
    STAGE_PADDING + preview.slackX() + (bounds.x + bounds.width / 2 - output.x) * viewScale - stageHost.clientWidth / 2
  canvasScroll.scrollTop =
    STAGE_PADDING + preview.slackY() + (bounds.y + bounds.height / 2 - output.y) * viewScale - stageHost.clientHeight / 2
  syncViewport()
}

function fit(): void {
  if (!doc) return
  const output = renderRect(doc, chromeBand(doc))
  const width = Math.max(1, canvas.clientWidth - 80)
  const height = Math.max(1, canvas.clientHeight - 80)
  setZoom(Math.min(1, width / output.width, height / output.height), true)
}

/**
 * Zoom about a point rather than about the origin.
 *
 * `anchor` is in stage pixels — the pointer for `Cmd`+scroll, and the middle of the canvas for the
 * pill and the keys. Whatever scene point sits under it before the zoom sits under it afterwards,
 * which is what makes zooming feel like it is scaling the picture instead of dragging it away: the
 * scroll offsets are solved for that condition rather than left where the last zoom put them.
 */
function setZoom(scale: number, isFit: boolean, anchor?: { x: number; y: number }): void {
  const point = anchor ?? { x: stageHost.clientWidth / 2, y: stageHost.clientHeight / 2 }
  const held = preview.sceneAt(point.x, point.y)
  viewScale = Math.min(4, Math.max(0.05, Math.round(scale * 100) / 100))
  fitted = isFit
  zoomValue.textContent = isFit ? 'Fit' : `${Math.round(viewScale * 100)}%`
  // The space has to be resized first: the scroll offsets below cannot exceed a range that does not
  // exist yet, and a clamped scroll would put the anchor somewhere else.
  syncViewport()
  if (doc) {
    const output = renderRect(doc, chromeBand(doc))
    canvasScroll.scrollLeft = STAGE_PADDING + preview.slackX() + (held.x - output.x) * viewScale - point.x
    canvasScroll.scrollTop = STAGE_PADDING + preview.slackY() + (held.y - output.y) * viewScale - point.y
  }
  syncViewport()
}

function wirePanels(): void {
  requiredElement<HTMLButtonElement>('collapse-layers').addEventListener('click', () => togglePanel('layers-collapsed'))
  requiredElement<HTMLButtonElement>('collapse-inspector').addEventListener('click', () => togglePanel('inspector-collapsed'))
  requiredElement<HTMLButtonElement>('minimize-ui').addEventListener('click', () => toggleMinimized())
}

function togglePanel(name: 'layers-collapsed' | 'inspector-collapsed'): void {
  editorMain.classList.toggle(name)
  syncPanelToggles()
  persistPanelState()
  preview.resize()
  if (fitted) fit()
}

/** Each toggle says what pressing it will do; its icon flips in CSS off the same class. */
function syncPanelToggles(): void {
  const layersCollapsed = editorMain.classList.contains('layers-collapsed')
  const inspectorCollapsed = editorMain.classList.contains('inspector-collapsed')
  requiredElement<HTMLButtonElement>('collapse-layers').setAttribute('aria-label', layersCollapsed ? 'Expand layers' : 'Collapse layers')
  requiredElement<HTMLButtonElement>('collapse-inspector').setAttribute('aria-label', inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector')
}

function toggleMinimized(): void {
  document.body.classList.toggle('ui-minimized')
  persistPanelState()
  preview.resize()
  if (fitted) fit()
}

function persistPanelState(): void {
  void putSetting('editorPanels', {
    layers: editorMain.classList.contains('layers-collapsed'),
    inspector: editorMain.classList.contains('inspector-collapsed'),
    minimized: document.body.classList.contains('ui-minimized'),
  }).catch(() => undefined)
}

async function restorePanelState(): Promise<void> {
  const stored = await getSetting<{ layers?: boolean; inspector?: boolean; minimized?: boolean }>('editorPanels').catch(() => undefined)
  editorMain.classList.toggle('layers-collapsed', stored?.layers === true)
  editorMain.classList.toggle('inspector-collapsed', stored?.inspector === true)
  document.body.classList.toggle('ui-minimized', stored?.minimized === true)
  syncPanelToggles()
  // The stage was sized in the constructor, against the default grid. A restored collapse changes the
  // canvas column, and without this the first fit measured the old one, so the canvas drew only in
  // part until the window was resized.
  preview.resize()
  // Recent emoji are the editor's other setting, so they are restored alongside the panels.
  recentEmoji = readRecentEmoji(await getSetting<unknown>('editorEmojiRecent').catch(() => undefined))
}

async function editedImage(): Promise<TiledImage> {
  if (!doc || !image) throw new Error('The screenshot is not ready yet.')
  if (exportCache?.version === editVersion) return exportCache.image
  const rendered = await renderEditedImage(doc, image, chromeBand(doc), renderDetails())
  exportCache = { version: editVersion, image: rendered }
  return rendered
}

async function encode(format: ExportFormat, scale: number): Promise<Blob> {
  const rendered = await editedImage()
  if (format === 'pdf') return createPdfBlob({ image: rendered }, undefined, exportMenu.pdfOptions(false))
  return encodeImage(format, rendered, undefined, exportMenu.quality(), scale)
}

async function download(): Promise<void> {
  const format = exportMenu.current()
  await busy(downloadButton, exportBusyLabel(format), async () => {
    const blob = await encode(format, exportMenu.scale())
    saveWithAnchor(blob, `pageshotter-edited.${exportFileExtension(format)}`)
  })
}

async function copy(): Promise<void> {
  await busy(copyButton, 'Preparing...', async () => {
    const blob = await encode('png', 1)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
}

/** Prints what an export would produce, at full scale, rather than the canvas at screen resolution. */
async function print(): Promise<void> {
  await busy(printButton, 'Preparing...', async () => {
    printImage(await encode('png', 1))
  })
}

/**
 * Delete this capture and close the tab.
 *
 * Deliberately deletes the screenshot rather than the edits: this is the same capture the result
 * page holds and the same button, so it has to mean the same thing on both. Discarding only the
 * annotations would be a different action, and one nobody asked for.
 *
 * Unsaved edits go with it, which is why the dialog says so. The editor saves only on Done, so a
 * user who has been annotating for ten minutes is owed that sentence before the button works.
 */
async function deleteCaptureAndClose(): Promise<void> {
  if (entryId === '') return
  const confirmed = await confirmDelete({
    heading: 'Delete this screenshot?',
    detail:
      'The screenshot and every edit in this session are stored on this computer only, so deleting ' +
      'cannot be undone and nothing is kept anywhere else.',
  })
  if (!confirmed) return
  await deleteHistoryEntries([entryId]).catch(() => undefined)
  await chrome.runtime.sendMessage({ type: 'CLOSE_RESULT_TAB' }).catch(() => undefined)
}

async function done(): Promise<void> {
  if (!doc) return
  await busy(doneButton, 'Saving...', async () => {
    await putEditorDoc(entryId, doc as SceneDoc)
    location.href = `result.html?job=${encodeURIComponent(entryId)}`
  })
}

async function busy(button: HTMLButtonElement, label: string, action: () => Promise<void>): Promise<void> {
  const text = requiredChild<HTMLElement>(button, '.button-label')
  const before = text.textContent
  button.disabled = true
  text.textContent = label
  try {
    await action()
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The editor action could not finish.')
  } finally {
    button.disabled = false
    text.textContent = before
  }
}

function syncExportButton(format: ExportFormat): void {
  const label = requiredChild<HTMLElement>(downloadButton, '.button-label')
  label.textContent = exportActionLabel(format)
}

function showError(message: string): void {
  errorMessage.textContent = message
  errorMessage.hidden = false
}

function requiredElement<T extends Element>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as unknown as T
}

function requiredChild<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element as T
}
