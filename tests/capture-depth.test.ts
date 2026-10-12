import { describe, expect, it } from 'vitest'
import {
  CAPTURE_DEADLINE_MS,
  DEFAULT_LONG_PAGE_POLICY,
  FOLLOW_EXTRA_SECTIONS,
  LONG_PAGE_CHOICES,
  deadlineReached,
  depthAllowance,
  outgrewAllowance,
} from '../src/shared/capture-depth'
import { CAPTURE_LIMITS } from '../src/shared/capture-plan'

const VIEWPORT = 800
const START = 20_000

/**
 * Replays a capture against a page whose measured height follows `heights`, and reports how many
 * sections were taken. The loop mirrors the service worker's: the allowance is computed from the
 * height frozen at the start, never from the live one.
 */
function sectionsTaken(policy: Parameters<typeof depthAllowance>[0], heights: number[]): number {
  const frozen = heights[0] ?? 0
  const allowance = depthAllowance(policy, frozen, VIEWPORT)
  let taken = 0
  // The real loop keeps asking for sections until it is done, so a page whose scripted heights run
  // out holds its last measured height rather than ending the capture.
  while (taken < CAPTURE_LIMITS.maxSegments) {
    const height = heights[Math.min(taken, heights.length - 1)] ?? 0
    taken += 1
    // Mirrors the worker: outgrowing the allowance sets a flag, it does not end the loop. Only the
    // planned height -- already capped at the allowance -- decides when capture is finished.
    if (taken * VIEWPORT >= Math.min(height, allowance)) break
  }
  return taken
}

describe('depth allowance', () => {
  it('defaults to following, which is the only choice that handles both page shapes', () => {
    expect(DEFAULT_LONG_PAGE_POLICY).toBe('follow')
    expect(LONG_PAGE_CHOICES.map((c) => c.policy)).toContain(DEFAULT_LONG_PAGE_POLICY)
  })

  it('freezes at the starting height, ignoring anything the page adds afterwards', () => {
    expect(depthAllowance('freeze', START, VIEWPORT)).toBe(START)
  })

  it('grants follow a fixed number of extra sections, not a multiple of the height', () => {
    // The property that made a multiplier wrong: the extension must not depend on how tall the page
    // already is, or a one-screen page gets one extra section and a huge page gets thousands.
    const shortPage = depthAllowance('follow', VIEWPORT, VIEWPORT) - VIEWPORT
    const tallPage = depthAllowance('follow', 60_000, VIEWPORT) - 60_000
    expect(shortPage).toBe(tallPage)
    expect(shortPage).toBe(VIEWPORT * FOLLOW_EXTRA_SECTIONS)
  })

  it('never bounds an unbounded capture', () => {
    expect(depthAllowance('unbounded', START, VIEWPORT)).toBe(Number.POSITIVE_INFINITY)
    expect(outgrewAllowance(Number.MAX_SAFE_INTEGER, depthAllowance('unbounded', START, VIEWPORT))).toBe(
      false,
    )
  })

  it('tolerates a one-pixel measurement wobble rather than calling it growth', () => {
    expect(outgrewAllowance(START + 1, START)).toBe(false)
    expect(outgrewAllowance(START + 2, START)).toBe(true)
  })
})

describe('the two page shapes this has to tell apart', () => {
  /** A page that lazily fills in for a few sections and then settles: must capture to its end. */
  const lazy = [START, START + 1_000, START + 2_000, START + 2_400, START + 2_400, START + 2_400]
  /** A feed that appends about a viewport every section: has no end to capture to. */
  const feed = Array.from({ length: 400 }, (_, i) => START + i * (VIEWPORT - 100))

  it('captures a lazy page in full under the default policy', () => {
    expect(outgrewAllowance(Math.max(...lazy), depthAllowance('follow', START, VIEWPORT))).toBe(false)
  })

  it('stops a feed at the allowance, not at the section ceiling', () => {
    // Everything the page had on load, plus the extension -- and nothing beyond it, however long
    // the feed goes on.
    const taken = sectionsTaken('follow', feed)
    expect(taken).toBe(Math.ceil(START / VIEWPORT) + FOLLOW_EXTRA_SECTIONS)
    expect(taken).toBeLessThan(CAPTURE_LIMITS.maxSegments / 4)
  })

  it('captures the whole allowance rather than stopping where growth was first seen', () => {
    /*
     * The regression a real screenshot caught. The first version returned as soon as the page
     * was *known* to exceed the allowance, which happens many sections before the allowance is
     * reached -- so the capture lost the sections it was entitled to and the assembled image was
     * padded to the planned height with blank space. A feed that announces its full length on the
     * very first section must still be captured to the allowance, not to section one.
     */
    const announcesEarly = [START, START * 50, START * 50, START * 50]
    expect(outgrewAllowance(announcesEarly[1] ?? 0, depthAllowance('follow', START, VIEWPORT))).toBe(true)
    expect(sectionsTaken('follow', announcesEarly)).toBe(Math.ceil(START / VIEWPORT) + FOLLOW_EXTRA_SECTIONS)
  })

  it('cuts the lazy page short under freeze -- the cost the setting exists to let a user choose', () => {
    expect(outgrewAllowance(Math.max(...lazy), depthAllowance('freeze', START, VIEWPORT))).toBe(true)
  })

  it('terminates on a feed even when the page reports absurd growth in one step', () => {
    const taken = sectionsTaken('follow', [START, START * 100, START * 200])
    expect(taken).toBe(Math.ceil(START / VIEWPORT) + FOLLOW_EXTRA_SECTIONS)
    expect(taken).toBeLessThan(CAPTURE_LIMITS.maxSegments)
  })
})

describe('the wall clock', () => {
  it('does not fire before the budget is spent', () => {
    expect(deadlineReached(1_000, 1_000 + CAPTURE_DEADLINE_MS - 1)).toBe(false)
  })

  it('fires once the budget is spent', () => {
    expect(deadlineReached(1_000, 1_000 + CAPTURE_DEADLINE_MS)).toBe(true)
  })

  it('is short enough to bound the wait and long enough to be worth having', () => {
    // Stated as a test because the value is a judgement that was argued over: one minute is below
    // the ~140s a full-depth healthy capture can legitimately take, so it will truncate some very
    // long pages. That is the accepted trade, and this test is where it is recorded.
    expect(CAPTURE_DEADLINE_MS).toBeGreaterThanOrEqual(30_000)
    expect(CAPTURE_DEADLINE_MS).toBeLessThanOrEqual(180_000)
  })
})
