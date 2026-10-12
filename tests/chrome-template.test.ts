import { describe, expect, it } from 'vitest'
import {
  chromeDensityFor,
  chromeTemplateFor,
  dateRightEdge,
  MAC_TEMPLATE,
  piecePlan,
  urlMaxWidth,
  urlSegments,
  WINDOWS_TEMPLATE,
} from '../src/result/chrome-template'

describe('chrome templates', () => {
  it('carries the measured band and strip geometry', () => {
    expect(MAC_TEMPLATE.band).toBe(80)
    expect(MAC_TEMPLATE.leftW).toBe(348)
    expect(MAC_TEMPLATE.centerW).toBe(5)
    expect(MAC_TEMPLATE.rightW).toBe(111)
    expect(WINDOWS_TEMPLATE.band).toBe(80)
    expect(WINDOWS_TEMPLATE.leftW).toBe(282)
    expect(WINDOWS_TEMPLATE.rightW).toBe(120)
  })

  it('carries no drawn border on either frame -- the strips carry the window edge', () => {
    expect(MAC_TEMPLATE.border).toEqual([])
    expect(WINDOWS_TEMPLATE.border).toEqual([])
  })

  it('selects the template by frame style', () => {
    expect(chromeTemplateFor('mac')).toBe(MAC_TEMPLATE)
    expect(chromeTemplateFor('windows')).toBe(WINDOWS_TEMPLATE)
  })
})

describe('strip density', () => {
  it('takes the 2x set from one and a half units up', () => {
    expect(chromeDensityFor(1)).toBe(1)
    expect(chromeDensityFor(1.49)).toBe(1)
    expect(chromeDensityFor(1.5)).toBe(2)
    expect(chromeDensityFor(2)).toBe(2)
  })
})

describe('piece plan', () => {
  it('pins the left piece, tiles the centre and parks the right piece at the far edge', () => {
    const plan = piecePlan(1280, MAC_TEMPLATE)
    expect(plan).toEqual({ leftW: 348, centerStart: 348, centerEnd: 1280 - 111, rightX: 1280 - 111 })
  })

  it('tiles the centre in whole pieces across the run, clipping the last', () => {
    const plan = piecePlan(1280, MAC_TEMPLATE)
    const run = plan.centerEnd - plan.centerStart
    expect(Math.ceil(run / MAC_TEMPLATE.centerW) * MAC_TEMPLATE.centerW).toBeGreaterThanOrEqual(run)
    expect(plan.centerStart).toBe(MAC_TEMPLATE.leftW)
  })

  it('drops the right piece rather than overlapping it when the window is narrow', () => {
    const plan = piecePlan(400, MAC_TEMPLATE)
    expect(plan.rightX).toBeNull()
    expect(plan.centerEnd).toBe(400)
    expect(plan.centerStart).toBe(348)
  })

  it('keeps the right piece for a window exactly wide enough', () => {
    const plan = piecePlan(MAC_TEMPLATE.leftW + MAC_TEMPLATE.rightW, MAC_TEMPLATE)
    expect(plan.rightX).toBe(MAC_TEMPLATE.leftW)
    expect(plan.centerEnd).toBe(plan.rightX)
  })
})

describe('url segments', () => {
  it('colours an https address scheme, host and path apart', () => {
    expect(urlSegments('https://example.com/path')).toEqual([
      { text: 'https', color: '#5F6368' },
      { text: '://', color: '#80868B' },
      { text: 'example.com', color: '#202124' },
      { text: '/path', color: '#80868B' },
    ])
  })

  it('hides the scheme of a plain http address, as the omnibox does', () => {
    const segments = urlSegments('http://example.com/page')
    expect(segments[0]).toEqual({ text: 'example.com', color: '#202124' })
    expect(segments.map((s) => s.text).join('')).toBe('example.com/page')
  })

  it('drops a trailing slash after the host without dropping the host', () => {
    expect(urlSegments('https://example.com/').map((s) => s.text).join('')).toBe('https://example.com')
  })

  it('shows a port with the host in the host colour', () => {
    const segments = urlSegments('http://localhost:3000/feed')
    expect(segments[0]).toEqual({ text: 'localhost', color: '#202124' })
    expect(segments.map((s) => s.text).join('')).toBe('localhost:3000/feed')
  })

  it('gives a non-address -- a page title -- one plain run', () => {
    expect(urlSegments('Page title')).toEqual([{ text: 'Page title', color: '#202124' }])
  })

  it('writes the dark omnibox in near-white ink', () => {
    expect(urlSegments('https://github.com/svgkit', 'dark')).toEqual([
      { text: 'https', color: '#9AA0A6' },
      { text: '://', color: '#9AA0A6' },
      { text: 'github.com', color: '#E8EAED' },
      { text: '/svgkit', color: '#9AA0A6' },
    ])
    expect(urlSegments('http://example.com', 'dark')[0]).toEqual({ text: 'example.com', color: '#E8EAED' })
    expect(urlSegments('Page title', 'dark')).toEqual([{ text: 'Page title', color: '#E8EAED' }])
  })
})

