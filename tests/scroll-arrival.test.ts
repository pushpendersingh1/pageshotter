import { describe, expect, it } from 'vitest'
import {
  ARRIVAL_STABLE_FRAMES,
  scrollToAndWait,
  type ScrollArrivalIO,
} from '../src/shared/scroll-arrival'

/**
 * A scroller driven by a frame clock, so the pages that break a naive `scrollTo` can be written
 * down exactly: one that answers immediately, one that eases (CSS smooth scrolling), and one that
 * writes the offset itself every frame from its own target, which is what the Lenis family does and
 * what a single `scrollTo` cannot survive.
 */
function harness(options: {
  start: number
  /** Applies the page's own behaviour for one frame, given what the capture last wrote. */
  perFrame?: (state: { offset: number; requested: number; frame: number }) => number
}) {
  let offset = options.start
  let requested = options.start
  let frame = 0
  let time = 0
  const io: ScrollArrivalIO = {
    read: () => offset,
    write: (value) => {
      requested = value
      offset = value
    },
    frame: async () => {
      frame += 1
      time += 16
      offset = options.perFrame ? options.perFrame({ offset, requested, frame }) : offset
    },
    now: () => time,
  }
  return { io, offsetNow: () => offset, frames: () => frame }
}

describe('scrollToAndWait', () => {
  it('arrives on a page that simply obeys, once the offset has held still', async () => {
    const { io } = harness({ start: 3000 })
    const result = await scrollToAndWait(io, 0)
    expect(result).toMatchObject({ arrived: true, offset: 0, fought: false })
    // Stillness is what is being waited for, so it costs exactly the frames it promises.
    expect(result.frames).toBe(ARRIVAL_STABLE_FRAMES)
  })

  it('waits out CSS smooth scrolling instead of photographing the middle of it', async () => {
    // The write is honoured slowly: the offset eases from where it was toward what was asked.
    let eased = 3000
    const { io } = harness({
      start: 3000,
      perFrame: ({ requested }) => {
        eased += (requested - eased) * 0.5
        return Math.abs(eased - requested) < 0.5 ? requested : eased
      },
    })
    const result = await scrollToAndWait(io, 0)
    expect(result.arrived).toBe(true)
    expect(result.offset).toBe(0)
    expect(result.frames).toBeGreaterThan(ARRIVAL_STABLE_FRAMES)
  })

  it('wins against a page that rewrites the offset every frame from its own target', async () => {
    // A scroll hijacker: each frame it eases the offset back toward where the reader had it. The
    // capture writes after the page does, so re-asserting every frame is what lands the position --
    // a single scrollTo is undone on the very next frame.
    let hijackTarget = 3000
    const { io } = harness({
      start: 3000,
      perFrame: ({ offset }) => {
        // The hijacker gives up on its own target once the page has been held elsewhere for a while,
        // which is how these libraries resynchronise with an external scroll.
        hijackTarget += (offset - hijackTarget) * 0.6
        return offset + (hijackTarget - offset) * 0.4
      },
    })
    const result = await scrollToAndWait(io, 0)
    expect(result.arrived).toBe(true)
    expect(result.fought).toBe(true)
    expect(Math.abs(result.offset)).toBeLessThanOrEqual(1)
  })

  it('gives up honestly on a page that never stops dragging the scroller away', async () => {
    // Scrolljacking: the write lands, and the page hauls it straight back, every frame, forever.
    // The capture proceeds rather than hanging, and the worker's own scroll-gap check is what
    // reports the result -- this loop's job is to have tried honestly, not to win every time.
    const { io } = harness({ start: 3000, perFrame: () => 3000 })
    const result = await scrollToAndWait(io, 0, { timeoutMs: 100 })
    expect(result.arrived).toBe(false)
    expect(result.fought).toBe(true)
    expect(result.offset).toBe(3000)
  })

  it('reports a fight when the page lets go and then snatches it back', async () => {
    const { io } = harness({
      start: 3000,
      perFrame: ({ offset, frame }) => (frame === 2 ? 900 : offset),
    })
    const result = await scrollToAndWait(io, 0, { timeoutMs: 400 })
    expect(result.fought).toBe(true)
  })

  it('accepts a page clamped at its own bottom as an arrival', async () => {
    // Asking for 5000 on a page whose floor is 4200: the scroller cannot go further, and that is
    // not a miss. The caller supplies the predicate, so this module never needs the geometry.
    const floor = 4200
    let offset = 0
    const io: ScrollArrivalIO = {
      read: () => offset,
      write: (value) => {
        offset = Math.min(value, floor)
      },
      frame: async () => undefined,
      now: () => 0,
    }
    const result = await scrollToAndWait(io, 5000, {
      settled: (value) => Math.abs(value - 5000) <= 1 || value === floor,
    })
    expect(result).toMatchObject({ arrived: true, offset: floor })
  })

  it('does not believe an offset that is only correct in passing', async () => {
    // The offset crosses the target on its way past. One frame of correctness is not arrival.
    const path = [0, 900, 0]
    let index = -1
    const { io } = harness({
      start: 3000,
      perFrame: () => {
        index += 1
        return path[Math.min(index, path.length - 1)]!
      },
    })
    const result = await scrollToAndWait(io, 0, { timeoutMs: 400 })
    expect(result.arrived).toBe(true)
    expect(result.fought).toBe(true)
    expect(result.frames).toBeGreaterThan(2)
  })
})
