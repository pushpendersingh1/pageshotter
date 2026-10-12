import { describe, expect, it } from 'vitest'
import {
  MAX_TEXT_REVEALS,
  MIN_REVEAL_AREA_PX,
  type RescueBox,
  isCoveredBySibling,
  isRevealCandidate,
  overlapArea,
  videoRescueStep,
  videoSeekTarget,
} from '../src/shared/capture-rescue'

const faded = {
  opacity: 0,
  visibility: 'visible',
  display: 'block',
  position: 'static',
  width: 600,
  height: 200,
  hasText: true,
}

const box = (left: number, top: number, right: number, bottom: number): RescueBox => ({
  left,
  top,
  right,
  bottom,
})

describe('reviving text a scroll-reveal animation left invisible', () => {
  it('revives a faded paragraph', () => {
    expect(isRevealCandidate(faded)).toBe(true)
    expect(isRevealCandidate({ ...faded, opacity: 0.04 })).toBe(true)
  })

  it('leaves an element that is merely faint alone, because that is a design choice', () => {
    expect(isRevealCandidate({ ...faded, opacity: 0.2 })).toBe(false)
    expect(isRevealCandidate({ ...faded, opacity: 1 })).toBe(false)
  })

  it('rescues text only', () => {
    // A transparent image or spacer is not the defect this exists for, and reviving it is a guess.
    expect(isRevealCandidate({ ...faded, hasText: false })).toBe(false)
  })

  it('leaves anything hidden by a means other than opacity', () => {
    // `display: none` and `visibility: hidden` are how a page says "not now", unambiguously.
    expect(isRevealCandidate({ ...faded, display: 'none' })).toBe(false)
    expect(isRevealCandidate({ ...faded, visibility: 'hidden' })).toBe(false)
    expect(isRevealCandidate({ ...faded, visibility: 'collapse' })).toBe(false)
  })

  it('never touches a fixed or absolute element', () => {
    // Fixed is an overlay, which the session already positions deliberately; absolute is usually
    // the inactive half of a tab set or a carousel.
    expect(isRevealCandidate({ ...faded, position: 'fixed' })).toBe(false)
    expect(isRevealCandidate({ ...faded, position: 'absolute' })).toBe(false)
    expect(isRevealCandidate({ ...faded, position: 'relative' })).toBe(true)
    expect(isRevealCandidate({ ...faded, position: 'sticky' })).toBe(true)
  })

  it('ignores anything too small to be a hidden paragraph', () => {
    expect(isRevealCandidate({ ...faded, width: 50, height: 49 })).toBe(false)
    expect(isRevealCandidate({ ...faded, width: 50, height: 50 })).toBe(true)
    expect(50 * 50).toBe(MIN_REVEAL_AREA_PX)
  })

  it('treats a broken opacity as no reason to act', () => {
    expect(isRevealCandidate({ ...faded, opacity: Number.NaN })).toBe(false)
  })

  it('caps how much of a page one capture will rewrite', () => {
    // Past this the page is using opacity as a layout system, not as an animation.
    expect(MAX_TEXT_REVEALS).toBe(300)
  })
})

describe('the covered-by-a-sibling guard', () => {
  const subject = box(0, 0, 100, 100)

  it('holds back when a visible sibling sits over most of the element', () => {
    // The outgoing half of a cross-fade, a closed tab panel, a carousel slide underneath the
    // current one: reviving it stacks two sets of words in one place.
    expect(isCoveredBySibling(subject, [box(0, 0, 100, 100)])).toBe(true)
    expect(isCoveredBySibling(subject, [box(10, 10, 100, 100)])).toBe(true)
  })

  it('revives an element a sibling only clips the edge of', () => {
    expect(isCoveredBySibling(subject, [box(0, 0, 100, 50)])).toBe(false)
    expect(isCoveredBySibling(subject, [box(90, 0, 200, 100)])).toBe(false)
  })

  it('is unmoved by a sibling that does not touch it at all', () => {
    expect(isCoveredBySibling(subject, [box(200, 200, 300, 300)])).toBe(false)
    expect(isCoveredBySibling(subject, [])).toBe(false)
  })

  it('cannot divide by a zero-area element', () => {
    expect(isCoveredBySibling(box(5, 5, 5, 5), [box(0, 0, 100, 100)])).toBe(false)
  })

  it('measures the intersection, not the union', () => {
    expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(25)
    expect(overlapArea(box(0, 0, 10, 10), box(10, 10, 20, 20))).toBe(0)
  })
})

describe('seeking a video that has never loaded a frame', () => {
  const below = {
    top: 3_000,
    viewportHeight: 900,
    loop: false,
    duration: 120,
    hasPoster: false,
    readyState: 0,
  }

  it('seeks a video far below the fold', () => {
    expect(videoRescueStep(below)).toBe('seek')
  })

  it('never touches a video the user can already see', () => {
    // Changing what is on screen is the failure this exists to prevent, not an acceptable cost.
    expect(videoRescueStep({ ...below, top: 400 })).toBe('skip')
    expect(videoRescueStep({ ...below, top: 900 })).toBe('skip')
    expect(videoRescueStep({ ...below, top: 901 })).toBe('seek')
  })

  it('leaves a video that already has a frame to show', () => {
    // A poster is the frame the page itself chose; replacing it would be a worse picture.
    expect(videoRescueStep({ ...below, hasPoster: true })).toBe('skip')
    // readyState 2 is HAVE_CURRENT_DATA: something is already decoded and painted.
    expect(videoRescueStep({ ...below, readyState: 2 })).toBe('skip')
    expect(videoRescueStep({ ...below, readyState: 1 })).toBe('seek')
  })

  it('leaves a looping video alone', () => {
    // A loop is background decoration and is usually already running.
    expect(videoRescueStep({ ...below, loop: true })).toBe('skip')
  })

  it('loads metadata first when the duration is not known yet', () => {
    /*
     * The case that matters most, and the one a finite-duration test would have quietly excluded:
     * `preload="none"` is what a page puts on a below-fold video, and such an element reports
     * `NaN` for its duration until metadata arrives. Seeking is impossible until then.
     */
    expect(videoRescueStep({ ...below, duration: Number.NaN })).toBe('load-metadata')
  })

  it('still declines on the grounds that do not depend on metadata', () => {
    const unknown = { ...below, duration: Number.NaN }
    expect(videoRescueStep({ ...unknown, top: 400 })).toBe('skip')
    expect(videoRescueStep({ ...unknown, hasPoster: true })).toBe('skip')
    expect(videoRescueStep({ ...unknown, loop: true })).toBe('skip')
  })

  it('does not chase a live stream or an empty one', () => {
    // Infinity means metadata arrived and said there is no end to seek to.
    expect(videoRescueStep({ ...below, duration: Number.POSITIVE_INFINITY })).toBe('skip')
    expect(videoRescueStep({ ...below, duration: 0 })).toBe('skip')
  })

  it('seeks just past the start, never to zero and never to the end', () => {
    // Zero is not a seek -- the video is already there, so nothing decodes.
    expect(videoSeekTarget(120)).toBeCloseTo(0.1)
    expect(videoSeekTarget(0.04)).toBeCloseTo(0.02)
    expect(videoSeekTarget(120)).toBeGreaterThan(0)
  })
})
