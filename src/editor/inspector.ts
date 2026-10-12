/**
 * The inspector: what the right-hand panel shows for whatever is selected.
 *
 * Three things that document decides and this file only implements:
 *
 * - **It always shows something.** A blank panel on an empty selection reads as broken, and there
 *   are genuinely canvas-level properties — background, margin, output size — that want a home.
 * - **Background and margin are canvas properties, not Present properties.** The scene model
 *   applies the margin to `outputRect` unconditionally, whether or not Present is on, so a margin
 *   control that disappears with the frame is a control that lies about what the margin does.
 * - **Mixed is one shared component, not a case per row.** With several shapes selected, a field
 *   whose values differ says `Mixed`; typing into it applies that value to every selected shape.
 *
 * Numeric fields are scene units (capture device pixels) and accept a drag on the label to
 * scrub, because setting a shape's width by typing is rare and nudging it is not.
 */
import {
  PRESENT_ANCHOR_COLORS,
  PRESENT_BACKGROUNDS,
  PRESENT_CHROME_THEMES,
  PRESENT_CORNERS,
  PRESENT_FRAME_STYLES,
  PRESENT_GRADIENTS,
  PRESENT_PADDINGS,
  PRESENT_STAMP_MODES,
  type PresentOptions,
} from '../result/presentation-options'
import {
  ARROW_SIZE_MAX,
  ARROW_SIZE_MIN,
  ARROW_STYLES,
  MAGNIFIER_SHAPES,
  CROP_PRESETS,
  DEFAULT_STROKE,
  TEXT_FONTS,
  BUNDLED_FONTS,
  MIN_SHAPE_SIZE,
  cropForRatio,
  cropRatioFor,
  findNode,
  isGroupNode,
  layerRows,
  type CropPreset,
  type KnownNode,
  type Rect,
  type SceneDoc,
  type ShapeType,
} from './scene'
import {
  editSession,
  readInspectorField,
  writeInspectorField,
  type InspectorAlignFieldKey,
  type InspectorColorFieldKey,
  type InspectorFieldKey,
  type InspectorNumberFieldKey,
} from './inspector-fields'
import { DEFAULTABLE_KEYS } from './editor-defaults'

export interface CropInspectorState {
  rect: Rect
  preset: CropPreset
  canClear: boolean
}

export interface InspectorHost {
  doc(): SceneDoc | undefined
  selection(): readonly string[]
  /** Snapshot for undo, once per gesture: a scrub from 40 to 90 is one step, not fifty. */
  beginEdit(): void
  /** Drops the snapshot the last `beginEdit` took, when Esc puts a field back as it was. */
  cancelEdit(): void
  changed(): void
  /** The output's size, already formatted by the editor — the panel does not derive geometry. */
  outputLabel(): string
  frameSelected(): boolean
  crop(): CropInspectorState | undefined
  cropChanged(rect: Rect, preset?: CropPreset): void
  clearCrop(): void
  /** The head's two buttons do exactly what `H` and `Delete` do, through the same functions. */
  toggleVisibility(): void
  deleteSelection(): void
  /**
   * Saves the selected object's style keys as its type's default, or puts that type's default back
   * to factory. False when the selection has no defaults to write. The host owns the toast.
   */
  toolDefault(action: 'save' | 'reset'): Promise<boolean>
}

/**
 * The panel's head, which lives in `editor.html` because its glyphs are inlined at build time from
 * `data-icon` and a runtime-built `<svg>` would have nowhere to come from. It is a name and two
 * object actions — the tile and the sub line were jargon, so they went.
 */
export interface InspectorHeadElements {
  title: HTMLElement
  hide: HTMLButtonElement
  remove: HTMLButtonElement
  /** The Appearance menu, cloned per render: its glyphs are inlined at build time. */
  sectionMenu: HTMLTemplateElement
}

interface FieldAccess<Value> {
  key: InspectorFieldKey
  label: string
  read(node: KnownNode): Value | undefined
  write(node: KnownNode, value: Value): boolean
}

interface NumberField extends FieldAccess<number> {
  kind: 'number' | 'opacity' | 'weight'
  min?: number
  max?: number
  step?: number
  /**
   * Where the slider's track ends, in **CSS pixels**, multiplied by the capture's density before it
   * is used. `max` is a guard rail — 200 for a stroke width — and a track stretched over it would
   * spend its whole length in the first tenth. This is the range a person actually works in; the
   * label still scrubs past it, and a value already past it extends the track rather than clipping.
   */
  soft?: number
}

interface ColorField extends FieldAccess<string> {
  kind: 'color' | 'fill'
}

interface AlignField extends FieldAccess<'left' | 'center' | 'right'> {
  kind: 'align'
}

interface CheckField extends FieldAccess<boolean> {
  kind: 'check'
}

interface SelectField extends FieldAccess<string> {
  kind: 'select'
}

type Field = NumberField | ColorField | AlignField | CheckField | SelectField

/** What a control does with a field's value over the selection. */
interface FieldEdit<Value> {
  value: Value | undefined
  mixed: boolean
  /** One click, one undo step: a segment or a None toggle. */
  apply(next: Value): void
  /** A value while a field has focus or a scrub is held; only the session's first write snapshots. */
  live(next: Value): void
  finish(): void
  /** Esc: the values on focus come back and the session's snapshot is dropped. */
  cancel(): void
}

function numberField(
  key: InspectorNumberFieldKey,
  label: string,
  kind: NumberField['kind'] = 'number',
  limits: Pick<NumberField, 'min' | 'max' | 'step' | 'soft'> = {},
): NumberField {
  return {
    key,
    label,
    kind,
    ...limits,
    read: (node) => readInspectorField(node, key),
    write: (node, value) => writeInspectorField(node, key, value),
  }
}

function colorField(key: InspectorColorFieldKey, label: string, kind: ColorField['kind'] = 'color'): ColorField {
  return {
    key,
    label,
    kind,
    read: (node) => readInspectorField(node, key),
    write: (node, value) => writeInspectorField(node, key, value),
  }
}

function alignField(key: InspectorAlignFieldKey, label: string): AlignField {
  return {
    key,
    label,
    kind: 'align',
    read: (node) => readInspectorField(node, key),
    write: (node, value) => writeInspectorField(node, key, value),
  }
}

