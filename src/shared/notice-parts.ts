/**
 * One run of an explanation shown to the user.
 *
 * PageShotter's explanations carry three different kinds of thing: prose, a measured number, and the
 * name of a control the reader can go and change. A reader who has just been told their screenshot
 * is not what they asked for is scanning for the last two, and rendering all three identically makes
 * them read the whole sentence to find either. Splitting them here -- in data, in `shared/`, where
 * both the capture notices and the export warnings can build them and tests can assert them --
 * keeps the marking-up out of the DOM code that paints it.
 */
export type NoticePart =
  | { kind: 'text'; text: string }
  | { kind: 'value'; text: string }
  | { kind: 'setting'; text: string }

export const noticeText = (text: string): NoticePart => ({ kind: 'text', text })
export const noticeValue = (text: string): NoticePart => ({ kind: 'value', text })
export const noticeSetting = (text: string): NoticePart => ({ kind: 'setting', text })
export const noticeNumber = (n: number): NoticePart => noticeValue(n.toLocaleString())

/**
 * The same explanation as one string.
 *
 * Every message that has both forms derives the string from the parts rather than keeping the two in
 * step by hand, so a reworded sentence cannot come out different depending on where it is read.
 */
export function flattenParts(parts: readonly NoticePart[]): string {
  return parts.map((part) => part.text).join('')
}
