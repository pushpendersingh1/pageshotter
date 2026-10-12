import { getSetting, putSetting } from './capture-db'

/**
 * A floor under the per-section wait, in milliseconds.
 *
 * The wait a capture already performs is adaptive: it watches the page's height and its mutations
 * and moves on once both have been quiet for a moment. That is the right shape for almost every
 * page, and it is why the default here is zero.
 *
 * It has one blind spot, and no timeout can close it. An application shell that renders skeleton
 * placeholders at their *final* height is genuinely quiet -- nothing is moving, nothing is being
 * mutated -- so every quiet-detection scheme correctly concludes the page has settled, and captures
 * the skeleton. The wait did not run out; it succeeded, on a page that was not finished. The only
 * thing that helps is refusing to move on for a while regardless, which is what this is.
 *
 * It is off by default because it is paid on *every* section: a forty-section page at two seconds
 * costs eighty seconds more, whether or not any of those sections needed it.
 */
export const SECTION_WAIT_CHOICES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 0, label: 'None' },
  { ms: 500, label: '0.5 seconds' },
  { ms: 1_000, label: '1 second' },
  { ms: 1_500, label: '1.5 seconds' },
  { ms: 2_000, label: '2 seconds' },
  { ms: 3_000, label: '3 seconds' },
]

export const DEFAULT_SECTION_WAIT_MS = 0

/** The largest floor offered, and the ceiling any stored value is clamped to. */
export const MAX_SECTION_WAIT_MS = 3_000

/**
 * How much longer this section must be held, given how long its work has already taken.
 *
 * The floor covers the whole of a section's settling rather than being added to it: a section that
 * already spent 900ms waiting for images has met a 500ms floor, and making it wait 500ms *more*
 * would charge the slowest sections the most while leaving the quick ones -- the ones the floor
 * exists for -- exactly as quick as before.
 */
export function remainingSectionWaitMs(floorMs: number, elapsedMs: number): number {
  if (!Number.isFinite(floorMs) || floorMs <= 0) return 0
  const floor = Math.min(floorMs, MAX_SECTION_WAIT_MS)
  return Math.max(0, floor - Math.max(0, elapsedMs))
}

/** What a floor costs across a whole capture, for the settings note to state before it is chosen. */
export function sectionWaitCostMs(floorMs: number, sections: number): number {
  return Math.max(0, floorMs) * Math.max(0, sections)
}

const SECTION_WAIT_KEY = 'sectionWaitMs'

function isOfferedWait(value: unknown): value is number {
  return typeof value === 'number' && SECTION_WAIT_CHOICES.some((choice) => choice.ms === value)
}

export async function getSectionWaitMs(): Promise<number> {
  const stored = await getSetting<unknown>(SECTION_WAIT_KEY)
  return isOfferedWait(stored) ? stored : DEFAULT_SECTION_WAIT_MS
}

export async function setSectionWaitMs(ms: number): Promise<void> {
  await putSetting(SECTION_WAIT_KEY, isOfferedWait(ms) ? ms : DEFAULT_SECTION_WAIT_MS)
}

/**
 * How long one section may wait for its visible images to finish loading.
 *
 * This is a *ceiling*, not a delay: the wait ends the moment the images resolve, so on a page whose
 * images are already cached it costs nothing at all. That is why raising it is cheap and why the
 * default is not zero -- unlike the section floor above, which is paid whether or not it was needed.
 *
 * `Off` is offered because the wait is not free on every page: an image that never loads, or one
 * served so slowly it will not arrive, holds each section for the whole ceiling. Someone capturing
 * a page like that, who does not care about its images, is paying the ceiling per section for
 * nothing.
 *
 * 0.8 seconds is the value the capture has always used, so it stays the default: nobody's captures
 * change until they choose to change them.
 */
export const IMAGE_WAIT_CHOICES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 0, label: 'Off' },
  { ms: 800, label: 'Short, up to 0.8 s' },
  { ms: 3_000, label: 'Medium, up to 3 s' },
  { ms: 8_000, label: 'Full, up to 8 s' },
]

export const DEFAULT_IMAGE_WAIT_MS = 800

/** The largest ceiling offered, and what any stored value is clamped to. */
export const MAX_IMAGE_WAIT_MS = 8_000

const IMAGE_WAIT_KEY = 'imageWaitMs'

function isOfferedImageWait(value: unknown): value is number {
  return typeof value === 'number' && IMAGE_WAIT_CHOICES.some((choice) => choice.ms === value)
}

export async function getImageWaitMs(): Promise<number> {
  const stored = await getSetting<unknown>(IMAGE_WAIT_KEY)
  return isOfferedImageWait(stored) ? stored : DEFAULT_IMAGE_WAIT_MS
}

export async function setImageWaitMs(ms: number): Promise<void> {
  await putSetting(IMAGE_WAIT_KEY, isOfferedImageWait(ms) ? ms : DEFAULT_IMAGE_WAIT_MS)
}