/** The way back from a fixed text box: the one control, one undo step. */
const AUTO_HEIGHT: CheckField = {
  key: 'autoHeight',
  label: 'Auto height',
  kind: 'check',
  read: (node) => readInspectorField(node, 'autoHeight'),
  write: (node, value) => writeInspectorField(node, 'autoHeight', value),
}

const ITALIC: CheckField = {
  key: 'italic',
  label: 'Italic',
  kind: 'check',
  read: (node) => readInspectorField(node, 'italic'),
  write: (node, value) => writeInspectorField(node, 'italic', value),
}

/** The pen's marker mode: the stroke tints what is under it (`multiply`) instead of painting over it. */
const MARKER: CheckField = {
  key: 'marker',
  label: 'Marker',
  kind: 'check',
  read: (node) => readInspectorField(node, 'marker'),
  write: (node, value) => writeInspectorField(node, 'marker', value),
}

/** Filled text: a box behind the letters, with a pointer. */
const FILLED: CheckField = {
  key: 'filled',
  label: 'Filled',
  kind: 'check',
  read: (node) => readInspectorField(node, 'filled'),
  write: (node, value) => writeInspectorField(node, 'filled', value),
}

/** System fonts only, listed when this machine has them. */
const FONT: SelectField = {
  key: 'fontFamily',
  label: 'Font',
  kind: 'select',
  read: (node) => readInspectorField(node, 'fontFamily'),
  write: (node, value) => writeInspectorField(node, 'fontFamily', value),
}

/** The kinds of arrow: solid and tapered, a line, or a line with two heads. */
const ARROW_STYLE: SelectField = {
  key: 'arrowStyle',
  label: 'Style',
  kind: 'select',
  read: (node) => readInspectorField(node, 'arrowStyle'),
  write: (node, value) => writeInspectorField(node, 'arrowStyle', value),
}

/**
 * A solid arrow's weight and head follow its length, so Size is its one control; a Line or Both
 * arrow has its own Weight and Head and no Size.
 */
function arrowHides(node: KnownNode, key: string): boolean {
  // A rectangle has no roundness; only a squircle's frames bend.
  if (node.type === 'magnifier') return key === 'roundness' && node.shape === 'rectangle'
  if (node.type !== 'arrow') return false
  return node.style === 'solid' ? key === 'strokeWidth' || key === 'headSize' : key === 'arrowSize'
}

const ARROW_STYLE_LABELS: Record<string, string> = { solid: 'Solid', line: 'Line', double: 'Both' }

/** The magnifier's two frames: a rectangle and an oval. */
const MAGNIFIER_SHAPE: SelectField = {
  key: 'magnifierShape',
  label: 'Shape',
  kind: 'select',
  read: (node) => readInspectorField(node, 'magnifierShape'),
  write: (node, value) => writeInspectorField(node, 'magnifierShape', value),
}

const MAGNIFIER_SHAPE_LABELS: Record<string, string> = { rectangle: 'Rect', squircle: 'Squircle' }

let installedFonts: string[] | undefined

/**
 * The font dropdown: the bundled fonts first, since they are on every machine and the default is one
 * of them. A fresh array each call, because the caller appends a font picked elsewhere to it.
 */
function availableTextFonts(): string[] {
  return [...BUNDLED_FONTS, ...installedTextFonts()]
}

/**
 * The `TEXT_FONTS` this machine can draw. A canvas measures a sample in each family against two
 * generic fallbacks: a family that is not installed falls back, and measures the same as both.
 */
function installedTextFonts(): string[] {
  if (installedFonts) return installedFonts
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return []
  const sample = 'mmmmmmmmmmlli WQ@#'
  const width = (family: string): number => {
    context.font = `72px ${family}`
    return context.measureText(sample).width
  }
  const bases = ['monospace', 'serif'].map((base) => [base, width(base)] as const)
  installedFonts = TEXT_FONTS.filter((name) => bases.some(([base, baseWidth]) => width(`"${name}", ${base}`) !== baseWidth))
  return installedFonts
}

const OPACITY = numberField('opacity', 'Opacity', 'opacity')
const STROKE = colorField('stroke', 'Stroke')
/** Rectangle and ellipse can drop their stroke, as they can their fill. */
const STROKE_OR_NONE = colorField('stroke', 'Stroke', 'fill')
const STROKE_WIDTH = numberField('strokeWidth', 'Weight', 'number', { min: 0, max: 200, soft: 12 })

/** The per-type Appearance table. A type absent from here shows no appearance section. */
const APPEARANCE: Record<ShapeType | 'group', Field[]> = {
  rectangle: [STROKE_OR_NONE, STROKE_WIDTH, colorField('fill', 'Fill', 'fill'), numberField('radius', 'Corners', 'number', { min: 0, max: 400, soft: 24 }), OPACITY],
  ellipse: [STROKE_OR_NONE, STROKE_WIDTH, colorField('fill', 'Fill', 'fill'), OPACITY],
  arrow: [
    ARROW_STYLE,
    STROKE,
    numberField('arrowSize', 'Size', 'number', { min: ARROW_SIZE_MIN, max: ARROW_SIZE_MAX }),
    STROKE_WIDTH,
    numberField('headSize', 'Head', 'number', { min: 0, max: 400, soft: 20 }),
    OPACITY,
  ],
  line: [STROKE, STROKE_WIDTH, OPACITY],
  text: [
    FILLED,
    colorField('fill', 'Box'),
    FONT,
    colorField('color', 'Colour'),
    numberField('fontSize', 'Size', 'number', { min: 1, max: 800, soft: 200 }),
    numberField('fontWeight', 'Weight', 'weight'),
    ITALIC,
    alignField('align', 'Align'),
    colorField('stroke', 'Outline', 'fill'),
    numberField('strokeWidth', 'Outline W', 'number', { min: 0, max: 200, soft: 12 }),
    AUTO_HEIGHT,
    OPACITY,
  ],
  blur: [numberField('radius', 'Radius', 'number', { min: 1, max: 200, soft: 16 }), OPACITY],
  highlight: [colorField('color', 'Colour'), OPACITY],
  emoji: [numberField('fontSize', 'Size', 'number', { min: 1, max: 800, soft: 128 }), OPACITY],
  freehand: [STROKE, STROKE_WIDTH, MARKER, OPACITY],
  // No size row: a counter's digits are derived from its diameter, which W and H already show.
  magnifier: [
    MAGNIFIER_SHAPE,
    numberField('roundness', 'Roundness', 'number', { min: 0, max: 100 }),
    colorField('stroke', 'Border'), numberField('strokeWidth', 'Width', 'number', { min: 0, max: 200, soft: 12 }), OPACITY],
  counter: [colorField('fill', 'Badge', 'fill'), colorField('color', 'Digits'), numberField('count', 'Number', 'number', { min: 0 }), OPACITY],
  image: [OPACITY],
  group: [OPACITY],
}

