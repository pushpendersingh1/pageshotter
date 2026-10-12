/*
 * The curated emoji set behind the Emoji tool.
 *
 * Ours rather than Emoji Mart: ~100 entries a screenshot annotator actually reaches for, each with a
 * name and synonyms so search finds `warn` → ⚠️ and `tick` → ✅. No skin tones and nothing outside the
 * list; a larger list is a data swap, because nothing below cares how many entries there are.
 *
 * Pure data and pure functions, so the search and the recent row are testable in plain Node.
 */

export interface EmojiEntry {
  char: string
  name: string
  keywords: readonly string[]
}

export interface EmojiGroup {
  label: string
  emoji: readonly EmojiEntry[]
}

const e = (char: string, name: string, ...keywords: string[]): EmojiEntry => ({ char, name, keywords })

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Marks',
    emoji: [
      e('✅', 'check mark button', 'tick', 'done', 'yes', 'ok', 'correct'),
      e('❌', 'cross mark', 'no', 'wrong', 'x', 'error'),
      e('⚠️', 'warning', 'warn', 'caution', 'alert'),
      e('❓', 'question mark', 'help', 'unknown'),
      e('❗', 'exclamation mark', 'important', 'alert'),
      e('✔️', 'check mark', 'tick', 'done'),
      e('✖️', 'multiply', 'x', 'close', 'wrong'),
      e('⛔', 'no entry', 'stop', 'forbidden', 'blocked'),
      e('🚫', 'prohibited', 'ban', 'not allowed'),
      e('ℹ️', 'information', 'info', 'note'),
      e('💯', 'hundred points', 'perfect', 'score'),
      e('‼️', 'double exclamation mark', 'urgent', 'important'),
    ],
  },
  {
    label: 'Hands',
    emoji: [
      e('👍', 'thumbs up', 'like', 'yes', 'approve', 'good'),
      e('👎', 'thumbs down', 'dislike', 'no', 'bad'),
      e('👉', 'pointing right', 'point', 'here', 'this'),
      e('👈', 'pointing left', 'point', 'here', 'this'),
      e('👆', 'pointing up', 'point', 'above'),
      e('👇', 'pointing down', 'point', 'below'),
      e('☝️', 'index pointing up', 'one', 'attention'),
      e('✋', 'raised hand', 'stop', 'wait'),
      e('👏', 'clapping hands', 'applause', 'bravo', 'well done'),
      e('🙌', 'raising hands', 'celebrate', 'hooray'),
      e('👌', 'ok hand', 'okay', 'perfect'),
      e('✌️', 'victory hand', 'peace', 'two'),
      e('🤞', 'crossed fingers', 'luck', 'hope'),
      e('🙏', 'folded hands', 'please', 'thanks'),
    ],
  },
  {
    label: 'Faces',
    emoji: [
      e('🙂', 'slightly smiling face', 'happy', 'smile'),
      e('🙁', 'slightly frowning face', 'sad', 'unhappy'),
      e('😀', 'grinning face', 'happy', 'smile'),
      e('😅', 'grinning face with sweat', 'phew', 'relief'),
      e('😂', 'face with tears of joy', 'laugh', 'lol', 'funny'),
      e('🤔', 'thinking face', 'hmm', 'consider', 'question'),
      e('😐', 'neutral face', 'meh', 'indifferent'),
      e('😮', 'face with open mouth', 'wow', 'surprise'),
      e('😡', 'enraged face', 'angry', 'mad'),
      e('😍', 'smiling face with heart-eyes', 'love', 'adore'),
      e('😎', 'smiling face with sunglasses', 'cool'),
      e('😬', 'grimacing face', 'awkward', 'oops'),
      e('😴', 'sleeping face', 'sleep', 'bored', 'tired'),
      e('🤯', 'exploding head', 'mind blown', 'shock'),
      e('😱', 'face screaming in fear', 'fear', 'shock', 'scared'),
      e('🙄', 'face with rolling eyes', 'annoyed', 'eye roll'),
      e('😢', 'crying face', 'sad', 'tear'),
      e('🥳', 'partying face', 'celebrate', 'party'),
      e('🤩', 'star-struck', 'amazing', 'wow'),
      e('😇', 'smiling face with halo', 'innocent', 'angel'),
    ],
  },
  {
    label: 'Objects',
    emoji: [
      e('🔥', 'fire', 'hot', 'trending', 'lit'),
      e('💡', 'light bulb', 'idea', 'tip'),
      e('⭐', 'star', 'favourite', 'favorite', 'rating'),
      e('🎯', 'direct hit', 'target', 'goal', 'aim', 'bullseye'),
      e('🐛', 'bug', 'issue', 'defect', 'error'),
      e('🔒', 'locked', 'lock', 'secure', 'private'),
      e('🔓', 'unlocked', 'open', 'unlock'),
      e('🔑', 'key', 'password', 'access'),
      e('📌', 'pushpin', 'pin', 'important'),
      e('📍', 'round pushpin', 'location', 'pin', 'place'),
      e('⏰', 'alarm clock', 'time', 'deadline', 'reminder'),
      e('⏳', 'hourglass', 'waiting', 'loading', 'time'),
      e('📈', 'chart increasing', 'growth', 'up', 'trend'),
      e('📉', 'chart decreasing', 'decline', 'down', 'trend'),
      e('📊', 'bar chart', 'stats', 'data', 'graph'),
      e('🚀', 'rocket', 'launch', 'ship', 'fast'),
      e('💰', 'money bag', 'money', 'cost', 'price'),
      e('💬', 'speech balloon', 'comment', 'chat', 'message'),
      e('📝', 'memo', 'note', 'write', 'edit'),
      e('📎', 'paperclip', 'attachment', 'attach'),
      e('🔗', 'link', 'url', 'chain'),
      e('🔍', 'magnifying glass', 'search', 'find', 'zoom'),
      e('⚙️', 'gear', 'settings', 'config'),
      e('🛠️', 'hammer and wrench', 'tools', 'fix', 'build'),
      e('📦', 'package', 'box', 'delivery', 'release'),
      e('📅', 'calendar', 'date', 'schedule'),
      e('📧', 'e-mail', 'email', 'mail'),
      e('📱', 'mobile phone', 'phone', 'mobile'),
      e('💻', 'laptop', 'computer', 'desktop'),
      e('🖱️', 'computer mouse', 'mouse', 'click'),
      e('🔔', 'bell', 'notification', 'alert'),
      e('🎉', 'party popper', 'celebrate', 'tada', 'congrats'),
      e('❤️', 'red heart', 'love', 'like'),
      e('🏆', 'trophy', 'win', 'award', 'best'),
    ],
  },
  {
    label: 'Arrows',
    emoji: [
      e('➡️', 'right arrow', 'right', 'next', 'direction'),
      e('⬅️', 'left arrow', 'left', 'previous', 'direction'),
      e('⬆️', 'up arrow', 'up', 'direction'),
      e('⬇️', 'down arrow', 'down', 'direction'),
      e('↗️', 'up-right arrow', 'up right', 'direction'),
      e('↘️', 'down-right arrow', 'down right', 'direction'),
      e('↙️', 'down-left arrow', 'down left', 'direction'),
      e('↖️', 'up-left arrow', 'up left', 'direction'),
      e('↔️', 'left-right arrow', 'horizontal', 'direction'),
      e('↕️', 'up-down arrow', 'vertical', 'direction'),
      e('🔄', 'counterclockwise arrows button', 'refresh', 'reload', 'sync', 'repeat'),
      e('↩️', 'right arrow curving left', 'back', 'undo', 'return'),
    ],
  },
  {
    label: 'Status',
    emoji: [
      e('🟢', 'green circle', 'ok', 'online', 'pass', 'go'),
      e('🟡', 'yellow circle', 'pending', 'warning', 'caution'),
      e('🔴', 'red circle', 'error', 'fail', 'stop', 'offline'),
      e('🔵', 'blue circle', 'info'),
      e('🟠', 'orange circle', 'warning', 'attention'),
      e('🟣', 'purple circle'),
      e('⚪', 'white circle', 'empty', 'neutral'),
      e('⚫', 'black circle', 'filled'),
      e('🟩', 'green square', 'done', 'pass'),
      e('🟥', 'red square', 'fail', 'blocked'),
    ],
  },
]

