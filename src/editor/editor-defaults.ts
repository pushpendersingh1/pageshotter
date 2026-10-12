import { getSetting, putSetting } from '../shared/capture-db'
import {
  DEFAULT_PRESENT_OPTIONS,
  PRESENT_BACKGROUNDS,
  readPresentOptions,
  type PresentOptions,
} from '../result/presentation-options'
import { readInspectorField, writeInspectorField, type InspectorFieldKey } from './inspector-fields'
import { DEFAULT_COUNTER_DIGITS, DEFAULT_COUNTER_FILL, DEFAULT_HIGHLIGHT, DEFAULT_STROKE, DEFAULT_TEXT_FONT, type KnownNode, type ShapeType } from './scene'

/** Inspector values in capture-independent units. Creation scales the size fields by density. */
export type ToolDefault = Partial<Record<InspectorFieldKey, number | string | boolean>>

export interface CanvasDefault {
  background: PresentOptions['background']
  customColor: string
  margin: number
}

/**
 * What a saved tool default is keyed by.
 *
 * Not `ShapeType`, because **Pen and Marker make the same node type and must not share a default**.
 * They did at first, and the result was a Marker that drew in the pen's thin blue -- and a thin blue
 * `multiply` stroke over a white page is pixel-identical to a thin blue normal one, so the two tools
 * were indistinguishable until you happened to draw over dark pixels.
 */
export type DefaultsKey = ShapeType | 'marker'

/** The node type a defaults key builds, for the sample shape and the draft probe. */
export function shapeTypeForDefaults(key: DefaultsKey): ShapeType {
  return key === 'marker' ? 'freehand' : key
}

export interface EditorDefaults {
  tools: Record<DefaultsKey, ToolDefault>
  /** Complete except for `url`, which belongs to each capture rather than to a default. */
  present: Partial<PresentOptions>
  canvas: CanvasDefault
}

export const DEFAULTABLE_KEYS: Record<ShapeType, readonly InspectorFieldKey[]> = {
  rectangle: ['fill', 'stroke', 'strokeWidth', 'radius', 'opacity'],
  ellipse: ['fill', 'stroke', 'strokeWidth', 'opacity'],
  arrow: ['stroke', 'strokeWidth', 'headSize', 'opacity'],
  line: ['stroke', 'strokeWidth', 'opacity'],
  text: [
    // `filled`, then `fill`, then `color`: filling swaps the colours, so the saved box and text
    // colours have to land after it.
    'filled',
    'fill',
    'color',
    'stroke',
    'strokeWidth',
    'fontSize',
    'fontWeight',
    'align',
    'italic',
    'fontFamily',
    'autoHeight',
    'opacity',
  ],
  blur: ['radius', 'opacity'],
  highlight: ['color', 'opacity'],
  emoji: ['fontSize', 'opacity'],
  counter: ['fill', 'color', 'opacity'],
  magnifier: ['magnifierShape', 'roundness', 'stroke', 'strokeWidth', 'opacity'],
  // A picture is whatever was added; there is no appearance a new one should start from.
  image: [],
  // No `marker` here on purpose: which composite a stroke gets is decided by the tool you picked,
  // not by a saved value. Leaving it defaultable put a checkbox on the Pen defaults page that
  // `finishStroke` then overrode -- a dead control, which is worse than no control. The inspector
  // still has it, for changing a stroke you have already drawn.
  freehand: ['stroke', 'strokeWidth', 'opacity'],
}

const DENSITY_SCALED: Record<ShapeType, readonly InspectorFieldKey[]> = {
  rectangle: ['strokeWidth'],
  ellipse: ['strokeWidth'],
  arrow: ['strokeWidth', 'headSize'],
  line: ['strokeWidth'],
  text: ['strokeWidth', 'fontSize'],
  blur: ['radius'],
  highlight: [],
  emoji: ['fontSize'],
  // The diameter is the only size a counter has and it is not an inspector default -- a badge is
  // stamped at `COUNTER_DIAMETER` scaled by density, and resized by hand after.
  counter: [],
  freehand: ['strokeWidth'],
  magnifier: ['strokeWidth'],
  image: [],
}