/**
 * Position rows.
 *
 * These are the node's own stored values, which are kept in its parent's frame — identical to scene
 * space for a top-level node, which is every node until the user makes a group.
 *
 * ponytail: local units, shown as scene units. A node inside a *scaled or rotated* group reports its
 * own frame rather than the resolved scene value. Resolving would need the parent's inverse matrix
 * on write-back; add it if group transforms ever become something users edit rather than something
 * `Cmd G` produces at identity.
 */
const ROTATION = numberField('transform.rotation', 'R', 'number', { min: -360, max: 360 })

/**
 * `R` for a straight arrow or line, which has no rotation of its own: its angle lives in its two
 * points, so a diagonal one drawn just now reports `transform.rotation` 0 while plainly sloping.
 * Typing or scrubbing this swings both ends about their midpoint.
 */
const SEGMENT_ANGLE = numberField('segmentAngle', 'R', 'number', { min: -180, max: 180 })

const POSITION: NumberField[] = [
  numberField('transform.x', 'X'),
  numberField('transform.y', 'Y'),
  numberField('width', 'W', 'number', { min: 1 }),
  numberField('height', 'H', 'number', { min: 1 }),
  ROTATION,
]

/** The six annotation anchors get names, because "Red" reads and "#E11900" is a lookup. */
const COLOR_NAMES: Record<string, string> = {
  '#E11900': 'Red',
  '#1A1A1A': 'Ink',
  '#FFFFFF': 'White',
  '#1D6BE5': 'Blue',
  '#12A150': 'Green',
  '#F5A524': 'Amber',
}

const SEGMENT_LABELS: Record<string, string> = {
  '0': 'Sharp',
  '8': 'Soft',
  '22': 'Round',
  '400': 'Reg',
  '500': 'Med',
  '700': 'Bold',
  mac: 'macOS',
  windows: 'Windows',
  light: 'Light',
  dark: 'Dark',
  off: 'None',
  date: 'Date',
  datetime: 'Date+time',
  iso: 'ISO',
  left: 'L',
  center: 'C',
  right: 'R',
}

const MARGIN_LABELS: Record<string, string> = { '0': 'None', '32': 'S', '64': 'M', '104': 'L' }

/** A bounded number is a slider; an unbounded one has nowhere to put its far end, so it is typed. */
function isSlider(field: NumberField): boolean {
  return field.kind === 'opacity' || (field.min !== undefined && field.max !== undefined)
}

function unitOf(field: NumberField): string {
  if (field.kind === 'opacity' || field.key === 'arrowSize' || field.key === 'roundness') return '%'
  return field.key === 'transform.rotation' || field.key === 'segmentAngle' ? '°' : 'px'
}

/**
 * Which surface the panel is drawing for. `defaults` is the editor-defaults sheet, which shows the
 * same controls over a sample shape instead of a selection -- so it leaves out the four rows that
 * only mean something for a real document: where the shape sits, the output size, the frame's
 * address, and the menu that saves a selection's style as the default.
 */
export type InspectorMode = 'document' | 'defaults'

export class Inspector {
  private scrubbing = false
  /** Radios need a name per group, and two rows of swatches on screen must not share one. */
  private groupCount = 0

