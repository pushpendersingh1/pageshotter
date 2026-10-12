/**
 * The geometry of the mock browser chrome, as pure numbers.
 *
 * A presented screenshot's frame is a "template layer" in the same shape real Chrome is drawn with: three bitmap strips -- a left piece (window controls and the start of
 * the toolbar), a narrow tiling centre piece, and a right piece (toolbar icons) -- with the page URL
 * and the date drawn as canvas text *over* the strips at render time, never baked into them. That
 * last property is what lets the address be honest per capture and the date render in Chrome's own
 * omnibox colours.
 *
 * Every number here is in design units: one CSS pixel of the captured page. The compositor multiplies
 * by the render unit (file pixels per design pixel) so the frame keeps the same proportion to the
 * shot at any export scale or display density, and strips are chosen per density so a 2x render maps
 * one asset pixel to one file pixel with nothing resampled.
 *
 * The values are measured against real Chrome's window chrome: an 80px band -- 40px tab strip over a 40px toolbar -- a 348px mac left piece whose
 * omnibox text starts at 143, and a 10px centre slice that tiles. They are geometry, not artwork:
 * the strip bitmaps themselves are ours, shot from Chrome and refined in Figma, and until those land the compositor draws procedural placeholders at exactly this
 * geometry so the whole render path is exercised unchanged.
 */

import type { PresentFrameStyle } from './presentation-options'

/** Asset density: strip bitmaps exist at 1x and 2x. */
export type ChromeDensity = 1 | 2

export interface ChromeTemplate {
  /** The chrome band's height: tab strip over toolbar, one piece, in design units. */
  band: number
  leftW: number
  centerW: number
  rightW: number
  /** The URL text's origin and baseline inside the band. */
  urlX: number
  urlBaseline: number
  urlSize: number
  /** Gap kept between the URL text's truncation limit and the right piece. */
  urlInset: number
  /**
   * The bookmark star's left edge, measured from where the right piece starts. The omnibox pill
   * does not end with the centre tile -- it runs on into the right piece, and the star is drawn
   * inside it -- so this is what the date stamp must clear, not the piece boundary. Measured off
   * the artwork: mac 8, windows 27, which is why a date placed a fixed distance from the boundary
   * left a visibly wider gap on windows than on mac.
   */
  bookmarkX: number
  /**
   * Clearance kept between text and the icon it sits beside -- the date's right edge from the
   * bookmark star, and the URL's own origin from the config icon inside the pill. One number for
   * both, because a reader sees one rhythm across the toolbar row.
   */
  textIconGap: number
  dateBaseline: number
  dateSize: number
  /** Windows frames carry a nested window border around the whole card; mac frames do not. */
  border: readonly { inset: number; width: number; color: string }[]
}

/**
 * mac: traffic lights, one active tab, then back / forward / reload and the omnibox in the left
 * piece; the right piece carries bookmark and menu icons. The URL is drawn over the omnibox, which
 * the left and centre pieces jointly draw, so its origin sits past the omnibox's own icon. The
 * centre slice is 5 design units -- the one width that tiles the omnibox undetectably.
 */
/**
 * Both templates share one text row: the omnibox pill in the artwork spans y 47..75 on mac and
 * 46..74 on windows -- the same 80-unit band with the pill centred on y 60.5 -- so the URL and the
 * date write on one baseline, 65: the pill's centre plus the optical offset a 14px face needs to
 * look centred in it. That is also where Chrome itself puts the address.
 */
export const MAC_TEMPLATE: ChromeTemplate = {
  band: 80,
  leftW: 348,
  centerW: 5,
  rightW: 111,
  urlX: 143,
  urlBaseline: 65,
  urlSize: 14,
  urlInset: 16,
  bookmarkX: 8,
  textIconGap: 12,
  dateBaseline: 65,
  dateSize: 13,
  border: [],
}

/**
 * windows: the window controls ride the tab strip's far end in the right piece, and the toolbar runs
 * the band's lower 40 units -- the same 80-unit band as mac, now that the artwork carries one
 * consistent geometry. No drawn border: the strip artwork carries the window edge itself.
 *
 * `urlX` is 131, not 140: the config icon inside this artwork's omnibox ends at x 118 (mac's ends at
 * 130), so the old value left the address 21 units clear of the icon where mac's sits 12 clear, and
 * the difference read as a hole in the windows bar. Both now keep `textIconGap`.
 */
export const WINDOWS_TEMPLATE: ChromeTemplate = {
  band: 80,
  leftW: 282,
  centerW: 10,
  rightW: 120,
  urlX: 131,
  urlBaseline: 65,
  urlSize: 14,
  urlInset: 16,
  bookmarkX: 27,
  textIconGap: 12,
  dateBaseline: 65,
  dateSize: 13,
  border: [],
}