describe('url width', () => {
  it('runs from the URL origin to short of the right piece', () => {
    const plan = piecePlan(1280, MAC_TEMPLATE)
    expect(urlMaxWidth(1280, MAC_TEMPLATE)).toBe(plan.rightX! - MAC_TEMPLATE.urlX - MAC_TEMPLATE.urlInset)
  })

  it('reserves what a date stamp has claimed in the same row', () => {
    const open = urlMaxWidth(1280, MAC_TEMPLATE)
    expect(urlMaxWidth(1280, MAC_TEMPLATE, 90)).toBe(open - 90)
  })

  it('collapses to nothing rather than going negative on a sliver of window', () => {
    expect(urlMaxWidth(100, MAC_TEMPLATE)).toBe(0)
  })
})

/**
 * Two positions that read as holes in the toolbar row, both fixed against measurements taken
 * off the strip artwork itself rather than by eye. The icon edges below were measured by scanning
 * the shipped 1x PNGs column by column for ink over the omnibox row (y 46..75):
 *
 *   mac-header-left   config icon inside the pill   x 121..130
 *   windows-header-left                             x 109..118
 *   mac-header-right  bookmark star (inside the pill, which runs on into this piece)   x 8..19
 *   windows-header-right                                                              x 27..41
 */
const CONFIG_ICON_END = { mac: 130, windows: 118 }
const BOOKMARK_STAR_X = { mac: 8, windows: 27 }

describe('toolbar text against the artwork it sits in', () => {
  it('starts the URL the same distance clear of the config icon in both frames', () => {
    expect(MAC_TEMPLATE.urlX - CONFIG_ICON_END.mac - 1).toBe(MAC_TEMPLATE.textIconGap)
    expect(WINDOWS_TEMPLATE.urlX - CONFIG_ICON_END.windows - 1).toBe(WINDOWS_TEMPLATE.textIconGap)
    // The defect: windows used to start at 140, a 21-unit hole where mac had 12.
    expect(WINDOWS_TEMPLATE.urlX).toBeLessThan(140)
  })

  it('carries each frame\'s own bookmark-star offset', () => {
    expect(MAC_TEMPLATE.bookmarkX).toBe(BOOKMARK_STAR_X.mac)
    expect(WINDOWS_TEMPLATE.bookmarkX).toBe(BOOKMARK_STAR_X.windows)
  })

  it('ends the date stamp one gap clear of the star, past the piece boundary', () => {
    for (const template of [MAC_TEMPLATE, WINDOWS_TEMPLATE]) {
      const plan = piecePlan(1280, template)
      const star = plan.rightX! + template.bookmarkX
      expect(dateRightEdge(1280, template)).toBe(star - template.textIconGap)
      // Past the boundary, which is right: the omnibox pill runs on behind the stamp.
      expect(dateRightEdge(1280, template)).toBeGreaterThan(plan.rightX! - template.textIconGap)
    }
  })

  it('moves the stamp right of where the fixed 16-unit inset put it, further on windows', () => {
    const before = (template: typeof MAC_TEMPLATE) => piecePlan(1280, template).rightX! - 16
    const macShift = dateRightEdge(1280, MAC_TEMPLATE) - before(MAC_TEMPLATE)
    const winShift = dateRightEdge(1280, WINDOWS_TEMPLATE) - before(WINDOWS_TEMPLATE)
    expect(macShift).toBe(12)
    expect(winShift).toBe(31)
    expect(winShift).toBeGreaterThan(macShift)
  })

  it('falls back to the window edge when the frame is too narrow to carry a right piece', () => {
    const narrow = 200
    expect(piecePlan(narrow, MAC_TEMPLATE).rightX).toBeNull()
    expect(dateRightEdge(narrow, MAC_TEMPLATE)).toBe(narrow - MAC_TEMPLATE.textIconGap)
  })
})