  constructor(
    private readonly root: HTMLElement,
    private readonly head: InspectorHeadElements,
    private readonly host: InspectorHost,
    private readonly mode: InspectorMode = 'document',
  ) {
    // The panel does not rebuild while one of its fields has focus (see `render`), so it catches up
    // once focus has left it. After the event, because `activeElement` is still settling during it.
    root.addEventListener('pointerdown', () => {
      this.pressed = true
    })
    // After the click, which follows pointerup in the same task: a timeout, not a microtask. And only
    // if a rebuild was actually held off: rebuilding unasked replaced the Font <select> whose menu the
    // press had just opened, and the menu closed at once.
    window.addEventListener('pointerup', () => {
      if (!this.pressed) return
      window.setTimeout(() => {
        this.pressed = false
        if (!this.held) return
        this.held = false
        this.render()
      })
    })
    root.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return
      queueMicrotask(() => this.render())
    })
    head.hide.addEventListener('click', () => this.host.toggleVisibility())
    head.remove.addEventListener('click', () => this.host.deleteSelection())
    // One listener for the section menu, not one per render: the panel rebuilds on every document
    // change, and a listener added in `defaultsMenu` would have accumulated one per rebuild.
    root.ownerDocument.addEventListener('click', (event) => {
      for (const flyout of root.querySelectorAll<HTMLElement>('.section-flyout:not([hidden])')) {
        if (flyout.parentElement?.contains(event.target as Node)) continue
        flyout.hidden = true
        flyout.parentElement?.querySelector('.section-menu-button')?.setAttribute('aria-expanded', 'false')
      }
    })
  }

  private pressed = false
  /** A rebuild was skipped during the press, and is owed once it ends. */
  private held = false

  render(): void {
    // A scrub holds the pointer on a label this would replace; rebuilding mid-gesture would drop it.
    if (this.scrubbing) return
    // Nor while a field has focus: a rebuild destroyed the input being edited, so the next ↑ went to
    // the canvas and nudged the shape.
    if (this.editingField()) return
    const doc = this.host.doc()
    if (!doc) return
    this.groupCount = 0
    const crop = this.host.crop()
    if (crop) {
      this.renderHead(doc, 'crop')
      this.root.replaceChildren(this.cropSection(doc, crop))
      return
    }
    if (this.host.frameSelected()) {
      this.renderHead(doc, 'frame')
      this.root.replaceChildren(this.frameSection(doc))
      return
    }
    const nodes = this.selectedNodes(doc)
    this.renderHead(doc, nodes)
    this.root.replaceChildren(...(nodes.length === 0 ? this.canvasSections(doc) : this.selectionSections(nodes)))
  }

  /**
   * The head names what is selected. Its two buttons are the only object actions in the panel: show
   * and hide, and delete — both routed to the same functions `H` and `Delete` call.
   */
  private renderHead(doc: SceneDoc, nodes: KnownNode[] | 'crop' | 'frame'): void {
    const { title, hide, remove } = this.head
    const selected = Array.isArray(nodes) ? nodes : []
    const one = selected.length === 1 ? selected[0] : undefined
    title.textContent =
      nodes === 'crop'
        ? 'Crop'
        : nodes === 'frame'
          ? 'Frame'
          : selected.length === 0
            ? 'Capture'
            : one
              ? isGroupNode(one) ? 'Group' : nameOf(doc, one)
              : `${selected.length} selected`

    hide.hidden = selected.length === 0
    remove.hidden = selected.length === 0
    if (selected.length > 0) {
      // "Hidden" over a mixed selection means every one of them: the same rule the shortcut uses.
      const hidden = selected.every((node) => node.hidden === true)
      hide.classList.toggle('is-set', hidden)
      hide.setAttribute('aria-label', hidden ? 'Show selection' : 'Hide selection')
    }
  }

  private cropSection(doc: SceneDoc, state: CropInspectorState): HTMLElement {
    const section = this.section()
    const fields: Array<{ key: keyof Rect; label: string }> = [
      { key: 'x', label: 'X' },
      { key: 'y', label: 'Y' },
      { key: 'width', label: 'W' },
      { key: 'height', label: 'H' },
    ]
    const grid = document.createElement('div')
    grid.className = 'nums'
    for (const field of fields) {
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '1'
      input.value = String(state.rect[field.key])
      input.setAttribute('aria-label', `Crop ${field.label}`)
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value)) return
        this.host.cropChanged({
          ...state.rect,
          [field.key]: field.key === 'width' || field.key === 'height' ? Math.max(MIN_SHAPE_SIZE, value) : value,
        })
      })
      grid.append(buildWell(field.label, 'px', input))
    }
    section.append(this.row('Size and position', grid))

    const presets = document.createElement('select')
    presets.className = 'inspector-select'
    presets.setAttribute('aria-label', 'Crop preset')
    const labels: Record<CropPreset, string> = {
      free: 'Free',
      original: 'Original',
      '16:9': '16:9',
      '4:3': '4:3',
      '1:1': '1:1',
    }
    for (const preset of CROP_PRESETS) {
      const option = document.createElement('option')
      option.value = preset
      option.textContent = labels[preset]
      option.selected = state.preset === preset
      presets.append(option)
    }
    presets.addEventListener('change', () => {
      const preset = presets.value as CropPreset
      this.host.cropChanged(cropForRatio(state.rect, cropRatioFor(preset, doc)), preset)
    })
    section.append(this.row('Ratio', presets, { value: text('rowval', labels[state.preset]) }))

    if (state.canClear) {
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'inspector-link'
      clear.textContent = 'Clear crop'
      clear.addEventListener('click', () => this.host.clearCrop())
      section.append(clear)
    }
    return section
  }

  private applyPresent(doc: SceneDoc, patch: Partial<PresentOptions>): void {
    this.host.beginEdit()
    doc.present = { ...doc.present, ...patch }
    this.host.changed()
  }

  private applyCanvas(doc: SceneDoc, patch: Partial<SceneDoc['canvas']>): void {
    this.host.beginEdit()
    doc.canvas = { ...doc.canvas, ...patch }
    this.host.changed()
  }

  private selectedNodes(doc: SceneDoc): KnownNode[] {
    return this.host
      .selection()
      .map((id) => findNode(doc.nodes, id))
      .filter((node): node is KnownNode => node !== undefined)
  }

  // --- nothing selected: the canvas ------------------------------------------

  /**
   * Nothing selected: the canvas, and only the canvas.
   *
   * Background and margin are canvas properties; browser chrome, corners, shadow and the date stamp
   * are Present's, and they live in `frameSection` behind the Capture row. An earlier build merged
   * the two and was reversed: the panel a person reaches by clicking
   * nothing should be the few things that are always true of the picture, not every setting the
   * frame has.
   */
  private canvasSections(doc: SceneDoc): HTMLElement[] {
    const section = this.section()
    const swatches = document.createElement('div')
    swatches.className = 'swatches'
    swatches.setAttribute('role', 'radiogroup')
    swatches.setAttribute('aria-label', 'Background')
    const name = `bg-${(this.groupCount += 1)}`
    for (const option of PRESENT_BACKGROUNDS) {
      if (option === 'custom') continue
      const stops = option === 'none' ? undefined : PRESENT_GRADIENTS[option]
      const swatch = this.swatch(name, backgroundName(option, doc.canvas.customColor), doc.canvas.background === option, () =>
        this.applyCanvas(doc, { background: option }),
      )
      if (option === 'none') swatch.classList.add('sw-none')
      if (stops) requiredFill(swatch).style.background = `linear-gradient(135deg,${stops.map((stop) => stop.color).join(',')})`
      swatches.append(swatch)
    }
    const custom = document.createElement('input')
    custom.type = 'color'
    custom.className = 'swatch-input'
    custom.classList.toggle('is-on', doc.canvas.background === 'custom')
    custom.value = doc.canvas.customColor
    custom.setAttribute('aria-label', 'Custom background colour')
    custom.addEventListener('input', () => this.applyCanvas(doc, { customColor: custom.value, background: 'custom' }))
    swatches.append(custom)

    section.append(
      this.row('Background', swatches, {
        value: text('rowval', backgroundName(doc.canvas.background, doc.canvas.customColor)),
      }),
      this.segRow('Margin', PRESENT_PADDINGS.map(String), String(doc.canvas.margin), (value) => this.applyCanvas(doc, { margin: Number(value) }), MARGIN_LABELS),
    )
    // One owner for the output size: `outputLabel()` is what the status bar and export menu read.
    if (this.mode === 'document') section.append(fact('Output', this.host.outputLabel()))
    return [section]
  }

  /** The Capture row's panel: everything Present draws around the capture, and nothing else. */
  private frameSection(doc: SceneDoc): HTMLElement {
    const section = this.section()
    section.append(
      this.switchLine('Browser frame', 'Draws a window bar above the capture.', doc.present.on, false, (on) => this.applyPresent(doc, { on })),
    )
    if (doc.present.on && this.mode === 'document') {
      const address = document.createElement('input')
      address.type = 'text'
      address.className = 'inspector-text'
      address.value = doc.present.url
      address.placeholder = 'Captured page URL'
      address.spellcheck = false
      address.setAttribute('aria-label', 'Frame address')
      address.addEventListener('change', () => this.applyPresent(doc, { url: address.value }))
      section.append(
        this.segRow('Style', PRESENT_FRAME_STYLES, doc.present.frame, (frame) => this.applyPresent(doc, { frame })),
        this.segRow('Bar', PRESENT_CHROME_THEMES, doc.present.chrome, (chrome) => this.applyPresent(doc, { chrome })),
        this.row('Address', address),
      )
    } else if (doc.present.on) {
      section.append(
        this.segRow('Style', PRESENT_FRAME_STYLES, doc.present.frame, (frame) => this.applyPresent(doc, { frame })),
        this.segRow('Bar', PRESENT_CHROME_THEMES, doc.present.chrome, (chrome) => this.applyPresent(doc, { chrome })),
      )
    }
    section.append(
      this.segRow('Corners', PRESENT_CORNERS.map(String), String(doc.present.corners), (value) => this.applyPresent(doc, { corners: Number(value) })),
      this.switchLine('Drop shadow', 'Lifts the capture off the background.', doc.present.shadow, false, (on) => this.applyPresent(doc, { shadow: on })),
      this.segRow('Date stamp', PRESENT_STAMP_MODES, doc.present.stamp, (stamp) => this.applyPresent(doc, { stamp })),
    )
    // The stamp sits in the margin, so with no margin there is nowhere for it to go. Saying so is
    // cheaper than the alternative: a control that appears to do nothing.
    if (doc.present.stamp !== 'off' && doc.canvas.margin === 0) {
      section.append(note('The stamp sits in the margin, so it stays hidden while Margin is None.'))
    }
    if (doc.present.on) {
      const plain = document.createElement('button')
      plain.type = 'button'
      plain.className = 'inspector-wide'
      plain.textContent = 'Back to plain'
      plain.addEventListener('click', () => this.applyPresent(doc, { on: false }))
      section.append(plain)
    }
    return section
  }

  // --- something selected -----------------------------------------------------

  private selectionSections(nodes: KnownNode[]): HTMLElement[] {
    const sections: HTMLElement[] = []
    const first = nodes[0]
    if (!first) return sections

    // Only rows every selected node actually has: a rectangle and a blur share opacity and nothing
    // else, and offering a corner radius that silently applies to one of them would be a lie.
    // And only rows every node can answer now: plain text has no Box.
    // The defaults page offers only what it saves: a Style or Size row there would do nothing.
    const shared = APPEARANCE[first.type].filter(
      (field) =>
        (this.mode !== 'defaults' || first.type === 'group' || DEFAULTABLE_KEYS[first.type].includes(field.key)) &&
        nodes.every(
          (node) =>
            APPEARANCE[node.type]?.some((candidate) => candidate.key === field.key) && field.read(node) !== undefined && !arrowHides(node, field.key),
        ),
    )
    if (shared.length > 0) {
      const single =
        this.mode === 'document' && nodes.length === 1 && !isGroupNode(first) && DEFAULTABLE_KEYS[first.type] !== undefined
      const appearance = this.section('Appearance', single ? this.defaultsMenu(first.type) : undefined)
      for (const field of shared) appearance.append(this.field(field, nodes))
      sections.push(appearance)
    }

    if (this.mode === 'defaults') return sections

    // Every selected node made of points reads its angle from them, so `R` becomes that instead.
    const segments = nodes.every((node) => node.type === 'arrow' || node.type === 'line')
    const placed = POSITION.filter((field) => nodes.every((node) => field.read(node) !== undefined)).map((field) =>
      segments && field === ROTATION ? SEGMENT_ANGLE : field,
    )
    if (placed.length > 0) {
      const position = this.section('Position and size')
      const grid = document.createElement('div')
      grid.className = 'nums'
      for (const field of placed) grid.append(this.numberWell(field, nodes))
      position.append(grid)
      sections.push(position)
    }

    return sections
  }

  /**
   * The Appearance eyebrow's own menu, opposite the word: *Set current style as default* and *Reset
   * <type> default*.
   *
   * It was a full-width footer button reading "Use as rectangle default", which moved
   * here: a settings affordance belongs beside the heading it settings, and the footer had room for
   * one action where this has room for two. The host reports what happened; the toast is its job.
   */
  private defaultsMenu(type: ShapeType): HTMLElement {
    const fragment = this.head.sectionMenu.content.cloneNode(true) as DocumentFragment
    const wrap = fragment.firstElementChild
    if (!(wrap instanceof HTMLElement)) throw new Error('Section menu template is empty')
    const button = requiredChild<HTMLButtonElement>(wrap, '.section-menu-button')
    const flyout = requiredChild<HTMLElement>(wrap, '.section-flyout')
    requiredChild<HTMLElement>(wrap, '.section-menu-reset-label').textContent = `Reset ${type} default`
    button.setAttribute('aria-label', `${capitalise(type)} style defaults`)

    const open = (next: boolean): void => {
      flyout.hidden = !next
      button.setAttribute('aria-expanded', String(next))
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      open(flyout.hidden !== false)
    })
    const act = (action: 'save' | 'reset'): void => {
      open(false)
      void this.host.toolDefault(action).then((done) => {
        // A reset changes what the *next* shape starts from, so the panel it was opened from is
        // unchanged -- but re-rendering keeps the menu from holding a stale closure over `type`.
        if (done && action === 'reset') this.render()
      })
    }
    requiredChild<HTMLButtonElement>(wrap, '.section-menu-save').addEventListener('click', () => act('save'))
    requiredChild<HTMLButtonElement>(wrap, '.section-menu-reset').addEventListener('click', () => act('reset'))
    return wrap
  }

  /**
   * A section, with an eyebrow only when it needs one. The head already names the panel, so a lone
   * section repeating that name stuttered: FRAME over FRAME, CAPTURE over CANVAS.
   */
  private section(title?: string, action?: HTMLElement): HTMLElement {
    const section = document.createElement('section')
    section.className = 'inspector-section'
    if (!title) return section
    if (!action) {
      section.append(text('eyebrow', title))
      return section
    }
    const head = document.createElement('div')
    head.className = 'section-head'
    head.append(text('eyebrow', title), action)
    section.append(head)
    return section
  }

  /**
   * The control pattern: label and value on one baseline, the control full width underneath. The
   * value is a live element rather than a string, because a slider rewrites it while it is dragged.
   */
  private row(
    label: string,
    control: HTMLElement,
    options: { value?: HTMLElement; labelElement?: HTMLElement } = {},
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'inspector-row'
    const head = document.createElement('div')
    head.className = 'rowhead'
    const name = options.labelElement ?? document.createElement('span')
    if (!options.labelElement) name.textContent = label
    name.classList.add('rowlbl')
    head.append(name)
    if (options.value) head.append(options.value)
    row.append(head, control)
    return row
  }

  /** Whether focus is in one of the panel's own inputs, which a rebuild would destroy. */
  private editingField(): boolean {
    // A press in the panel: rebuilding now would replace the control under the pointer, and the click
    // would land on nothing. That happened on the Filled switch while a text edit was open -- the
    // press blurred the textarea, the edit ended, the panel rebuilt, and it took a second click.
    if (this.pressed) {
      this.held = true
      return true
    }
    const active = document.activeElement
    // A switch is not being typed into, and its row set can change (Filled shows or hides Box).
    return active instanceof HTMLInputElement && active.type !== 'checkbox' && this.root.contains(active)
  }

  private fieldState<Value>(field: FieldAccess<Value>, nodes: KnownNode[]): FieldEdit<Value> {
    // What Esc puts back: the values when this session began, refreshed each time one finishes.
    let before = nodes.map((node) => field.read(node))
    const session = editSession()
    const write = (next: Value): void => {
      for (const node of nodes) field.write(node, next)
    }
    return {
      value: before[0],
      mixed: before.some((value) => value !== before[0]),
      apply: (next) => {
        this.host.beginEdit()
        write(next)
        this.host.changed()
      },
      live: (next) => {
        if (session.change()) this.host.beginEdit()
        write(next)
        this.host.changed()
      },
      finish: () => {
        session.finish()
        before = nodes.map((node) => field.read(node))
      },
      cancel: () => {
        if (!session.cancel()) return
        nodes.forEach((node, index) => {
          const value = before[index]
          if (value !== undefined) field.write(node, value)
        })
        this.host.cancelEdit()
        this.host.changed()
      },
    }
  }

  /** One field over N nodes: shared value, or `Mixed`, and a write that reaches all of them. */
  private field(field: Field, nodes: KnownNode[]): HTMLElement {
    if (field.key === 'arrowStyle') {
      const { value, mixed, apply } = this.fieldState(field as SelectField, nodes)
      return this.segRow(field.label, ARROW_STYLES, mixed ? undefined : value, apply, ARROW_STYLE_LABELS, mixed)
    }
    if (field.key === 'magnifierShape') {
      const { value, mixed, apply } = this.fieldState(field as SelectField, nodes)
      return this.segRow(field.label, MAGNIFIER_SHAPES, mixed ? undefined : value, apply, MAGNIFIER_SHAPE_LABELS, mixed)
    }
    if (field.kind === 'select') {
      const { value, mixed, apply } = this.fieldState(field, nodes)
      const select = document.createElement('select')
      select.className = 'inspector-select'
      select.setAttribute('aria-label', field.label)
      const names = availableTextFonts()
      // A family picked on another machine still shows as what it is, rather than as System.
      if (value && !names.includes(value)) names.push(value)
      if (mixed) {
        const placeholder = new Option('Mixed', '', true, true)
        placeholder.disabled = true
        select.append(placeholder)
      }
      select.append(new Option('System', '', false, !mixed && !value))
      for (const name of names) select.append(new Option(name, name, false, !mixed && value === name))
      select.addEventListener('change', () => apply(select.value))
      return this.row(field.label, select, { value: valueText(mixed, mixed ? '' : value || 'System') })
    }
    if (field.kind === 'check') {
      const { value, mixed, apply } = this.fieldState(field, nodes)
      return this.switchLine(field.label, undefined, !mixed && value === true, mixed, apply)
    }
    if (field.kind === 'align') {
      const { value, mixed, apply } = this.fieldState(field, nodes)
      return this.segRow(field.label, ['left', 'center', 'right'] as const, mixed ? undefined : value, apply, undefined, mixed)
    }
    if (field.kind === 'weight') {
      const { value, mixed, apply } = this.fieldState(field, nodes)
      return this.segRow(field.label, ['400', '500', '700'], mixed ? undefined : String(value), (next) => apply(Number(next)), undefined, mixed)
    }
    if (field.kind === 'color' || field.kind === 'fill') {
      const state = this.fieldState(field, nodes)
      // Leaving None restores a visible colour: the default stroke for a stroke, white for a fill.
      // A text outline restores to white: the default red would vanish against red text.
      const restore =
        field.kind === 'fill'
          ? field.key === 'stroke' && !nodes.every((node) => node.type === 'text')
            ? DEFAULT_STROKE
            : '#FFFFFF'
          : undefined
      const value = state.value ?? (restore === undefined ? '#000000' : 'none')
      const shown = valueText(state.mixed, colorText(value))
      return this.row(field.label, this.swatches(field.label, value, state, restore, shown), { value: shown })
    }
    if (field.kind !== 'number' && field.kind !== 'opacity') throw new Error(`Unsupported inspector field: ${field.key}`)
    if (!isSlider(field)) return this.row(field.label, wrapWell(this.numberWell(field, nodes)))
    return this.sliderRow(field, this.host.doc()?.capture.density ?? 1, nodes)
  }

  /**
   * A native range at opacity 0 over a drawn track: the drag, the arrow keys and Home/End all come
   * free, and the value in the row head rewrites itself as the thumb moves.
   */
  private sliderRow(field: NumberField, density: number, nodes: KnownNode[]): HTMLElement {
    const state = this.numeric(field, nodes)
    const shown = state.shown ?? state.min
    // The track covers the working range, not the guard rail — and stretches to reach a value that
    // is already past it, so the thumb never sits on a number the slider cannot say.
    const top = field.soft === undefined ? state.max : Math.min(state.max, Math.max(field.soft * density, shown))
    const rng = document.createElement('div')
    rng.className = 'rng'
    const fill = document.createElement('span')
    fill.className = 'rng-fill'
    const thumb = document.createElement('span')
    thumb.className = 'rng-thumb'
    rng.append(text('rng-track', ''), fill, thumb)

    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(state.min)
    input.max = String(top)
    input.step = String(field.step ?? 1)
    input.value = String(shown)
    input.setAttribute('aria-label', field.label)
    rng.append(input)

    const value = valueText(state.mixed, state.mixed ? '' : `${shown}${unitSuffix(field)}`)
    const paint = (): void => {
      const frac = (Number(input.value) - state.min) / (top - state.min || 1)
      // The thumb is 12px wide and travels between its own edges, which is why both the fill and the
      // offset are measured against `100% - 12px` rather than the track's full width.
      thumb.style.left = `calc((100% - 12px) * ${frac})`
      fill.style.width = `calc((100% - 12px) * ${frac} + 6px)`
    }
    paint()
    const show = (next: number): void => {
      value.classList.remove('is-mixed')
      value.textContent = `${next}${unitSuffix(field)}`
    }
    input.addEventListener('input', () => {
      paint()
      show(Number(input.value))
      state.commit(Number(input.value))
    })
    input.addEventListener('change', () => state.finish())
    input.addEventListener('blur', () => state.finish())
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      state.cancel()
      input.blur()
    })

    // The label scrubs over the slider's own range and moves its thumb: a scrub that ran on past the
    // track to the guard rail (200px) left the thumb behind and said a number the slider could not.
    const label = document.createElement('span')
    label.textContent = field.label
    label.classList.add('scrub')
    this.wireScrub(label, input, (next) => {
      paint()
      show(next)
      state.commit(next)
    }, state.finish, { min: state.min, max: top })
    return this.row(field.label, rng, { value, labelElement: label })
  }

  /** The shared numeric rules: display units, clamping, and one undo step per focus session. */
  private numeric(
    field: NumberField,
    nodes: KnownNode[],
  ): {
    shown: number | undefined
    mixed: boolean
    min: number
    max: number
    commit(next: number): void
    finish(): void
    cancel(): void
  } {
    const { value, mixed, live, finish, cancel } = this.fieldState(field, nodes)
    const percent = field.kind === 'opacity'
    const min = percent ? 0 : (field.min ?? -Number.MAX_SAFE_INTEGER)
    const max = percent ? 100 : (field.max ?? Number.MAX_SAFE_INTEGER)
    return {
      shown: value === undefined ? undefined : Math.round(percent ? value * 100 : value),
      mixed,
      min,
      max,
      commit: (next) => {
        const clamped = Math.min(max, Math.max(min, next))
        live(percent ? clamped / 100 : clamped)
      },
      finish,
      cancel,
    }
  }

  /** One typed field, in the `.num` well: mono key on the left, unit on the right. */
  private numberWell(field: NumberField, nodes: KnownNode[]): HTMLElement {
    const state = this.numeric(field, nodes)
    const input = document.createElement('input')
    input.type = 'number'
    input.setAttribute('aria-label', field.label)
    input.step = String(field.step ?? 1)
    input.min = String(state.min)
    input.max = String(state.max)
    input.value = state.mixed ? '' : String(state.shown ?? '')
    input.placeholder = state.mixed ? 'Mixed' : ''
    // Every keystroke, arrow and spinner click applies at once; the focus session makes them one
    // undo step. A half-typed value such as `-` is not a number yet and waits.
    input.addEventListener('input', () => {
      if (input.value.trim() === '') return
      const next = Number(input.value)
      if (Number.isFinite(next)) state.commit(next)
    })
    // A field left empty still commits 0, clamped to its minimum, as it always has.
    input.addEventListener('change', () => {
      if (input.value.trim() === '') state.commit(0)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        state.cancel()
        input.blur()
      }
    })
    input.addEventListener('blur', () => state.finish())

    const well = buildWell(field.label, unitOf(field), input)
    const key = requiredKey(well)
    key.classList.add('scrub')
    this.wireScrub(key, input, state.commit, state.finish, state)
    return well
  }

  /**
   * Drag on the key to scrub. The whole drag is one undo step: each value rides on the session the
   * first one opened, and releasing ends it. The
   * panel is not rebuilt mid-gesture, which is what keeps the key under the pointer alive.
   */
  private wireScrub(
    label: HTMLElement,
    input: HTMLInputElement,
    commit: (next: number) => void,
    finish: () => void,
    limits: { min: number; max: number },
  ): void {
    let start: { x: number; value: number } | undefined
    label.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      start = { x: event.clientX, value: Number(input.value) || 0 }
      this.scrubbing = true
      label.setPointerCapture(event.pointerId)
    })
    label.addEventListener('pointermove', (event) => {
      if (!start) return
      // No button down means the release was missed; hovering back over the label must not scrub.
      if ((event.buttons & 1) === 0) return end(event)
      // Clamped here, not only in `commit`: the document was always clamped, but the label showed the
      // raw number -- 150% opacity -- and the next move counted on from it.
      const next = Math.min(limits.max, Math.max(limits.min, Math.round(start.value + (event.clientX - start.x))))
      if (String(next) === input.value) return
      input.value = String(next)
      input.placeholder = ''
      commit(next)
    })
    const end = (event: PointerEvent): void => {
      if (!start) return
      start = undefined
      this.scrubbing = false
      if (label.hasPointerCapture(event.pointerId)) label.releasePointerCapture(event.pointerId)
      finish()
      this.render()
    }
    label.addEventListener('pointerup', end)
    label.addEventListener('pointercancel', end)
    // Capture can go without a pointerup (the window loses focus mid-drag); the scrub ends with it.
    label.addEventListener('lostpointercapture', end)
  }

  /**
   * A switch: the label and its one-line explanation on the left, a 30×18 track on the right. The
   * checkbox stays native and only loses its paint, so Space toggles it and the ring lands on it.
   */
  private switchLine(
    label: string,
    sub: string | undefined,
    checked: boolean,
    mixed: boolean,
    apply: (next: boolean) => void,
  ): HTMLElement {
    const line = document.createElement('label')
    line.className = 'switch-line'
    const words = document.createElement('span')
    words.className = 'switch-text'
    const strong = document.createElement('strong')
    strong.textContent = label
    words.append(strong)
    if (sub) words.append(text('', sub))
    const control = document.createElement('span')
    control.className = 'switch'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    input.indeterminate = mixed
    input.setAttribute('aria-label', label)
    input.addEventListener('change', () => apply(input.checked))
    control.append(input, text('track', ''))
    line.append(words, control)
    return line
  }

  private segRow<Value extends string>(
    label: string,
    options: readonly Value[],
    value: Value | string | undefined,
    apply: (next: Value) => void,
    labels: Record<string, string> = SEGMENT_LABELS,
    mixed = false,
  ): HTMLElement {
    const group = document.createElement('div')
    group.className = 'seg'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', label)
    let chosen: string | undefined
    for (const option of options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = labels[option] ?? option
      button.setAttribute('aria-label', button.textContent)
      const on = value === option
      if (on) chosen = button.textContent
      button.setAttribute('aria-pressed', String(on))
      button.addEventListener('click', () => apply(option))
      group.append(button)
    }
    // Wide labels ("Date+time") do not fit four equal columns at 232px, so they get their own width.
    if (options.some((option) => (labels[option] ?? option).length > 5)) group.classList.add('seg-fit')
    return this.row(label, group, { value: valueText(mixed, mixed ? '' : (chosen ?? '')) })
  }

  /**
   * Six palette anchors, a `None` when the field can have none, and a custom well. The radios are
   * native and only lose their paint, so the arrow keys walk the palette for free.
   */
  private swatches(
    label: string,
    value: string,
    state: FieldEdit<string>,
    restore: string | undefined,
    shown: HTMLElement,
  ): HTMLElement {
    // The clicked radio keeps focus, and the panel does not rebuild under a focused input, so the
    // row's value would stay on the old colour until focus left. Say it here.
    const say = (next: string): void => {
      shown.classList.remove('is-mixed')
      shown.textContent = colorText(next)
    }
    const row = document.createElement('div')
    row.className = 'swatches'
    row.setAttribute('role', 'radiogroup')
    row.setAttribute('aria-label', label)
    const name = `sw-${(this.groupCount += 1)}`
    if (restore !== undefined) {
      const none = this.swatch(name, 'None', !state.mixed && value === 'none', () => (say('none'), state.apply('none')))
      none.classList.add('sw-none')
      row.append(none)
    }
    for (const color of PRESENT_ANCHOR_COLORS) {
      const swatch = this.swatch(name, colorText(color), !state.mixed && sameColor(value, color), () => (say(color), state.apply(color)))
      requiredFill(swatch).style.background = color
      row.append(swatch)
    }
    const custom = document.createElement('input')
    custom.type = 'color'
    custom.className = 'swatch-input'
    // On when the colour is a real one that no anchor covers — never for `none`.
    const known = value === 'none' || PRESENT_ANCHOR_COLORS.some((color) => sameColor(value, color))
    custom.classList.toggle('is-on', !state.mixed && !known)
    custom.value = hexOf(value === 'none' ? (restore ?? '#000000') : value)
    custom.setAttribute('aria-label', `${label}: custom colour`)
    // Applies while the picker is still open (it used to wait for it to close).
    custom.addEventListener('input', () => (say(custom.value), state.live(custom.value)))
    custom.addEventListener('change', () => state.finish())
    custom.addEventListener('blur', () => state.finish())
    row.append(custom)
    return row
  }

  private swatch(name: string, label: string, checked: boolean, apply: () => void): HTMLElement {
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = name
    input.checked = checked
    input.setAttribute('aria-label', label)
    input.addEventListener('change', () => apply())
    swatch.append(input, text('sw-fill', ''))
    return swatch
  }
}

