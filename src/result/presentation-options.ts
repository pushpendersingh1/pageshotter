/**
 * The "Present" choice, as numbers and strings with no DOM in sight.
 *
 * A presented screenshot wraps the capture in a mock browser window on a tinted background. It never
 * touches the capture path and needs no permission -- the composition happens at export time and is
 * baked into the file, exactly like the six annotation colours in section 5 of the design language:
 * user content, hard-coded, never following the theme.
 *
 * The category is a familiar one: a mock browser frame in macOS or Windows styling with the page URL
 * in a fake address bar, backgrounds, padding, rounded corners, a drop shadow, and a date stamp. The
 * panel is Padding / Background / Corners / Drop shadow / Stamp, and those presets are what the
 * options below follow. The gradient *hues* are anchored to the six annotation colours the design
 * language already fixed.
 */

export type PresentFrameStyle = 'mac' | 'windows'

/** The chrome's own theme: the strip artwork exists in both. */
export type PresentChromeTheme = 'light' | 'dark'

export type PresentBackground = 'none' | 'indigo' | 'mint' | 'ocean' | 'paper' | 'slate' | 'sunset' | 'custom'

export type PresentStampMode = 'off' | 'date' | 'datetime' | 'iso'

export interface PresentOptions {
  /**
   * Whether the panel is active. Persisted like every other export choice, so a capture opened
   * later comes back the way the user left it.
   */
  on: boolean
  /**
   * The browser chrome: macOS traffic lights or Windows window controls.
   */
  frame: PresentFrameStyle
  /** Which set of chrome strips: light or dark. */
  chrome: PresentChromeTheme
  /**
   * The fake address bar's text. Empty means "use the captured page's URL" -- for most captures that
   * is the honest address, and the panel starts from it. Only a deliberate override is stored.
   */
  url: string
  background: PresentBackground
  /** The custom background as `#rrggbb`, used only when `background` is `custom`. */
  customColor: string
  /** Margin around the whole window, in output pixels. */
  padding: number
  /** Corner radius of the window card, in output pixels. */
  corners: number
  shadow: boolean
  stamp: PresentStampMode
}

export const DEFAULT_PRESENT_OPTIONS: PresentOptions = {
  on: false,
  frame: 'mac',
  chrome: 'light',
  url: '',
  background: 'indigo',
  customColor: '#FFFFFF',
  padding: 64,
  corners: 8,
  shadow: true,
  stamp: 'off',
}

/** The settings key. Stored like `exportFormat` and `exportScale`, so it survives reloads. */
export const PRESENT_KEY = 'presentOptions'

/** Padding presets, matching the design reference's None / S / M / L. */
export const PRESENT_PADDINGS: readonly number[] = [0, 32, 64, 104]

/** Corner presets, matching the design reference's Square / Soft / Round. */
export const PRESENT_CORNERS: readonly number[] = [0, 8, 22]

export const PRESENT_FRAME_STYLES: readonly PresentFrameStyle[] = ['mac', 'windows']
export const PRESENT_CHROME_THEMES: readonly PresentChromeTheme[] = ['light', 'dark']
export const PRESENT_BACKGROUNDS: readonly PresentBackground[] = [
  'none',
  'indigo',
  'mint',
  'ocean',
  'paper',
  'slate',
  'sunset',
  'custom',
]
export const PRESENT_STAMP_MODES: readonly PresentStampMode[] = ['off', 'date', 'datetime', 'iso']

export interface GradientStop {
  at: number
  color: string
}

/**
 * The six gradient backgrounds, as stop lists. Diagonal top-left to bottom-right, which is the one
 * direction that reads as a wash rather than a curtain. The hues stay close to the six annotation
 * colours the design language already fixed, so the palette does not grow a phantom seventh set.
 */
export const PRESENT_GRADIENTS: Record<Exclude<PresentBackground, 'none' | 'custom'>, readonly GradientStop[]> = {
  indigo: [
    { at: 0, color: '#4A90E2' },
    { at: 1, color: '#1D3FA0' },
  ],
  mint: [
    { at: 0, color: '#3ED58A' },
    { at: 1, color: '#0F7A4C' },
  ],
  ocean: [
    { at: 0, color: '#57C6E8' },
    { at: 1, color: '#1565A8' },
  ],
  paper: [
    { at: 0, color: '#F5F3EE' },
    { at: 1, color: '#DDD8CE' },
  ],
  slate: [
    { at: 0, color: '#505761' },
    { at: 1, color: '#23262C' },
  ],
  sunset: [
    { at: 0, color: '#F5A524' },
    { at: 1, color: '#E0342D' },
  ],
}