const ALL = EMOJI_GROUPS.flatMap((group) => group.emoji)
const KNOWN = new Map(ALL.map((entry) => [entry.char, entry]))

/** How many emoji the recent row keeps. */
export const RECENT_EMOJI_LIMIT = 8

/** The entry for a glyph in the set, or `undefined`. */
export function emojiEntry(char: string): EmojiEntry | undefined {
  return KNOWN.get(char)
}

/** Entries whose name or a synonym contains the query, in list order. An empty query matches nothing. */
export function searchEmoji(query: string): EmojiEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return ALL.filter((entry) => entry.name.includes(needle) || entry.keywords.some((keyword) => keyword.includes(needle)))
}

/** The recent row after placing `char`: newest first, no repeats, bounded. */
export function withRecentEmoji(recent: readonly string[], char: string): string[] {
  return [char, ...recent.filter((existing) => existing !== char)].slice(0, RECENT_EMOJI_LIMIT)
}

/**
 * A stored recent row, validated. Settings are read back from IndexedDB, so anything that is not a
 * list of glyphs from this set — an older list, a hand-edited value — is dropped rather than drawn.
 */
export function readRecentEmoji(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const kept: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && KNOWN.has(item) && !kept.includes(item)) kept.push(item)
  }
  return kept.slice(0, RECENT_EMOJI_LIMIT)
}