/**
 * ponytail: third copy of this, after `editor.ts` and `layers-panel.ts`. Five lines each and no
 * shared DOM module in the tree to put it in; extract one the next time a fourth is wanted, rather
 * than dragging two unrelated files into an unrelated commit for no behaviour change.
 */
function requiredChild<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element as T
}

function text(className: string, content: string): HTMLElement {
  const element = document.createElement('span')
  if (className) element.className = className
  element.textContent = content
  return element
}

function valueText(mixed: boolean, content: string): HTMLElement {
  const element = text('rowval', mixed ? 'Mixed' : content)
  element.classList.toggle('is-mixed', mixed)
  return element
}

function note(content: string): HTMLElement {
  const element = document.createElement('p')
  element.className = 'inspector-note'
  element.textContent = content
  return element
}

/** A stated fact, not a control: the Output rows say what the exported file will be. */
function fact(key: string, value: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'fact'
  row.append(text('fact-k', key), text('mono-out', value))
  return row
}

/** The `.num` well: the mono key and the unit sit inside the field's own border. */
function buildWell(key: string, unit: string, input: HTMLInputElement): HTMLElement {
  const well = document.createElement('label')
  well.className = 'num'
  well.append(text('num-k', key), input, text('num-u', unit))
  return well
}

/** A lone well still wants the grid, so it is the same 30px height as a pair of them. */
function wrapWell(well: HTMLElement): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'nums'
  grid.append(well)
  return grid
}

