import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_WAIT_MS,
  DEFAULT_SECTION_WAIT_MS,
  IMAGE_WAIT_CHOICES,
  MAX_IMAGE_WAIT_MS,
  MAX_SECTION_WAIT_MS,
  SECTION_WAIT_CHOICES,
  remainingSectionWaitMs,
  sectionWaitCostMs,
} from '../src/shared/capture-wait'

describe('the per-section wait floor', () => {
  it('is off by default, because it is paid on every section of every capture', () => {
    expect(DEFAULT_SECTION_WAIT_MS).toBe(0)
    expect(SECTION_WAIT_CHOICES[0]?.ms).toBe(DEFAULT_SECTION_WAIT_MS)
  })

  it('costs nothing when it is off, however slow the section was', () => {
    expect(remainingSectionWaitMs(0, 0)).toBe(0)
    expect(remainingSectionWaitMs(0, 5_000)).toBe(0)
  })

  it('holds a quick section for the remainder of the floor', () => {
    expect(remainingSectionWaitMs(1_000, 150)).toBe(850)
  })

  it('covers the section rather than being added to it', () => {
    /*
     * The distinction the whole shape rests on. A section that already spent longer than the floor
     * waiting for its images has met it, and must not be held again -- adding the floor on top would
     * charge the slowest sections the most while leaving the quick ones, the ones this exists for,
     * exactly as quick as they were.
     */
    expect(remainingSectionWaitMs(500, 900)).toBe(0)
    expect(remainingSectionWaitMs(500, 500)).toBe(0)
  })

  it('clamps a stored value that is larger than anything the settings page offers', () => {
    expect(remainingSectionWaitMs(60_000, 0)).toBe(MAX_SECTION_WAIT_MS)
    expect(remainingSectionWaitMs(3_000, 0)).toBe(3_000)
  })

  it('survives nonsense without holding a capture open', () => {
    expect(remainingSectionWaitMs(Number.NaN, 0)).toBe(0)
    expect(remainingSectionWaitMs(Number.POSITIVE_INFINITY, 0)).toBe(0)
    expect(remainingSectionWaitMs(-1_000, 0)).toBe(0)
    expect(remainingSectionWaitMs(1_000, -50)).toBe(1_000)
  })

  it('offers only the documented choices, and the largest is the clamp', () => {
    expect(SECTION_WAIT_CHOICES.map((c) => c.ms)).toEqual([0, 500, 1_000, 1_500, 2_000, 3_000])
    expect(Math.max(...SECTION_WAIT_CHOICES.map((c) => c.ms))).toBe(MAX_SECTION_WAIT_MS)
  })

  it('rises without gaps a user would notice, so the next step up is always a real change', () => {
    // The steps real use asked for: half a second is too small a jump near the top,
    // and three seconds is the ceiling for a site that needs more than two.
    const steps = SECTION_WAIT_CHOICES.map((c) => c.ms)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(new Set(steps).size).toBe(steps.length)
  })

  it('quotes a cost the settings note can state before the choice is made', () => {
    // Two seconds across a twenty-section page is forty seconds, which is the number a user needs
    // to see: it is the setting, not the page, that makes a capture feel broken.
    expect(sectionWaitCostMs(2_000, 20)).toBe(40_000)
    expect(sectionWaitCostMs(0, 20)).toBe(0)
    expect(sectionWaitCostMs(2_000, 0)).toBe(0)
  })
})

describe('the per-section image wait ceiling', () => {
  it('defaults to the value the capture has always used, so nobody else’s captures change', () => {
    expect(DEFAULT_IMAGE_WAIT_MS).toBe(800)
    expect(IMAGE_WAIT_CHOICES.some((choice) => choice.ms === DEFAULT_IMAGE_WAIT_MS)).toBe(true)
  })

  it('offers Off, because an image that never loads otherwise costs the ceiling on every section', () => {
    expect(IMAGE_WAIT_CHOICES[0]?.ms).toBe(0)
  })

  it('never offers more than the ceiling a stored value is clamped to', () => {
    for (const choice of IMAGE_WAIT_CHOICES) {
      expect(choice.ms).toBeGreaterThanOrEqual(0)
      expect(choice.ms).toBeLessThanOrEqual(MAX_IMAGE_WAIT_MS)
    }
    expect(Math.max(...IMAGE_WAIT_CHOICES.map((choice) => choice.ms))).toBe(MAX_IMAGE_WAIT_MS)
  })

  it('rises without repeating a value, so no two options mean the same thing', () => {
    const values = IMAGE_WAIT_CHOICES.map((choice) => choice.ms)
    expect(values).toStrictEqual([...values].sort((a, b) => a - b))
    expect(new Set(values).size).toBe(values.length)
  })
})
