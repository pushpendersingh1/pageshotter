import { describe, expect, it } from 'vitest'
import {
  addDegradations,
  degradationParts,
  hasDegradations,
  type Degradations,
} from '../src/shared/capture-degradation'
import { flattenParts } from '../src/shared/notice-parts'

const say = (d: Degradations): string => flattenParts(degradationParts(d) ?? [])

describe('addDegradations', () => {
  it('sums a count reported across several sections', () => {
    let total: Degradations = {}
    for (const section of [{ 'hidden-text': 3 }, { 'hidden-text': 2 }, { 'video-frame': 1 }]) {
      total = addDegradations(total, section)
    }
    expect(total).toEqual({ 'hidden-text': 5, 'video-frame': 1 })
  })

  it('does not mutate the running total it was given', () => {
    const total: Degradations = { 'hidden-text': 1 }
    addDegradations(total, { 'hidden-text': 4 })
    expect(total).toEqual({ 'hidden-text': 1 })
  })

  it('ignores counts that are not real counts', () => {
    const total = addDegradations({}, {
      'hidden-text': 0,
      'video-frame': Number.NaN,
      'no-scroller': -2,
    } as Degradations)
    expect(hasDegradations(total)).toBe(false)
  })
})

describe('degradationParts', () => {
  it('says nothing when there is nothing to say', () => {
    // The common case by far, and the one that must stay silent: a notice shown on every capture
    // is a notice nobody reads on the capture that needed it.
    expect(degradationParts(undefined)).toBeNull()
    expect(degradationParts({})).toBeNull()
    expect(degradationParts({ 'hidden-text': 0 })).toBeNull()
  })

  it('does not claim the screenshot is incomplete, because it is not', () => {
    expect(say({ 'video-frame': 1 })).toContain('This screenshot is complete')
  })

  it('agrees with itself about singular and plural', () => {
    expect(say({ 'hidden-text': 1 })).toContain('1 piece of text was')
    expect(say({ 'hidden-text': 4 })).toContain('4 pieces of text were')
    expect(say({ 'video-frame': 1 })).toContain('1 video had')
    expect(say({ 'video-frame': 3 })).toContain('3 videos had')
  })

  it('never calls a screenshot complete when the wrong region was captured', () => {
    // The framing has to change, not just gain a clause: "complete, but ... everything else was
    // captured normally" is a sentence contradicting its own second half when the scroller was
    // never found and the picture is the wrong part of the page.
    const said = say({ 'no-scroller': 1 })
    expect(said).not.toContain('is complete')
    expect(said).not.toContain('captured normally')
    expect(said).toContain('captured the window instead')
  })

  it('still reports the other two alongside it, without reinstating the false claim', () => {
    const said = say({ 'hidden-text': 2, 'video-frame': 1, 'no-scroller': 1 })
    expect(said.indexOf('could not identify')).toBeLessThan(said.indexOf('pieces of text'))
    expect(said).toContain('Of what was captured')
    expect(said).not.toContain('is complete')
  })

  it('joins clauses into one sentence rather than listing them', () => {
    const said = say({ 'hidden-text': 2, 'video-frame': 1 })
    expect(said).toContain(', and ')
    expect(said.split('.').filter((s) => s.trim().length > 0)).toHaveLength(2)
  })

  it('marks the counts up as values, so they can be picked out of the sentence', () => {
    const parts = degradationParts({ 'hidden-text': 12 }) ?? []
    expect(parts.some((p) => p.kind === 'value' && p.text === (12).toLocaleString())).toBe(true)
  })
})

/**
 * A page that drives its own scroll -- smooth scrolling that will not turn off, a scroll hijacker
 * of the Lenis family, scrolljacking -- can be photographed at a position it moved to after the
 * capture put it somewhere else. The capture now re-asserts the offset every frame and waits for it
 * to hold still, but a page that never lets go is still possible, and it must say so rather than
 * hand over a picture whose sections are quietly the wrong part of the page.
 */
describe('a page that fights the scroll', () => {
  it('says which part of the picture cannot be trusted', () => {
    expect(say({ 'scroll-fought': 2 })).toBe(
      'This screenshot is complete, but 2 sections were photographed while the page was moving its ' +
        'own scroll, so they may show the wrong part of the page. Everything else on the page was ' +
        'captured normally.',
    )
  })

  it('reads as one sentence beside the others', () => {
    const sentence = say({ 'hidden-text': 1, 'scroll-fought': 1 })
    expect(sentence).toContain('1 piece of text was still being faded in')
    expect(sentence).toContain(
      'and 1 section was photographed while the page was moving its own scroll',
    )
  })

  it('counts across sections like every other degradation', () => {
    expect(addDegradations({ 'scroll-fought': 1 }, { 'scroll-fought': 2 })).toEqual({
      'scroll-fought': 3,
    })
  })
})
