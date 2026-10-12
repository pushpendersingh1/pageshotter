/**
 * Waiting for a scroll to actually land.
 *
 * `window.scrollTo(0, y)` is a request, not a fact. Three kinds of page answer it late or not at
 * all:
 *
 * - **CSS smooth scrolling** (`scroll-behavior: smooth`) animates the offset over ~300ms. The
 *   capture stylesheet forces `auto`, which handles the common case, but a page can reapply it and
 *   an element inside a shadow tree is out of that stylesheet's reach.
 * - **JavaScript scroll hijackers** (the Lenis/Locomotive/ScrollSmoother family) run their own
 *   easing in `requestAnimationFrame` and write the offset every frame from *their* target. A
 *   single `scrollTo` is overwritten on the very next frame, so the page eases back to where the
 *   reader had it.
 * - **Scroll snapping and scrolljacking**, which pull the offset to a point of their own choosing.
 *
 * Nothing in a height-based settle notices any of this: the document is not changing size while it
 * animates, so a wait that watches layout concludes -- correctly -- that the page is quiet, and the
 * screenshot is taken of wherever the animation had got to. A capture started from the bottom of
 * such a page therefore photographs the *bottom* as its first section, or the blank space a
 * scroll-reveal leaves above content that has not been revealed yet.
 *
 * So the offset is driven rather than requested: every frame, if the page is not where it was put,
 * it is put there again. A hijacker writes once per frame and so do we, and we write last because
 * the check runs after its frame callback; a transient animation simply finishes. Arrival is only
 * declared once the offset has held still for `stableFrames` consecutive frames, because landing on
 * the target for one frame in the middle of an ease is not arrival.
 *
 * The loop is pure: it takes its clock, its frames and its access to the scroller as parameters, so
 * the whole of it is testable in Node without a browser.
 */

/** How close counts as arrived. A fractional device-pixel offset is not a miss. */
export const ARRIVAL_TOLERANCE_PX = 1

/** Consecutive frames the offset must hold before the position is believed. */
export const ARRIVAL_STABLE_FRAMES = 2

/** The longest a single arrival may take. Past this the capture proceeds and reports honestly. */
export const ARRIVAL_TIMEOUT_MS = 1_200

export interface ScrollArrivalIO {
  /** The scroller's current offset. */
  read(): number
  /** Asserts the offset. */
  write(offset: number): void
  /** Resolves on the next animation frame. */
  frame(): Promise<void>
  /** Milliseconds, monotonic. */
  now(): number
}

export interface ScrollArrivalOptions {
  timeoutMs?: number
  stableFrames?: number
  tolerance?: number
  /**
   * Whether an offset counts as the requested position. Defaults to the tolerance comparison; the
   * capture passes one that also accepts a page clamped at its own bottom, which is a real arrival
   * at a target no page can reach.
   */
  settled?: (offset: number) => boolean
}

export interface ScrollArrival {
  /** Whether the offset was held for long enough to be believed. */
  arrived: boolean
  /** Where the scroller actually ended up. */
  offset: number
  /** Frames spent. Zero means it was already there. */
  frames: number
  /**
   * Whether the page moved the scroller away after we had put it in place. This is the signature of
   * a hijacker rather than a slow animation, and it is worth reporting separately: an arrival that
   * needed several frames of a fight is still an arrival, but one that never arrived *and* fought
   * is a page driving its own scroll, which no amount of further waiting will fix.
   */
  fought: boolean
}

/**
 * Puts the scroller at `target` and does not return until it is there and has stopped moving, or
 * the timeout is spent.
 */
export async function scrollToAndWait(
  io: ScrollArrivalIO,
  target: number,
  options: ScrollArrivalOptions = {},
): Promise<ScrollArrival> {
  const timeoutMs = options.timeoutMs ?? ARRIVAL_TIMEOUT_MS
  const stableFrames = Math.max(1, options.stableFrames ?? ARRIVAL_STABLE_FRAMES)
  const tolerance = options.tolerance ?? ARRIVAL_TOLERANCE_PX
  const settled = options.settled ?? ((offset: number) => Math.abs(offset - target) <= tolerance)

  const startedAt = io.now()
  io.write(target)

  let frames = 0
  let held = 0
  let fought = false
  let wasSettled = settled(io.read())

  // A page that is already exactly where it should be still owes us `stableFrames` of stillness:
  // the offset can read as correct in the middle of an ease that is about to carry it away.
  for (;;) {
    await io.frame()
    frames += 1
    const offset = io.read()
    const here = settled(offset)

    if (here) {
      held += 1
      if (held >= stableFrames) return { arrived: true, offset, frames, fought }
    } else {
      // Drift after we had it in place is the page writing the offset itself, not a slow start.
      if (wasSettled) fought = true
      held = 0
      io.write(target)
    }
    wasSettled = here

    if (io.now() - startedAt >= timeoutMs) {
      // The offset observed this frame, not a re-read after our own write: on a page that hauls the
      // scroller back every frame, re-reading would report the value we just asked for and hide the
      // very thing that failed.
      return { arrived: false, offset, frames, fought }
    }
  }
}
