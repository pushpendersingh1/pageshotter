/**
 * The sentence a search matched, pulled out of a capture's harvested words.
 *
 * History can be searched by what a page *said*, and until now the list answered that with a title
 * and an address -- the one thing it could not show was the words that matched. This builds that
 * line.
 *
 * It reads the harvested runs rather than `HistoryEntry.searchText`, which cannot help: that index
 * is deduplicated and lowercased, so it is a bag of words with no order and no sentences left in it.
 * The runs are the page's words in reading order, which is exactly what a snippet needs -- and they
 * are already stored, so this adds nothing to disk and changes no disclosure.
 *
 * Pure, so it can be tested in plain Node: the caller does the loading, this does the choosing.
 */

/** A stretch of the snippet, marked or not. Consecutive words of the same kind arrive merged. */
export interface SnippetPart {
  text: string
  match: boolean
}

export interface Snippet {
  parts: SnippetPart[]
  /** Whether words were dropped before or after the window, so the caller can show an ellipsis. */
  clippedStart: boolean
  clippedEnd: boolean
}

/** Roughly one line of a history row at the size it is set. Characters, not words. */
export const SNIPPET_BUDGET = 150

/** How far past the first hit to look for the rest of the terms before settling for what is there. */
const WINDOW_WORDS = 14

/** Words kept before the hit, so the match is not flush against the left edge. */
const LEAD_WORDS = 6

/**
 * How much further back than that a sentence start is worth reaching for. Opening on a full stop is
 * worth a few extra words; opening half a paragraph early to do it is not.
 */
const SENTENCE_LOOKBACK = 12

export function snippetFor(words: string[], query: string, budget = SNIPPET_BUDGET): Snippet | undefined {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0 || words.length === 0) return undefined

  const lower = words.map((word) => word.toLowerCase())
  const anchor = bestAnchor(lower, terms)
  if (anchor === undefined) return undefined

  const opening = openingWord(words, anchor)
  const start = opening.index
  let end = start
  let length = 0
  let cleanEnd = false
  while (end < words.length) {
    const next = length === 0 ? words[end]!.length : length + 1 + words[end]!.length
    // Always take the anchor itself, even if it alone overruns the budget: a snippet that stops
    // before the word someone searched for is worse than one that runs a little long.
    if (next > budget && end > anchor) break
    length = next
    end += 1
    // Stop at the end of the sentence the match is in, once the match is safely inside. A snippet
    // that runs on into the next paragraph reads as a machine's idea of a quote; one that ends on
    // its own full stop reads as something the page said.
    if (end > anchor && endsSentence(words[end - 1]!)) {
      cleanEnd = true
      break
    }
  }

  const parts: SnippetPart[] = []
  for (let index = start; index < end; index += 1) {
    const match = terms.some((term) => lower[index]!.includes(term))
    const last = parts[parts.length - 1]
    if (last && last.match === match) last.text += ` ${words[index]!}`
    else parts.push({ text: words[index]!, match })
  }

  // An ellipsis means "this was cut mid-sentence", at either end. A snippet that begins where its
  // sentence begins and ends on its own full stop is a whole quotation, and marking it as clipped
  // would both misdescribe it and render as four dots in a row.
  return {
    parts,
    clippedStart: start > 0 && !opening.clean,
    clippedEnd: end < words.length && !cleanEnd,
  }
}

/**
 * Where to centre the snippet: the first hit whose neighbourhood holds the most of the query.
 *
 * A two-word search usually appears together somewhere on the page and separately in a dozen other
 * places. Centring on the first stray occurrence of one word would show a line that does not look
 * like a match at all, so each candidate is scored by how many *distinct* terms fall within a
 * window of it, and the first best-scoring one wins.
 */
function bestAnchor(lower: string[], terms: string[]): number | undefined {
  let best: number | undefined
  let bestScore = 0
  for (let index = 0; index < lower.length; index += 1) {
    if (!terms.some((term) => lower[index]!.includes(term))) continue
    const seen = new Set<string>()
    for (let ahead = index; ahead < Math.min(lower.length, index + WINDOW_WORDS); ahead += 1) {
      for (const term of terms) if (lower[ahead]!.includes(term)) seen.add(term)
    }
    if (seen.size > bestScore) {
      bestScore = seen.size
      best = index
      if (bestScore === terms.length) break
    }
  }
  return best
}

/**
 * Where to open the window: the start of the sentence the match is in, if it began nearby.
 *
 * Starting mid-sentence is what makes a snippet look chopped. If a full stop falls between the
 * budgeted lead-in and the match, the word after it is a better opening than an arbitrary six words
 * back -- and often removes the need for a leading ellipsis at all.
 */
function openingWord(words: string[], anchor: number): { index: number; clean: boolean } {
  for (let index = anchor - 1; index >= Math.max(0, anchor - SENTENCE_LOOKBACK); index -= 1) {
    if (endsSentence(words[index]!)) return { index: index + 1, clean: true }
  }
  const earliest = Math.max(0, anchor - LEAD_WORDS)
  // The word before the window is the tell: if it ended a sentence, the window already opens on a
  // new one and nothing was cut.
  const before = words[earliest - 1]
  return { index: earliest, clean: earliest === 0 || (before !== undefined && endsSentence(before)) }
}

/**
 * Whether a word closes a sentence. An initial (`J.`) and a common abbreviation do not, which is
 * the whole of the cleverness here -- anything more is a sentence tokeniser, and a snippet that is
 * one word long is a worse failure than one that runs a few words past its full stop.
 */
function endsSentence(word: string): boolean {
  if (!/[.!?]["')\]]?$/.test(word)) return false
  const body = word.replace(/["')\]]?$/, '').slice(0, -1)
  if (body.length <= 1) return false
  return !ABBREVIATIONS.has(body.toLowerCase())
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'eg', 'ie', 'no', 'fig'])