/** The six annotation-colour anchors these gradients are derived from. */
export const PRESENT_ANCHOR_COLORS: readonly string[] = ['#E11900', '#1A1A1A', '#FFFFFF', '#1D6BE5', '#12A150', '#F5A524']

/**
 * The address the fake bar shows. An empty override falls back to the captured page's URL, and a
 * capture with no address has nothing honest to show -- so the bar falls back to the page title
 * rather than inventing a domain.
 */
export function presentAddress(override: string, capturedUrl: string | undefined, title: string): string {
  const trimmed = override.trim()
  if (trimmed !== '') return trimmed
  return (capturedUrl ?? '').trim() !== '' ? (capturedUrl as string) : title
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function two(value: number): string {
  return String(value).padStart(2, '0')
}

function dateText(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

function timeText(date: Date): string {
  const hours = date.getHours()
  const half = hours >= 12 ? 'PM' : 'AM'
  const shown = hours % 12 === 0 ? 12 : hours % 12
  return `${shown}:${two(date.getMinutes())} ${half}`
}

/**
 * The date stamp's text for a mode and a moment, or `null` for off.
 *
 * Deliberately not `toLocaleString`: the locale a browser runs in decides what the stamp *says*,
 * which would make the acceptance row's expected value depend on the viewer's machine. A fixed
 * format (like the suggested filename) stays testable in plain Node.
 */
export function stampText(mode: PresentStampMode, date: Date): string | null {
  if (mode === 'off') return null
  if (mode === 'date') return dateText(date)
  if (mode === 'datetime') return `${dateText(date)}, ${timeText(date)}`
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * A stored value is whatever was in IndexedDB last time, which is not necessarily a PresentOptions.
 * Every field is validated independently and falls back on its own, so one corrupt field cannot
 * reset the whole panel the way a blanket `defaults` merge would.
 */
export function readPresentOptions(stored: unknown): PresentOptions {
  const raw = (stored ?? {}) as Partial<PresentOptions>
  return {
    on: typeof raw.on === 'boolean' ? raw.on : DEFAULT_PRESENT_OPTIONS.on,
    frame: PRESENT_FRAME_STYLES.includes(raw.frame as PresentFrameStyle)
      ? (raw.frame as PresentFrameStyle)
      : DEFAULT_PRESENT_OPTIONS.frame,
    chrome: PRESENT_CHROME_THEMES.includes(raw.chrome as PresentChromeTheme)
      ? (raw.chrome as PresentChromeTheme)
      : DEFAULT_PRESENT_OPTIONS.chrome,
    url: typeof raw.url === 'string' ? raw.url : DEFAULT_PRESENT_OPTIONS.url,
    background: PRESENT_BACKGROUNDS.includes(raw.background as PresentBackground)
      ? (raw.background as PresentBackground)
      : DEFAULT_PRESENT_OPTIONS.background,
    customColor: isHexColor(raw.customColor ?? '') ? (raw.customColor as string) : DEFAULT_PRESENT_OPTIONS.customColor,
    padding: PRESENT_PADDINGS.includes(raw.padding as number)
      ? (raw.padding as number)
      : DEFAULT_PRESENT_OPTIONS.padding,
    corners: PRESENT_CORNERS.includes(raw.corners as number)
      ? (raw.corners as number)
      : DEFAULT_PRESENT_OPTIONS.corners,
    shadow: typeof raw.shadow === 'boolean' ? raw.shadow : DEFAULT_PRESENT_OPTIONS.shadow,
    stamp: PRESENT_STAMP_MODES.includes(raw.stamp as PresentStampMode)
      ? (raw.stamp as PresentStampMode)
      : DEFAULT_PRESENT_OPTIONS.stamp,
  }
}

/** True when a value is a hex colour the colour input can round-trip. */
export function isPresentColor(value: string): boolean {
  return isHexColor(value)
}