function requiredFill(swatch: HTMLElement): HTMLElement {
  const fill = swatch.querySelector<HTMLElement>('.sw-fill')
  if (!fill) throw new Error('Swatch has no fill')
  return fill
}

function requiredKey(well: HTMLElement): HTMLElement {
  const key = well.querySelector<HTMLElement>('.num-k')
  if (!key) throw new Error('Number well has no key')
  return key
}

function unitSuffix(field: NumberField): string {
  const unit = unitOf(field)
  return unit === 'px' ? ' px' : unit
}

/** Type names are stored lower case; the head is the one place they are read as words. */
function capitalise(value: string): string {
  return value[0] ? value[0].toUpperCase() + value.slice(1) : value
}

/** `indigo` is a stored key, not a label. The row says the name a person would say. */
function backgroundName(background: string, customColor: string): string {
  if (background === 'none') return 'Transparent'
  if (background === 'custom') return customColor.toUpperCase()
  return capitalise(background)
}

function colorText(value: string): string {
  if (value === 'none') return 'None'
  const hex = hexOf(value).toUpperCase()
  return COLOR_NAMES[hex] ?? hex
}

/** `#fff` and `#FFFFFF` are the same swatch; the palette is written long, node values may not be. */
function sameColor(a: string, b: string): boolean {
  return a !== 'none' && hexOf(a).toUpperCase() === hexOf(b).toUpperCase()
}

/**
 * The name the layers panel shows, so the head and the row agree on what a thing is called — and
 * which group it sits in, which is the only place the panel says so.
 */
function nameOf(doc: SceneDoc, node: KnownNode): string {
  const rows = layerRows(doc)
  const row = rows.find((candidate) => candidate.id === node.id)
  if (!row) return node.type
  const parent = row.parentId ? rows.find((candidate) => candidate.id === row.parentId) : undefined
  return parent ? `${row.name} · in ${parent.name}` : row.name
}

/** `<input type="color">` accepts `#rrggbb` and nothing else; a named or short colour would blank it. */
function hexOf(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return '#000000'
}