export function chromeTemplateFor(kind: PresentFrameStyle): ChromeTemplate {
  return kind === 'mac' ? MAC_TEMPLATE : WINDOWS_TEMPLATE
}

/**
 * The density whose strips a render of `unit` file pixels per design pixel should draw with. From
 * 1.5 up the 2x set maps at or above one asset pixel per file pixel; below that the 1x set is
 * already denser than the output.
 */
export function chromeDensityFor(unit: number): ChromeDensity {
  return unit >= 1.5 ? 2 : 1
}

/** One piece of the URL, coloured as Chrome's omnibox colours it. */
export interface UrlSegment {
  text: string
  color: string
}

/**
 * Chrome's omnibox palette, per chrome theme: the scheme is grey, the separator and path greyer,
 * the host near-black on light chrome and near-white on dark. The same segmentation the omnibox
 * applies, so a presented URL reads as the address bar it imitates.
 */
const LIGHT_INK = { scheme: '#5F6368', dim: '#80868B', host: '#202124' }
const DARK_INK = { scheme: '#9AA0A6', dim: '#9AA0A6', host: '#E8EAED' }

/** Splits what follows a scheme into host and path, dropping a lone trailing slash. */
function hostAndPath(rest: string): { host: string; path: string } {
  const host = (rest.split('/')[0] ?? '').split(':')[0] ?? ''
  let path = rest.substring(host.length)
  if (path.indexOf('/') === path.length - 1) path = path.substring(0, path.length - 1)
  return { host, path }
}

/**
 * Splits an address into omnibox-coloured segments. `https` gets the scheme grey and the lock the
 * strip already draws; `http` shows no scheme, exactly as Chrome hides it; anything else (a bare
 * host, a page title used as the address) is one plain run. The ink follows the chrome theme.
 */
export function urlSegments(address: string, theme: 'light' | 'dark' = 'light'): UrlSegment[] {
  const ink = theme === 'dark' ? DARK_INK : LIGHT_INK
  if (address.startsWith('https://')) {
    const { host, path } = hostAndPath(address.substring('https://'.length))
    return [
      { text: 'https', color: ink.scheme },
      { text: '://', color: ink.dim },
      { text: host, color: ink.host },
      ...(path === '' ? [] : [{ text: path, color: ink.dim }]),
    ]
  }
  if (address.startsWith('http://')) {
    const { host, path } = hostAndPath(address.substring('http://'.length))
    return [
      { text: host, color: ink.host },
      ...(path === '' ? [] : [{ text: path, color: ink.dim }]),
    ]
  }
  return [{ text: address, color: ink.host }]
}

/** The date stamp's ink inside the band, per chrome theme. */
export function chromeInk(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? DARK_INK.host : LIGHT_INK.host
}

/**
 * Where the three strip pieces sit across a window `fullWidth` design units wide.
 *
 * The left piece pins to the left edge and the right piece to the right edge; the centre piece tiles
 * the run between them. A window too narrow to hold both end pieces drops the right piece entirely
 * and lets the centre tile run to the edge -- the graceful degrade, so a narrow capture still gets a
 * coherent frame rather than overlapping artwork.
 */
export interface PiecePlan {
  leftW: number
  /** Where the tiled centre run starts and ends. */
  centerStart: number
  centerEnd: number
  /** Where the right piece draws, or `null` when the window is too narrow to hold it. */
  rightX: number | null
}

export function piecePlan(fullWidth: number, template: ChromeTemplate): PiecePlan {
  const rightX = fullWidth - template.rightW
  if (rightX < template.leftW) {
    return { leftW: template.leftW, centerStart: template.leftW, centerEnd: fullWidth, rightX: null }
  }
  return {
    leftW: template.leftW,
    centerStart: template.leftW,
    centerEnd: rightX,
    rightX,
  }
}

/**
 * Where the date stamp's right edge sits, in design units across a window `fullWidth` wide: just
 * clear of the bookmark star, which lives inside the omnibox a little way into the right piece.
 * That places the stamp *past* the piece boundary, which is correct -- the pill's own background
 * runs on behind it. When the window is too narrow to carry a right piece at all there is no star to
 * clear, so the stamp falls back to the window's edge less one gap.
 */
export function dateRightEdge(fullWidth: number, template: ChromeTemplate): number {
  const plan = piecePlan(fullWidth, template)
  if (plan.rightX === null) return fullWidth - template.textIconGap
  return plan.rightX + template.bookmarkX - template.textIconGap
}

/**
 * How far the URL text may run: to the right piece's edge (or the window's, when the right piece was
 * dropped), less the inset. `reserved` is width a date stamp has already claimed in the same row.
 */
export function urlMaxWidth(fullWidth: number, template: ChromeTemplate, reserved = 0): number {
  const plan = piecePlan(fullWidth, template)
  const limit = plan.rightX ?? fullWidth
  return Math.max(0, limit - template.urlX - template.urlInset - reserved)
}
