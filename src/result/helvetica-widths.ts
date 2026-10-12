/**
 * Helvetica's character widths, in 1/1000 em, from the standard AFM metrics.
 *
 * The text layer is invisible, so these are not used to draw anything — they are used to work out
 * how wide a string *would* be at a given size, which is the only way to compute the horizontal
 * scale that makes an invisible run span exactly the box the visible text occupied. Guessing that
 * width is what made selection stop a character short of the words on screen.
 */
const WIDTHS: Record<string, number> = {}

const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32-47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48-63
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64-79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 80-95
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 96-111
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 112-126
]
ASCII_WIDTHS.forEach((width, index) => {
  WIDTHS[String.fromCharCode(32 + index)] = width
})

/** Anything outside the table — accented Latin, mostly — is close enough to a lower-case letter. */
const FALLBACK_WIDTH = 556

/** How wide a string is in Helvetica at `fontSize`, in the same units as `fontSize`. */
export function helveticaWidth(text: string, fontSize: number): number {
  let thousandths = 0
  for (const character of text) thousandths += WIDTHS[character] ?? FALLBACK_WIDTH
  return (thousandths / 1000) * fontSize
}

/**
 * The horizontal scale, as a percentage, that makes `text` span `targetWidth`.
 *
 * Clamped rather than trusted: a run whose measured box disagrees wildly with its content — an
 * element with `letter-spacing: 40px`, a single character in a very wide box — would otherwise ask
 * for a scale that some readers refuse outright, taking the rest of the text layer down with it.
 */
export function horizontalScaleFor(text: string, fontSize: number, targetWidth: number): number {
  const natural = helveticaWidth(text, fontSize)
  if (natural <= 0 || targetWidth <= 0) return 100
  return Math.min(400, Math.max(10, (targetWidth / natural) * 100))
}