const FACTORY_PRESENT: Partial<PresentOptions> = { ...DEFAULT_PRESENT_OPTIONS }
delete FACTORY_PRESENT.url

export const DEFAULT_EDITOR_DEFAULTS: EditorDefaults = {
  tools: {
    rectangle: { fill: 'none', stroke: DEFAULT_STROKE, strokeWidth: 3, radius: 0, opacity: 1 },
    ellipse: { fill: 'none', stroke: DEFAULT_STROKE, strokeWidth: 3, opacity: 1 },
    arrow: { stroke: DEFAULT_STROKE, strokeWidth: 3, headSize: 9, opacity: 1 },
    line: { stroke: DEFAULT_STROKE, strokeWidth: 3, opacity: 1 },
    text: {
      // Filled by default, with white letters.
      filled: true,
      // The palette's Blue, so a callout reads apart from the red annotations around it.
      fill: '#1D6BE5',
      color: '#FFFFFF',
      stroke: 'none',
      strokeWidth: 2,
      fontSize: 20,
      fontWeight: 500,
      align: 'left',
      italic: false,
      fontFamily: DEFAULT_TEXT_FONT,
      autoHeight: true,
      opacity: 1,
    },
    blur: { radius: 18, opacity: 1 },
    highlight: { color: DEFAULT_HIGHLIGHT, opacity: 0.35 },
    counter: { fill: DEFAULT_COUNTER_FILL, color: DEFAULT_COUNTER_DIGITS, opacity: 1 },
    magnifier: { magnifierShape: 'squircle', roundness: 85, stroke: DEFAULT_STROKE, strokeWidth: 3, opacity: 1 },
    freehand: { stroke: DEFAULT_STROKE, strokeWidth: 3, opacity: 1 },
    /*
     * A marker is thick, pale and translucent, or it is just a pen. The colour and opacity are the
     * rectangle Highlight's exactly, so the two highlighting tools read as the same instrument in
     * two shapes; only the width is new, because a highlighter stroke has to be wide enough to cover
     * a line of text in one pass.
     */
    marker: { stroke: DEFAULT_HIGHLIGHT, strokeWidth: 16, opacity: 0.35 },
    emoji: { fontSize: 48, opacity: 1 },
    image: {},
  },
  present: FACTORY_PRESENT,
  canvas: {
    background: DEFAULT_PRESENT_OPTIONS.background,
    customColor: DEFAULT_PRESENT_OPTIONS.customColor,
    margin: DEFAULT_PRESENT_OPTIONS.padding,
  },
}

/** Writes complete effective defaults into a freshly built node. */
export function applyToolDefaults(node: KnownNode, saved: ToolDefault | undefined, density: number): void {
  const allowed = DEFAULTABLE_KEYS[node.type as ShapeType]
  if (!saved || !allowed) return
  const scaled = DENSITY_SCALED[node.type as ShapeType]
  // In `DEFAULTABLE_KEYS` order, not the stored bag's: some writes depend on others (text `fill`).
  for (const key of allowed) {
    if (!(key in saved)) continue
    const value = (saved as Record<string, unknown>)[key]
    const applied = scaled.includes(key) ? scale(value, density) : value
    writeInspectorField(node, key, applied as never)
  }
}

/** Reads effective values from a node for tests and future import paths, removing density again. */
export function extractToolDefault(node: KnownNode, density: number): ToolDefault {
  const allowed = DEFAULTABLE_KEYS[node.type as ShapeType]
  if (!allowed) return {}
  const scaled = DENSITY_SCALED[node.type as ShapeType]
  const result: ToolDefault = {}
  for (const key of allowed) {
    const value = readInspectorField(node, key)
    if (value !== undefined) result[key] = scaled.includes(key) ? unscale(value, density) : value
  }
  return result
}

