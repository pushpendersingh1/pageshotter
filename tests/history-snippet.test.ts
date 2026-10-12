import { describe, expect, it } from 'vitest'
import { SNIPPET_BUDGET, snippetFor } from '../src/shared/history-snippet'

const words = (text: string): string[] => text.split(' ')

/** The rendered line, with the marked stretches wrapped, so assertions read like the row does. */
const render = (text: string, query: string, budget?: number): string => {
  const snippet = snippetFor(words(text), query, budget)
  if (!snippet) return ''
  const body = snippet.parts.map((part) => (part.match ? `[${part.text}]` : part.text)).join(' ')
  return `${snippet.clippedStart ? '…' : ''}${body}${snippet.clippedEnd ? '…' : ''}`
}

describe('snippetFor', () => {
  it('has nothing to say without a query', () => {
    expect(snippetFor(words('one two three'), '')).toBeUndefined()
    expect(snippetFor([], 'anything')).toBeUndefined()
  })

  it('is undefined when the words do not contain the query', () => {
    expect(snippetFor(words('the quick brown fox'), 'aardvark')).toBeUndefined()
  })

  it('marks the matching word', () => {
    expect(render('you can cancel whenever you like', 'cancel')).toBe('you can [cancel] whenever you like')
  })

  it('merges a marked phrase into one part', () => {
    const snippet = snippetFor(words('you can cancel anytime from settings'), 'cancel anytime')
    expect(snippet?.parts.filter((part) => part.match).map((part) => part.text)).toEqual(['cancel anytime'])
  })

  it('matches inside a word, the way the list filter does', () => {
    expect(render('retention improved this quarter', 'retent')).toBe('[retention] improved this quarter')
  })

  it('centres on the occurrence that holds the whole query', () => {
    // "cancel" appears first on its own; the phrase someone searched for is further along, and that
    // is the line worth showing.
    const text = 'cancel that thought and read on about billing before you decide to cancel anytime today'
    expect(render(text, 'cancel anytime')).toContain('[cancel anytime]')
  })

  it('keeps a few words of lead-in rather than starting at the match', () => {
    const snippet = snippetFor(words('a b c d e f g h needle i j'), 'needle')
    expect(snippet?.parts[0]?.text.startsWith('c')).toBe(true)
    expect(snippet?.clippedStart).toBe(true)
  })

  it('reports both ends when the page runs on either side', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`)
    long[100] = 'needle'
    // No full stops anywhere, so neither end can close cleanly.
    const snippet = snippetFor(long, 'needle')
    expect(snippet?.clippedStart).toBe(true)
    expect(snippet?.clippedEnd).toBe(true)
  })

  it('reports neither end when the whole page fits', () => {
    const snippet = snippetFor(words('short page with a needle'), 'needle')
    expect(snippet?.clippedStart).toBe(false)
    expect(snippet?.clippedEnd).toBe(false)
  })

  it('ends at the full stop the match sits behind', () => {
    const text = 'upgrade, downgrade, or cancel anytime. Then a whole other sentence carries on afterwards'
    // No trailing ellipsis: the quote ends on its own full stop, so nothing was cut.
    expect(render(text, 'cancel anytime')).toBe('upgrade, downgrade, or [cancel anytime.]')
  })

  it('opens at the start of the sentence the match is in', () => {
    const text = 'An earlier sentence ends here. Your trial stays flexible and you can cancel anytime.'
    expect(render(text, 'cancel')).toBe('Your trial stays flexible and you can [cancel] anytime.')
  })

  it('does not mistake an initial or an abbreviation for a full stop', () => {
    expect(render('written by J. Ortiz about needle threading', 'needle')).toContain('J. Ortiz about [needle]')
    expect(render('cats, dogs, etc. and then needle appears', 'needle')).toContain('etc. and then [needle]')
  })

  it('stays inside the budget', () => {
    const long = Array.from({ length: 400 }, () => 'filler')
    long[200] = 'needle'
    const snippet = snippetFor(long, 'needle')
    const length = snippet!.parts.map((part) => part.text).join(' ').length
    expect(length).toBeLessThanOrEqual(SNIPPET_BUDGET + 1)
  })

  it('shows the match even when one word overruns the budget on its own', () => {
    const huge = 'x'.repeat(SNIPPET_BUDGET + 40)
    const snippet = snippetFor([huge], huge)
    expect(snippet?.parts).toEqual([{ text: huge, match: true }])
  })
})
