import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRESENT_OPTIONS,
  isPresentColor,
  PRESENT_ANCHOR_COLORS,
  PRESENT_BACKGROUNDS,
  PRESENT_CORNERS,
  PRESENT_FRAME_STYLES,
  PRESENT_GRADIENTS,
  PRESENT_PADDINGS,
  PRESENT_STAMP_MODES,
  presentAddress,
  readPresentOptions,
  stampText,
  type PresentOptions,
} from '../src/result/presentation-options'

const FULL: PresentOptions = {
  on: true,
  frame: 'windows',
  chrome: 'dark',
  url: 'https://example.com/page',
  background: 'mint',
  customColor: '#112233',
  padding: 104,
  corners: 22,
  shadow: false,
  stamp: 'iso',
}

describe('present address', () => {
  it('uses the override when present', () => {
    expect(presentAddress('  example.com/path  ', 'https://site.example', 'Title')).toBe('example.com/path')
  })

  it('falls back to the captured URL when the override is blank', () => {
    expect(presentAddress('', 'https://site.example/actual', 'Title')).toBe('https://site.example/actual')
  })

  it('falls back to the title rather than inventing a domain', () => {
    expect(presentAddress('', undefined, 'Page title')).toBe('Page title')
  })
})

describe('stamp text', () => {
  const at = new Date(2026, 7, 30, 22, 14)

  it('is off entirely', () => {
    expect(stampText('off', at)).toBeNull()
  })

  it('writes the four fixed formats', () => {
    expect(stampText('date', at)).toBe('30 Aug 2026')
    expect(stampText('datetime', at)).toBe('30 Aug 2026, 10:14 PM')
    expect(stampText('iso', at)).toBe('2026-08-30T22:14')
  })

  it('is deterministic whatever the runtime locale', () => {
    expect(stampText('date', at)).toBe(stampText('date', new Date(at)))
  })
})

describe('read present options', () => {
  it('round-trips a valid stored object', () => {
    expect(readPresentOptions(FULL)).toEqual(FULL)
  })

  it('defaults wholesale when nothing is stored', () => {
    expect(readPresentOptions(undefined)).toEqual(DEFAULT_PRESENT_OPTIONS)
  })

  it('falls back field by field instead of blanketing', () => {
    const partial = readPresentOptions({
      on: true,
      frame: 'themes',
      url: 42,
      background: 'neon',
      customColor: 'red',
      padding: 7,
      corners: 99,
      shadow: 'yes',
      stamp: 'soon',
    } as unknown)
    expect(partial.on).toBe(true)
    expect(partial.frame).toBe(DEFAULT_PRESENT_OPTIONS.frame)
    expect(partial.url).toBe('')
    expect(partial.background).toBe(DEFAULT_PRESENT_OPTIONS.background)
    expect(partial.customColor).toBe(DEFAULT_PRESENT_OPTIONS.customColor)
    expect(partial.padding).toBe(DEFAULT_PRESENT_OPTIONS.padding)
    expect(partial.corners).toBe(DEFAULT_PRESENT_OPTIONS.corners)
    expect(partial.shadow).toBe(DEFAULT_PRESENT_OPTIONS.shadow)
    expect(partial.stamp).toBe(DEFAULT_PRESENT_OPTIONS.stamp)
  })
})

describe('the palette', () => {
  it('offers six gradients plus the custom solid', () => {
    expect(PRESENT_BACKGROUNDS).toHaveLength(8)
    expect(PRESENT_BACKGROUNDS).toContain('none')
    expect(PRESENT_BACKGROUNDS).toContain('custom')
  })

  it("keeps hues in the annotation palette's families without inventing a spare set", () => {
    // The sunset gradient opens on the design language's own amber, so at least one anchor hex
    // survives verbatim into the presentation palette -- the family, not a fork.
    expect(PRESENT_GRADIENTS.sunset[0]?.color).toBe('#F5A524')
    expect(PRESENT_ANCHOR_COLORS).toContain('#F5A524')
  })

  it('writes two ordered stops per gradient', () => {
    const entries = Object.entries(PRESENT_GRADIENTS) as Array<[string, readonly { at: number; color: string }[]]>
    for (const [name, stops] of entries) {
      const first = stops[0] as { at: number; color: string } | undefined
      const last = stops[1] as { at: number; color: string } | undefined
      expect(stops).toHaveLength(2)
      expect(first?.at).toBe(0)
      expect(last?.at).toBe(1)
      expect(first?.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(last?.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(name).not.toBe('custom')
    }
  })

  it('only accepts a six-digit hex custom colour', () => {
    expect(isPresentColor('#1D6BE5')).toBe(true)
    for (const junk of ['red', '#fff', '#11223344', 'E11900']) expect(isPresentColor(junk)).toBe(false)
  })

  it('keeps the preset lists to what the panel can offer', () => {
    expect(PRESENT_FRAME_STYLES).toEqual(['mac', 'windows'])
    expect(PRESENT_PADDINGS).toEqual([0, 32, 64, 104])
    expect(PRESENT_CORNERS).toEqual([0, 8, 22])
    expect(PRESENT_STAMP_MODES).toEqual(['off', 'date', 'datetime', 'iso'])
  })
})
