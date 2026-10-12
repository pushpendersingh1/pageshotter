import { noticeNumber, noticeText, type NoticePart } from './notice-parts'

/**
 * What a capture could not do, when it finished anyway.
 *
 * Distinct from every flag beside it in `CaptureJob`. Those say why a capture **stopped** —
 * truncated, stopped early, endless, out of time. These say the capture ran to completion and the
 * picture is still not what the page looks like, which is the case a user has no way of telling
 * apart from "that is genuinely what the page looks like".
 *
 * Deliberately narrow. Only conditions that leave a **visibly wrong rectangle** are listed, because
 * a count nobody can act on is worse than silence — the result page's notice is already the busiest
 * thing on it, and every line added here is paid by every user who reads it. Things the capture does
 * on purpose and correctly — suppressing fixed chrome, leaving a postered video alone, declining to
 * revive absolutely-positioned text — are not degradations and are not reported.
 */
export type DegradationKind =
  /** Faint text that was left faint, so it photographed as a blank band. */
  | 'hidden-text'
  /** A video that never produced a frame, so it photographed as a black box. */
  | 'video-frame'
  /** The page's real scroller could not be identified, so the document was captured instead. */
  | 'no-scroller'
  /**
   * The page drove its own scroll position while a section was being taken -- smooth scrolling that
   * would not be turned off, a scroll hijacker, scrolljacking -- so the capture never got it to
   * hold still where it had put it.
   */
  | 'scroll-fought'

export type Degradations = Partial<Record<DegradationKind, number>>

/** Adds a section's counts to the running total. Sections are captured one at a time. */
export function addDegradations(total: Degradations, next: Degradations): Degradations {
  const merged: Degradations = { ...total }
  for (const [kind, count] of Object.entries(next) as [DegradationKind, number][]) {
    if (!Number.isFinite(count) || count <= 0) continue
    merged[kind] = (merged[kind] ?? 0) + count
  }
  return merged
}

export function hasDegradations(degradations: Degradations | undefined): boolean {
  if (!degradations) return false
  return Object.values(degradations).some((count) => (count ?? 0) > 0)
}

/**
 * The sentence, or `null` when there is nothing worth saying.
 *
 * One sentence, not a list: three separate lines about three rectangles would be a report, and a
 * reader wants to know whether to trust the picture, not to audit it. `no-scroller` leads when it is
 * present because it is the only one that can make the *whole* screenshot wrong rather than one part
 * of it.
 */
export function degradationParts(degradations: Degradations | undefined): NoticePart[] | null {
  if (!hasDegradations(degradations)) return null
  const counts = degradations as Degradations

  /*
   * `no-scroller` gets its own framing rather than a clause.
   *
   * The others qualify an otherwise complete screenshot, so they sit inside "this is complete,
   * but...". That opening is false here: if the scroller was never found, the picture is the wrong
   * region of the page, and following it with "everything else was captured normally" would be a
   * sentence contradicting itself in its own second half.
   */
  const missed = missedClauses(counts)
  if ((counts['no-scroller'] ?? 0) > 0) {
    const parts: NoticePart[] = [
      noticeText(
        'This page scrolls something inside itself that PageShotter could not identify, so it ' +
          'captured the window instead. Whatever that panel holds below its first screen is not in ' +
          'this picture.',
      ),
    ]
    if (missed.length > 0) {
      parts.push(noticeText(' Of what was captured, '))
      parts.push(...joinClauses(missed))
      parts.push(noticeText('.'))
    }
    return parts
  }

  const parts: NoticePart[] = [noticeText('This screenshot is complete, but ')]
  parts.push(...joinClauses(missed))
  parts.push(noticeText('. Everything else on the page was captured normally.'))
  return parts
}

/** The clauses for degradations that spoil part of an otherwise complete picture. */
function missedClauses(counts: Degradations): NoticePart[][] {
  const clauses: NoticePart[][] = []
  const text = counts['hidden-text'] ?? 0
  if (text > 0) {
    clauses.push([
      noticeNumber(text),
      noticeText(text === 1 ? ' piece of text was' : ' pieces of text were'),
      noticeText(' still being faded in and photographed blank'),
    ])
  }
  const video = counts['video-frame'] ?? 0
  if (video > 0) {
    clauses.push([
      noticeNumber(video),
      noticeText(video === 1 ? ' video had' : ' videos had'),
      noticeText(' not loaded a frame and photographed black'),
    ])
  }
  const fought = counts['scroll-fought'] ?? 0
  if (fought > 0) {
    clauses.push([
      noticeNumber(fought),
      noticeText(fought === 1 ? ' section was' : ' sections were'),
      noticeText(' photographed while the page was moving its own scroll, so they may show the wrong part of the page'),
    ])
  }
  return clauses
}

/** One sentence rather than a list: a reader wants to trust the picture, not audit it. */
function joinClauses(clauses: readonly NoticePart[][]): NoticePart[] {
  const parts: NoticePart[] = []
  clauses.forEach((clause, index) => {
    if (index > 0) parts.push(noticeText(index === clauses.length - 1 ? ', and ' : ', '))
    parts.push(...clause)
  })
  return parts
}
