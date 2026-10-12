import { describe, expect, it } from 'vitest'
import {
  EMOJI_GROUPS,
  RECENT_EMOJI_LIMIT,
  emojiEntry,
  readRecentEmoji,
  searchEmoji,
  withRecentEmoji,
} from '../src/editor/emoji'

const chars = (entries: { char: string }[]) => entries.map((entry) => entry.char)

describe('the curated set', () => {
  it('has the six groups, in order', () => {
    expect(EMOJI_GROUPS.map((group) => group.label)).toEqual(['Marks', 'Hands', 'Faces', 'Objects', 'Arrows', 'Status'])
  })

  it('never lists a glyph twice, so a button and its recent entry cannot disagree', () => {
    const all = EMOJI_GROUPS.flatMap((group) => chars([...group.emoji]))
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThanOrEqual(100)
  })

  it('names every entry, because the name is the button’s accessible label', () => {
    for (const entry of EMOJI_GROUPS.flatMap((group) => group.emoji)) expect(entry.name.trim()).not.toBe('')
  })
})

describe('searchEmoji', () => {
  it('matches synonyms, not just names', () => {
    expect(chars(searchEmoji('warn'))).toContain('⚠️')
    expect(chars(searchEmoji('tick'))).toContain('✅')
  })

  it('ignores case and surrounding space', () => {
    expect(chars(searchEmoji('  BUG '))).toContain('🐛')
  })

  it('matches nothing for an empty query or an unknown word', () => {
    expect(searchEmoji('')).toEqual([])
    expect(searchEmoji('   ')).toEqual([])
    expect(searchEmoji('zzzz')).toEqual([])
  })
})

describe('the recent row', () => {
  it('puts the newest first without repeating it', () => {
    expect(withRecentEmoji(['🔥', '✅'], '✅')).toEqual(['✅', '🔥'])
  })

  it('is bounded', () => {
    const many = chars(EMOJI_GROUPS[3]?.emoji.slice(0, RECENT_EMOJI_LIMIT) ?? [])
    const next = withRecentEmoji(many, '✅')
    expect(next).toHaveLength(RECENT_EMOJI_LIMIT)
    expect(next[0]).toBe('✅')
  })

  it('drops a stored value that is not a list of known glyphs', () => {
    expect(readRecentEmoji(undefined)).toEqual([])
    expect(readRecentEmoji('✅')).toEqual([])
    expect(readRecentEmoji(['✅', 7, 'not an emoji', '✅', '🔥'])).toEqual(['✅', '🔥'])
    expect(readRecentEmoji(Array(20).fill('✅'))).toEqual(['✅'])
  })

  it('looks up an entry by glyph', () => {
    expect(emojiEntry('🐛')?.name).toBe('bug')
    expect(emojiEntry('A')).toBeUndefined()
  })
})