function scale(value: unknown, density: number): number | string | boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(density) && density > 0
    ? value * density
    : (value as number | string | boolean)
}

function unscale(value: number | string | boolean, density: number): number | string | boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(density) && density > 0
    ? value / density
    : value
}

/** Validates stored values independently and fills every missing value from the factory model. */
export function readEditorDefaults(stored: unknown): EditorDefaults {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const rawTools = typeof raw.tools === 'object' && raw.tools !== null
    ? (raw.tools as Record<string, unknown>)
    : {}
  const tools = {} as Record<DefaultsKey, ToolDefault>

  // Over the factory bags rather than over `DEFAULTABLE_KEYS`, because Marker has a bag of its own
  // and no node type of its own; its allowed keys are the ones its node type declares.
  for (const key of Object.keys(DEFAULT_EDITOR_DEFAULTS.tools) as DefaultsKey[]) {
    const rawTool = typeof rawTools[key] === 'object' && rawTools[key] !== null
      ? (rawTools[key] as Record<string, unknown>)
      : {}
    const tool: ToolDefault = { ...DEFAULT_EDITOR_DEFAULTS.tools[key] }
    for (const field of DEFAULTABLE_KEYS[shapeTypeForDefaults(key)]) {
      const value = rawTool[field]
      if (validToolValue(field, value, tool[field])) tool[field] = value
    }
    tools[key] = tool
  }

  const present = readPresentOptions(raw.present)
  delete (present as Partial<PresentOptions>).url
  return {
    tools,
    present,
    canvas: readCanvasDefault(raw.canvas),
  }
}

function validToolValue(
  key: InspectorFieldKey,
  value: unknown,
  factory: number | string | boolean | undefined,
): value is number | string | boolean {
  if (typeof factory === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (key === 'opacity') return value >= 0 && value <= 1
    return value >= 0
  }
  if (typeof factory === 'boolean') return typeof value === 'boolean'
  if (typeof value !== 'string') return false
  if (key === 'align') return value === 'left' || value === 'center' || value === 'right'
  if (key === 'magnifierShape') return value === 'rectangle' || value === 'squircle'
  if (key === 'fill' || key === 'stroke' || key === 'color') {
    return value === 'none' || /^#[0-9a-fA-F]{6}$/.test(value)
  }
  return true
}

function readCanvasDefault(stored: unknown): CanvasDefault {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const margin = raw.margin
  return {
    background: PRESENT_BACKGROUNDS.includes(raw.background as PresentOptions['background'])
      ? (raw.background as PresentOptions['background'])
      : DEFAULT_EDITOR_DEFAULTS.canvas.background,
    customColor: typeof raw.customColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.customColor)
      ? raw.customColor
      : DEFAULT_EDITOR_DEFAULTS.canvas.customColor,
    margin: typeof margin === 'number' && Number.isFinite(margin) && margin >= 0
      ? margin
      : DEFAULT_EDITOR_DEFAULTS.canvas.margin,
  }
}

const EDITOR_DEFAULTS_KEY = 'editorDefaults'

export async function getEditorDefaults(): Promise<EditorDefaults> {
  return (await getEditorDefaultsState()).defaults
}

export async function getEditorDefaultsState(): Promise<{ defaults: EditorDefaults; stored: boolean }> {
  try {
    const stored = await getSetting<unknown>(EDITOR_DEFAULTS_KEY)
    return { defaults: readEditorDefaults(stored), stored: stored !== undefined }
  } catch {
    return { defaults: structuredClone(DEFAULT_EDITOR_DEFAULTS), stored: false }
  }
}

export async function putEditorDefaults(defaults: EditorDefaults): Promise<EditorDefaults> {
  const validated = readEditorDefaults(defaults)
  await putSetting(EDITOR_DEFAULTS_KEY, validated)
  return validated
}

export async function resetEditorDefaults(): Promise<EditorDefaults> {
  return putEditorDefaults(structuredClone(DEFAULT_EDITOR_DEFAULTS))
}
