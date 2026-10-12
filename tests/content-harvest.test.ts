import { describe, expect, it } from 'vitest'
import { ContentHarvest, HARVEST_TOLERANCE_PX, harvestShift } from '../src/shared/content-harvest'
import { MAX_CAPTURED_LINKS, MAX_CAPTURED_RUNS, type PageContent } from '../src/shared/page-content'

const run = (text: string, x: number, y: number): PageContent['runs'][number] => ({
  text,
  x,
  y,
  width: text.length * 7,
  height: 16,
})

const pass = (...runs: PageContent['runs']): PageContent => ({ links: [], runs })

describe('ContentHarvest', () => {
  it('is empty until something is absorbed', () => {
    const harvest = new ContentHarvest()
    expect(harvest.isEmpty).toBe(true)
    harvest.absorb(pass(run('hello', 10, 20)))
    expect(harvest.isEmpty).toBe(false)
  })

  it('keeps a word measured once at every position only once', () => {
    const harvest = new ContentHarvest()
    for (let index = 0; index < 12; index += 1) harvest.absorb(pass(run('hello', 10, 20)))
    expect(harvest.result().runs).toHaveLength(1)
  })

  it('treats a word re-measured within the tolerance as the same word', () => {
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('hello', 10, 20)))
    harvest.absorb(pass(run('hello', 10 + HARVEST_TOLERANCE_PX, 20 - HARVEST_TOLERANCE_PX)))
    expect(harvest.result().runs).toHaveLength(1)
  })

  it('finds a near-miss that straddles two buckets', () => {
    // 15 and 17 fall either side of an 8px grid line, so the second is only recognised if the
    // neighbouring buckets are searched as well as the exact one.
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('hello', 15, 15)))
    harvest.absorb(pass(run('hello', 17, 17)))
    expect(harvest.result().runs).toHaveLength(1)
  })

  it('keeps the same word at a genuinely different place', () => {
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('hello', 10, 20)))
    harvest.absorb(pass(run('hello', 10, 400)))
    expect(harvest.result().runs).toHaveLength(2)
  })

  it('keeps what a virtualised page mounts at only one position', () => {
    // The reported failure: each message exists in the DOM at exactly one scroll position, so a
    // single harvest -- whichever position it ran at -- would have found one of these three.
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('first', 0, 100)))
    harvest.absorb(pass(run('second', 0, 900)))
    harvest.absorb(pass(run('third', 0, 1700)))
    expect(harvest.result().runs.map((entry) => entry.text)).toEqual(['first', 'second', 'third'])
  })

  it('preserves pass order, and DOM order inside a pass', () => {
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('left', 0, 100), run('right', 300, 100)))
    harvest.absorb(pass(run('below', 0, 900)))
    expect(harvest.result().runs.map((entry) => entry.text)).toEqual(['left', 'right', 'below'])
  })

  it('moves a later pass into the first pass image space', () => {
    const harvest = new ContentHarvest()
    const base = { x: 40, y: 48 }
    harvest.absorb(pass(run('hello', 100, 200)), harvestShift(base, base))
    // The scroller's top edge rose by 20px -- a collapsing header -- so the same word now measures
    // 20px higher, and must be stored where the first pass would have put it.
    harvest.absorb(pass(run('hello', 100, 180)), harvestShift(base, { x: 40, y: 28 }))
    const runs = harvest.result().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ x: 100, y: 200 })
  })

  it('stores shifted rects, not the raw ones', () => {
    const harvest = new ContentHarvest()
    harvest.absorb(pass(run('hello', 100, 180)), harvestShift({ x: 0, y: 0 }, { x: 0, y: -20 }))
    expect(harvest.result().runs[0]).toMatchObject({ x: 100, y: 200, height: 16 })
  })

  it('deduplicates a link by target and boxes, and keeps one that moved', () => {
    const harvest = new ContentHarvest()
    const link = { href: 'https://example.com/', rects: [{ x: 10, y: 20, width: 80, height: 16 }] }
    harvest.absorb({ links: [link], runs: [] })
    harvest.absorb({ links: [link], runs: [] })
    expect(harvest.result().links).toHaveLength(1)
    harvest.absorb({ links: [{ ...link, rects: [{ x: 10, y: 500, width: 80, height: 16 }] }], runs: [] })
    expect(harvest.result().links).toHaveLength(2)
  })

  it('stops at the run cap rather than growing without bound', () => {
    const harvest = new ContentHarvest()
    for (let index = 0; index < MAX_CAPTURED_RUNS + 50; index += 1) {
      harvest.absorb(pass(run(`word${index}`, 0, index * 20)))
    }
    expect(harvest.result().runs).toHaveLength(MAX_CAPTURED_RUNS)
  })

  it('stops at the link cap', () => {
    const harvest = new ContentHarvest()
    for (let index = 0; index < MAX_CAPTURED_LINKS + 20; index += 1) {
      harvest.absorb({
        links: [{ href: `https://example.com/${index}`, rects: [{ x: 0, y: index * 20, width: 40, height: 16 }] }],
        runs: [],
      })
    }
    expect(harvest.result().links).toHaveLength(MAX_CAPTURED_LINKS)
  })
})

describe('harvestShift', () => {
  it('is nothing when the origin has not moved', () => {
    expect(harvestShift({ x: 40, y: 48 }, { x: 40, y: 48 })).toEqual({ x: 0, y: 0 })
  })

  it('is the distance back to the base origin', () => {
    expect(harvestShift({ x: 40, y: 48 }, { x: 40, y: 28 })).toEqual({ x: 0, y: 20 })
  })
})
