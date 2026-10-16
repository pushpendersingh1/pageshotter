import type { Degradations } from '../shared/capture-degradation'
import { remainingSectionWaitMs } from '../shared/capture-wait'
import { ContentHarvest, harvestShift } from '../shared/content-harvest'
import type { CaptureMetrics, ContentRequest, ContentResponse } from '../shared/messages'
import type { CapturedLink, CapturedTextRun, PageContent } from '../shared/page-content'
import {
  CLIP_HIDDEN_PX,
  MAX_CAPTURED_LINKS,
  MAX_CAPTURED_RUNS,
  MIN_CONTENT_PX,
  contentScrollOffset,
  cssClipSize,
  captureRectFor,
  imageOriginFor,
  intersectRect,
  toContentRects,
  wordSpans,
  type ClientRectLike,
  type ImageSpaceGeometry,
} from '../shared/page-content'
import {
  MAX_TEXT_REVEALS,
  isCoveredBySibling,
  isRevealCandidate,
  videoRescueStep,
  videoSeekTarget,
  type RescueBox,
} from '../shared/capture-rescue'
import type { RegionPoint, SelectedRegion, ViewportRect } from '../shared/region-geometry'
import { elementRectToRegion, regionFromDrag, regionScrollStep, sameRect } from '../shared/region-geometry'
import type { ScrollArrival } from '../shared/scroll-arrival'
import { scrollToAndWait } from '../shared/scroll-arrival'
import type { OverlayAnchor, ScrollGeometry } from '../shared/scroll-geometry'
import {
  classifyOverlay,
  containerCaptureGeometry,
  containerScrollTopFor,
  documentCaptureGeometry,
  overlapsCaptureRect,
  overlayHiddenInSegment,
  scrollSettleOutcome,
  SCROLL_REASSERT_ATTEMPTS,
} from '../shared/scroll-geometry'

/** Below this, in CSS pixels, an overlapping element cannot be visible chrome worth suppressing. */
const MIN_CHROME_PX = 8

/**
 * The total time incremental content harvesting may cost a capture, across every scroll position.
 *
 * Generous enough that a virtualised page -- a chat transcript, a feed -- is harvested at every one
 * of its positions, since such a page keeps only a screenful in the DOM and each pass is cheap.
 * Tight enough that a page with a very large static DOM cannot turn a fifty-segment capture into a
 * minute of walking it fifty times over, which would buy nothing: its text is all still there when
 * the final pass runs.
 */
const HARVEST_BUDGET_MS = 2_000

const SETTLE_TIMEOUT_MS = 1_200
/**
 * The default ceiling on a section's wait for its visible images.
 *
 * The user can raise it, lower it or turn it off in Settings; this is what a capture uses when the
 * preference has never been touched, and it is the value the capture has always used.
 */
const IMAGE_TIMEOUT_MS = 800
/*
 * How long a forced video seek may hold up the capture. A seek needs a network fetch and a decode,
 * so it is slower than an image; but a video that will not produce a frame in this long is one the
 * page was not going to show either, and the capture is worth more than the frame.
 */
const VIDEO_SEEK_TIMEOUT_MS = 1_200
/** The same budget for the metadata fetch that has to precede a seek on a `preload="none"` video. */
const VIDEO_METADATA_TIMEOUT_MS = 1_200
const SESSION_WATCHDOG_MS = 15_000
/**
 * Selection waits on a human, so this is far longer than the capture watchdog. It exists only so a
 * worker that dies mid-selection cannot leave the page permanently dimmed and un-clickable.
 */
const REGION_WATCHDOG_MS = 120_000
const LAZY_SOURCE_GRACE_MS = 650
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])
const MIN_CONTAINER_VIEWPORT_RATIO = 0.4
const MIN_CONTAINER_OVERFLOW_PX = 64
/**
 * No scrollbar is thicker than this. A page whose root element is deliberately smaller than the
 * viewport would otherwise look like an enormous gutter and crop real content away.
 */
const MAX_SCROLLBAR_PX = 32

interface SavedProperty {
  value: string
  priority: string
}

class MutationLedger {
  private readonly properties = new Map<HTMLElement, Map<string, SavedProperty>>()
  private readonly addedNodes: Node[] = []
  private readonly undos: (() => void)[] = []

  setProperty(element: HTMLElement, property: string, value: string, priority = ''): void {
    let elementProperties = this.properties.get(element)
    if (!elementProperties) {
      elementProperties = new Map()
      this.properties.set(element, elementProperties)
    }
    if (!elementProperties.has(property)) {
      elementProperties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })
    }
    element.style.setProperty(property, value, priority)
  }

  restoreProperty(element: HTMLElement, property: string): void {
    const saved = this.properties.get(element)?.get(property)
    if (!saved) return
    if (saved.value) element.style.setProperty(property, saved.value, saved.priority)
    else element.style.removeProperty(property)
    this.properties.get(element)?.delete(property)
  }

  addNode(node: Node): void {
    this.addedNodes.push(node)
  }

  /**
   * An undo for something that is not a style property or an added node -- a video's playhead,
   * so far. Registered rather than special-cased so `restore()` stays the single place a capture's
   * effects on the page are reversed.
   */
  addUndo(undo: () => void): void {
    this.undos.push(undo)
  }

  restore(): void {
    for (const undo of this.undos) {
      // One page's video refusing to seek back must not strand the rest of the restore.
      try {
        undo()
      } catch {
        // Nothing to do: the page is being handed back either way.
      }
    }
    for (const [element, properties] of this.properties) {
      for (const [property, saved] of properties) {
        if (saved.value) element.style.setProperty(property, saved.value, saved.priority)
        else element.style.removeProperty(property)
      }
    }
    for (const node of this.addedNodes) node.parentNode?.removeChild(node)
    this.properties.clear()
    this.addedNodes.length = 0
    this.undos.length = 0
  }
}

/**
 * The element PageShotter scrolls during capture. Most pages scroll the document, but app-shell
 * layouts (Gmail, ChatGPT and similar) pin the document and scroll an inner element instead, so the
 * session resolves the real scroller once and then drives it through this wrapper.
 */
class ScrollTarget {
  private constructor(
    readonly element: HTMLElement | null,
    /**
     * True only when the document does not scroll **and** no candidate cleared the bars in
     * `findScrollContainer`. The capture then drives a document that cannot move, so the screenshot
     * is the visible area of a page whose content never scrolled past.
     *
     * A `null` element is otherwise the ordinary case — it means the document scrolls — so the two
     * have to be told apart. They were not, and that is what made this failure silent: a page whose
     * real scroller is a 30%-wide panel produced a screenshot of the shell, indistinguishable from
     * a correct capture of a short page.
     */
    readonly searchFailed: boolean,
  ) {}

  static detect(): ScrollTarget {
    if (documentScrolls()) return new ScrollTarget(null, false)
    const container = findScrollContainer()
    return new ScrollTarget(container, container === null)
  }

  get isConnected(): boolean {
    return this.element === null || this.element.isConnected
  }

  geometry(): ScrollGeometry {
    return this.element ? containerGeometry(this.element) : documentGeometry()
  }

  /**
   * `behavior: 'instant'` rather than the two-argument form: the capture stylesheet forces
   * `scroll-behavior: auto`, but a page can reapply smooth scrolling and a scroller inside a shadow
   * tree is out of that stylesheet's reach. Asking explicitly costs nothing and cannot be
   * overridden by a stylesheet at all.
   */
  scrollTo(offset: number): void {
    const target = Math.max(0, offset)
    if (!this.element) {
      window.scrollTo({ top: target, left: 0, behavior: 'instant' })
      return
    }
    this.element.scrollTo({ top: containerScrollTopFor(target, this.geometry().clippedTop), behavior: 'instant' })
  }

  currentOffset(): number {
    return this.element ? this.element.scrollTop : window.scrollY
  }

  restore(offset: number): void {
    if (!this.element) {
      window.scrollTo(window.scrollX, offset)
      return
    }
    if (this.element.isConnected) this.element.scrollTop = offset
  }
}

function documentScrolls(): boolean {
  const root = document.scrollingElement ?? document.documentElement
  return getDocumentHeight() > root.clientHeight + 1
}

/**
 * Picks the largest scrollable descendant that plausibly holds the page's main content. Selectors
 * are never hardcoded: candidates must overflow meaningfully, occupy a real share of the viewport,
 * and actually be on screen.
 */
function findScrollContainer(): HTMLElement | null {
  const minWidth = window.innerWidth * MIN_CONTAINER_VIEWPORT_RATIO
  const minHeight = window.innerHeight * MIN_CONTAINER_VIEWPORT_RATIO
  let best: HTMLElement | null = null
  let bestOverflow = MIN_CONTAINER_OVERFLOW_PX

  for (const node of document.querySelectorAll<HTMLElement>('body *')) {
    const overflow = node.scrollHeight - node.clientHeight
    if (overflow <= bestOverflow) continue
    if (node.clientHeight < minHeight || node.clientWidth < minWidth) continue
    if (!SCROLLABLE_OVERFLOW.has(window.getComputedStyle(node).overflowY)) continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue
    if (rect.right <= 0 || rect.left >= window.innerWidth) continue
    best = node
    bestOverflow = overflow
  }

  return best
}

function documentGeometry(): ScrollGeometry {
  const root = document.scrollingElement ?? document.documentElement
  return documentCaptureGeometry(
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    getDocumentWidth(),
    getDocumentHeight(),
    scrollbarExtent(window.innerWidth - root.clientWidth),
    scrollbarExtent(window.innerHeight - root.clientHeight),
  )
}

/** Clamps a measured viewport/root difference to a plausible scrollbar thickness. */
function scrollbarExtent(difference: number): number {
  if (!Number.isFinite(difference) || difference <= 0) return 0
  return Math.min(difference, MAX_SCROLLBAR_PX)
}

function containerGeometry(element: HTMLElement): ScrollGeometry {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return containerCaptureGeometry({
    paddingLeft: rect.left + (Number.parseFloat(style.borderLeftWidth) || 0),
    paddingTop: rect.top + (Number.parseFloat(style.borderTopWidth) || 0),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  })
}

interface Overlay {
  element: HTMLElement
  anchor: OverlayAnchor
}

class CaptureSession {
  constructor(private readonly jobId: string) {}

  private readonly originalScrollX = window.scrollX
  private readonly originalScrollY = window.scrollY
  private target = ScrollTarget.detect()
  private originalTargetOffset = this.target.currentOffset()
  private readonly ledger = new MutationLedger()
  private readonly overlays = new Map<number, Overlay>()
  private readonly overlayIds = new WeakMap<HTMLElement, number>()
  private readonly inspectedBackgrounds = new WeakSet<HTMLElement>()
  private readonly inspectedForReveal = new WeakSet<HTMLElement>()
  private revealedCount = 0
  /**
   * What this capture could not do, accumulated across sections and handed back when it ends.
   *
   * Counted where it happens rather than inferred afterwards: only the page knows that a video has
   * no frame or that a paragraph is still faint, and by the time the screenshot exists both look
   * exactly like a page that is genuinely blank there.
   */
  private degradations: Degradations = {}

  /**
   * What has gone wrong so far, as counted *since the last report*.
   *
   * Drained rather than read, because the worker adds each response to a running total: a page that
   * reveals text on twenty sections would otherwise report one, three, six, ten... and the worker
   * would sum the sums.
   */
  reportDegradations(): Degradations | undefined {
    const drained = this.degradations
    this.degradations = {}
    return Object.keys(drained).length > 0 ? drained : undefined
  }
  private nextOverlayId = 1
  private multiSegment = false
  /** The user's floor under each section's wait, in milliseconds. Zero unless they raised it. */
  private sectionWaitMs = 0
  private imageWaitMs = IMAGE_TIMEOUT_MS
  private watchdog: number | undefined
  private readonly harvest = new ContentHarvest()
  /**
   * The image space every harvested rect is stored in: the capture origin of the first pass. Later
   * passes are shifted onto it, and it is what the worker is told to subtract.
   */
  private harvestOrigin: { x: number; y: number } | undefined
  /** How long harvesting has cost so far, against `HARVEST_BUDGET_MS`. */
  private harvestSpentMs = 0
  /** Sent once: a second Escape while the worker is stitching must not cancel the delivery. */
  private stopping = false

  /**
   * Escape stops the capture and keeps what has already been photographed.
   *
   * The popup's Stop button used to be the only way to do this, which meant a capture started by
   * the keyboard shortcut could not be stopped at all -- the popup is not open, so there is no
   * button, and the page is scrolling itself under a picture the user has already decided against.
   *
   * Heard on the page rather than in the worker because that is where the keystroke lands. It is
   * taken in the capture phase and not passed on: while PageShotter is driving the page, Escape
   * belongs to PageShotter, and letting the page also act on it would mutate the document halfway
   * through the capture it is being read from.
   */
  private readonly onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.stopping) return
    this.stopping = true
    event.preventDefault()
    event.stopPropagation()
    // Fire and forget: the worker stitches whatever segments it has and opens the result. Nothing
    // here waits on that, because this listener is torn down by the cleanup it causes.
    void chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE', jobId: this.jobId }).catch(() => undefined)
  }

  async prepare(sectionWaitMs = 0, imageWaitMs = IMAGE_TIMEOUT_MS): Promise<CaptureMetrics> {
    this.sectionWaitMs = sectionWaitMs
    this.imageWaitMs = imageWaitMs
    this.armWatchdog()
    window.addEventListener('keydown', this.onEscape, true)
    this.installCaptureStyles()
    await this.arriveAt(0)
    await this.settle()
    // Layout settling can reveal the real scroller on app shells that mount content late.
    if (this.target.element === null && !documentScrolls()) {
      this.target = ScrollTarget.detect()
      this.originalTargetOffset = this.target.currentOffset()
      await this.arriveAt(0)
      await this.settle()
    }
    this.refreshSegmentCount()
    this.unfadeCaptureEdges()
    this.revealFadedText()
    this.unpinBackgrounds()
    this.findOverlays()
    this.applyOverlayPolicy(new Set(), this.target.geometry().offset)
    // Seeking is asynchronous. Only a page that actually has an unloaded video waits for it.
    await this.seekOffscreenVideos()
    // Recorded after the second detect above, so an app shell that mounts its scroller late is not
    // accused of having none.
    if (this.target.searchFailed) this.degradations['no-scroller'] = 1
    return this.metrics([])
  }

  /**
   * The geometry the image was assembled against, for anything that has to land on the picture.
   *
   * Page content is harvested *after* the capture, while this session is still alive, so the text
   * layer can be measured in the same space the segments were -- which for a nested scroller is the
   * container's scroll space and not the window's.
   */
  captureGeometry(): ScrollGeometry {
    return this.target.geometry()
  }

  /**
   * The element being scrolled, or `null` when the document itself is. Content harvesting needs it
   * to answer two questions the geometry alone cannot: what does not clip the picture, and what is
   * chrome painted over it.
   */
  scrollTarget(): HTMLElement | null {
    return this.target.element
  }

  /**
   * Everything harvested during the capture, plus one final pass at the position the page was left
   * in.
   *
   * The final pass is what the whole text layer used to be, and it is still the one that catches
   * content a page only mounts once it has been scrolled past. It runs whatever the budget says,
   * because skipping it could leave a page with no text layer at all.
   */
  collectedContent(): PageContent {
    this.harvestPass(true)
    return this.harvest.result()
  }

  /** The image origin the worker must subtract from the harvested rects. */
  harvestOriginFor(geometry: ScrollGeometry): { x: number; y: number } {
    return this.harvestOrigin ?? imageOriginFor(geometry)
  }

  /**
   * Measures the page as it stands and merges it into the accumulated content.
   *
   * Bounded by a total time budget rather than a pass count: the cost is the DOM walk, which is
   * small on the virtualised pages this exists for -- they keep only a screenful mounted -- and
   * large on a page with tens of thousands of nodes, where the passes are also near-identical and
   * therefore worth the least. Running out of budget costs a long static page nothing, because its
   * text is still there for the final pass to find.
   *
   * Best-effort throughout: a page that cannot be measured still gets its screenshot.
   */
  private harvestPass(final: boolean): void {
    if (!final && this.harvestSpentMs >= HARVEST_BUDGET_MS) return
    const started = performance.now()
    try {
      const geometry = this.target.geometry()
      const origin = imageOriginFor(geometry)
      this.harvestOrigin ??= origin
      this.harvest.absorb(
        collectPageContent(geometry, this.target.element),
        harvestShift(this.harvestOrigin, origin),
      )
    } catch {
      // A pass that throws is a pass that contributes nothing; the capture is unaffected.
    }
    this.harvestSpentMs += performance.now() - started
  }

  async position(
    scrollY: number,
    seenOverlayIds: number[],
    depthLimit?: number,
  ): Promise<CaptureMetrics> {
    const startedAt = Date.now()
    this.armWatchdog()
    if (!this.target.isConnected) {
      throw new Error('The scrollable area disappeared while PageShotter was capturing this page.')
    }
    this.refreshSegmentCount()
    // Re-run every step, like the background and overlay passes: an app shell can mount its real
    // scroller, and its fade, after the first segment has already been taken.
    this.unfadeCaptureEdges()
    this.revealFadedText()
    this.unpinBackgrounds()
    this.findOverlays()
    this.applyOverlayPolicy(new Set(seenOverlayIds), this.target.geometry().offset)

    /*
     * Scrolling once and settling was not enough, and the gap between the two is wide: settling
     * waits for layout to stabilise, then up to LAZY_SOURCE_GRACE_MS for lazy sources, then for
     * images. A person who nudges the wheel anywhere in that window moved the scroller after we
     * positioned it, and the measurement below then reported *their* offset as the segment's.
     *
     * Scrolling forward made the worker see a jump past what it had covered and abort the whole
     * capture as a scroll gap -- a page-hostile diagnosis for something a person did, and the one
     * behaviour a screenshot tool cannot afford, since the reflex when a capture looks stuck is to
     * scroll. Scrolling backward was worse because it was silent: the next target was computed from
     * the wrong offset, so the segment was simply wrong.
     *
     * So the position is re-asserted rather than assumed. A person is transient and the second
     * attempt lands; a page that fights -- scroll snapping, scrolljacking -- lands somewhere else
     * every time, which is exactly the case the worker's SCROLL_GAP error was written for and still
     * reports after the attempts are spent.
     */
    let settled = this.target.geometry()
    for (let attempt = 0; attempt < SCROLL_REASSERT_ATTEMPTS; attempt += 1) {
      await this.arriveAt(scrollY)
      await this.settle()
      settled = this.target.geometry()
      const outcome = scrollSettleOutcome(
        scrollY,
        settled.offset,
        settled.contentHeight,
        settled.captureHeight,
      )
      if (outcome === 'settled') break
    }
    /*
     * The grace belongs to the *last section this capture will take*, which is not always the last
     * section of the document. A capture held to the long-page allowance stops above the document
     * floor, and testing only against `contentHeight` gave that final section no wait at all -- so
     * the images entering the viewport on the way past it were photographed mid-load, as blank
     * thumbnails, on exactly the feeds the allowance exists for.
     */
    const floor = Math.min(settled.contentHeight, depthLimit ?? Number.POSITIVE_INFINITY)
    if (settled.offset + settled.captureHeight >= floor - 1) {
      await new Promise((resolve) => setTimeout(resolve, LAZY_SOURCE_GRACE_MS))
      await this.settle()
      // The tail settle can load content that moves the floor again, so hold the position across it
      // too rather than leaving the last word to whatever the page did.
      await this.arriveAt(scrollY)
    }
    await this.holdForSectionFloor(startedAt)
    this.findOverlays()
    this.applyOverlayPolicy(new Set(seenOverlayIds), this.target.geometry().offset)
    // After the overlay policy, so what is hidden from the picture is hidden from the text layer
    // too, and before the screenshot the worker takes next: this only measures, so it cannot alter
    // what is photographed.
    this.harvestPass(false)
    return this.metrics(seenOverlayIds)
  }

  heartbeat(): void {
    this.armWatchdog()
  }

  cleanup(): void {
    window.removeEventListener('keydown', this.onEscape, true)
    if (this.watchdog !== undefined) window.clearTimeout(this.watchdog)
    this.ledger.restore()
    this.target.restore(this.originalTargetOffset)
    window.scrollTo(this.originalScrollX, this.originalScrollY)
  }

  private installCaptureStyles(): void {
    const style = document.createElement('style')
    style.dataset.pageshotter = 'capture-stability'
    style.textContent = `
      html { scroll-behavior: auto !important; }
      /*
       * Scrollbars are painted inside the captured viewport, so without this the thumb is stamped
       * into every segment — and because it moves as we scroll, it streaks down the stitched image.
       * Overlay scrollbars (the macOS default) take no layout space, so hiding them cannot reflow.
       * Classic scrollbars do, which is why this is installed once in prepare(), before any
       * measurement, rather than between segments.
       */
      * { scrollbar-width: none !important; }
      *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      *, *::before, *::after {
        animation-play-state: paused !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        scroll-snap-align: none !important;
        scroll-snap-stop: normal !important;
        scroll-snap-type: none !important;
      }
    `
    ;(document.head ?? document.documentElement).append(style)
    this.ledger.addNode(style)
  }

  /**
   * A capture that fits in one segment is left exactly as the user sees it: nothing is repeated, so
   * nothing is suppressed. Once a capture is known to span segments it stays that way, even if the
   * page later shrinks.
   */
  private refreshSegmentCount(): void {
    if (this.multiSegment) return
    const geometry = this.target.geometry()
    this.multiSegment = geometry.contentHeight > geometry.captureHeight + 1
  }

  /**
   * `background-attachment: fixed` pins a background to the viewport rather than to the content, so
   * every segment photographs the same band of it and the stitched image repeats that band down the
   * page instead of showing one continuous background. Switching the pinned layers to `scroll` makes
   * the background travel with the content, which is what a full-page screenshot should show.
   *
   * Like the overlay policy, this only applies once a capture is known to span segments: a
   * single-segment capture is left exactly as the user sees it, because nothing is being repeated.
   * `background-attachment` never affects layout, so changing it cannot reflow the page mid-capture.
   */
  private unpinBackgrounds(): void {
    if (!this.multiSegment) return
    // `body *` misses the two elements that carry a page background most often, so both roots are
    // inspected explicitly.
    this.unpinBackground(document.documentElement)
    if (document.body) this.unpinBackground(document.body)
    for (const node of document.querySelectorAll<HTMLElement>('body *')) this.unpinBackground(node)
  }

  private unpinBackground(element: HTMLElement): void {
    // Classified once on discovery and never reconsidered, matching how overlays are handled.
    if (this.inspectedBackgrounds.has(element)) return
    this.inspectedBackgrounds.add(element)

    const attachment = window.getComputedStyle(element).backgroundAttachment
    if (!attachment.includes('fixed')) return
    // A layered background lists one attachment per image, so each layer is mapped on its own
    // rather than collapsing a mixed list down to a single value.
    const unpinned = attachment
      .split(',')
      .map((layer) => (layer.trim() === 'fixed' ? 'scroll' : layer.trim()))
      .join(', ')
    this.ledger.setProperty(element, 'background-attachment', unpinned, 'important')
  }

  /**
   * Finds elements that stay put while the page scrolls, and would therefore be stamped into every
   * segment. Sticky elements are un-stuck so they flow with the content and appear exactly once;
   * fixed elements are classified so `applyOverlayPolicy` can decide where — or whether — to show
   * them. Elements are classified once, on discovery, and never reconsidered.
   */
  private findOverlays(): void {
    const geometry = this.target.geometry()
    for (const node of document.querySelectorAll<HTMLElement>('body *')) {
      if (this.overlayIds.has(node)) continue
      const position = window.getComputedStyle(node).position
      if (position !== 'fixed' && position !== 'sticky' && position !== 'absolute') continue
      // An absolutely positioned element usually scrolls with whatever contains it, so it is chrome
      // only in one specific case -- see `isChromeOverCapture`.
      if (position === 'absolute' && !this.isChromeOverCapture(node, geometry)) continue
      // Nothing is classified until the capture is known to span segments, so a page that only
      // grows past one viewport later still gets its overlays handled.
      if (!this.multiSegment) continue

      const id = this.nextOverlayId
      this.nextOverlayId += 1
      this.overlayIds.set(node, id)

      if (position === 'sticky') {
        this.unstick(node)
        continue
      }

      const anchor = classifyOverlay(node.getBoundingClientRect(), geometry)
      if (anchor !== 'shell') this.overlays.set(id, { element: node, anchor })
    }
  }

  /**
   * Whether an absolutely positioned element is chrome painted over the capture, rather than content.
   *
   * Only ever true when a nested container is being scrolled, and that is what makes it safe: the
   * screenshot is of *that container's* content, so an element which is neither inside it nor an
   * ancestor of it, yet overlaps it on screen, is by construction something drawn on top -- it
   * cannot be part of what is being photographed. Its containing block is elsewhere, so it does not
   * move when the container scrolls, and it is therefore stamped into every segment.
   *
   * A real case: an app shell had a header backdrop -- an opaque fill masked to
   * fade out over its bottom 24px, `position: absolute`, pinned to the top of the viewport and
   * reaching just past the header into the scroll area. Not fixed, not sticky, so overlay discovery
   * never looked at it, and every segment came back with its first rows washed toward white. Stitched
   * together, that is a pale band at every seam.
   *
   * A document capture is deliberately excluded. There the capture rect *is* the viewport, every
   * absolutely positioned element on the page overlaps it, and there is no containment test left to
   * separate chrome from content -- the rule would have no edge and would start deleting real
   * content, which is the one failure this project must not repeat.
   */
  private isChromeOverCapture(node: HTMLElement, geometry: ScrollGeometry): boolean {
    const scroller = this.target.element
    if (!scroller) return false
    if (scroller.contains(node) || node.contains(scroller)) return false
    const rect = node.getBoundingClientRect()
    // Too small to be washing a band across the screenshot. This is aimed at the 1x1 clip rects
    // screen-reader-only text uses, which are absolutely positioned, technically overlap everything,
    // and are invisible either way -- there is nothing to gain by touching them.
    if (rect.width < MIN_CHROME_PX || rect.height < MIN_CHROME_PX) return false
    return overlapsCaptureRect(rect, geometry)
  }

  /**
   * Removes an edge fade from the element being scrolled, and from its ancestors.
   *
   * A `mask-image` on a scroll container fades the *container's* top and bottom edges, not the
   * content's -- so it is anchored to the capture rect exactly the way a fixed header is. Every
   * segment then comes out with its first and last rows washed out, and stitching them produces a
   * pale, blurred-looking band at every seam, running the whole width of the screenshot. It is a
   * common app-shell pattern: text is meant to fade as it scrolls under a header or behind a
   * composer.
   *
   * Deliberately limited to the scrolled element and its ancestors. A mask on an ordinary content
   * element travels with the content, appears once, and is part of what the page looks like -- and
   * removing those would change the screenshot rather than repair it.
   *
   * Both spellings are set: Chrome supports unprefixed `mask-image`, but a page may only have
   * declared `-webkit-mask-image`, and leaving that one standing leaves the fade standing.
   */
  private unfadeCaptureEdges(): void {
    const start: HTMLElement | null = this.target.element ?? document.body
    for (let node: HTMLElement | null = start; node; node = node.parentElement) {
      const style = window.getComputedStyle(node)
      // `mask-image` is the computed longhand for every mask shorthand, so one read covers both.
      if (style.maskImage === 'none' && style.webkitMaskImage === 'none') continue
      this.ledger.setProperty(node, 'mask-image', 'none', 'important')
      this.ledger.setProperty(node, '-webkit-mask-image', 'none', 'important')
    }
  }

  /**
   * Puts back text a scroll-reveal animation left at `opacity: 0`.
   *
   * A capture scrolls the page faster than any reveal animation completes, and on the pages that
   * drive those animations from an IntersectionObserver it is worse than that: moving the scroller
   * programmatically may never fire the observer at all, so an entire section is photographed as a
   * blank band. This is the most common way a modern page photographs wrongly.
   *
   * Runs on every segment because a virtualised page mounts new nodes as it scrolls, but inspects
   * each element only once -- the walk is the cost, and an element already judged does not change
   * its mind. `MAX_TEXT_REVEALS` bounds the blast radius on a page that uses opacity as a layout
   * system rather than as an animation.
   *
   * The rules themselves are in `capture-rescue.ts`, where they can be tested.
   */
  private revealFadedText(): void {
    if (this.revealedCount >= MAX_TEXT_REVEALS) return
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      // Reaching the cap does not end the walk quietly any more: everything past it is faint text
      // this capture is choosing not to revive, and the reader is the one looking at the result.
      if (this.revealedCount >= MAX_TEXT_REVEALS) {
        this.degradations['hidden-text'] = (this.degradations['hidden-text'] ?? 0) + 1
        return
      }
      if (this.inspectedForReveal.has(element)) continue
      this.inspectedForReveal.add(element)
      // An element this session hid on purpose must never be revived by this one.
      if (this.overlayIds.has(element)) continue

      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const candidate = {
        opacity: Number.parseFloat(style.opacity),
        visibility: style.visibility,
        display: style.display,
        position: style.position,
        width: rect.width,
        height: rect.height,
        hasText: (element.textContent ?? '').trim().length > 0,
      }
      if (!isRevealCandidate(candidate)) continue
      if (isCoveredBySibling(rect, this.visibleSiblingBoxes(element))) {
        // Held back on purpose, but the consequence for the picture is the same as the cap's: this
        // text is faint text that stayed faint, and it is about to be photographed as a blank band.
        this.degradations['hidden-text'] = (this.degradations['hidden-text'] ?? 0) + 1
        continue
      }

      this.ledger.setProperty(element, 'opacity', '1', 'important')
      this.revealedCount += 1
    }
  }

  /**
   * The boxes of an element's siblings that are themselves visible, for the covered-by-a-sibling
   * test. Anything faint, hidden or unlaid-out is excluded: it cannot be the visible replacement
   * whose presence is the reason to leave this element alone.
   */
  private visibleSiblingBoxes(element: HTMLElement): RescueBox[] {
    const parent = element.parentElement
    if (!parent) return []
    const boxes: RescueBox[] = []
    for (const sibling of parent.children) {
      if (sibling === element) continue
      const style = window.getComputedStyle(sibling)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (Number.parseFloat(style.opacity) < 0.9) continue
      boxes.push(sibling.getBoundingClientRect())
    }
    return boxes
  }

  /**
   * Forces a frame into every <video> below the fold that has none.
   *
   * Such a video has usually loaded nothing at all, and photographs as an empty black box where the
   * page would have shown something. Assigning a non-zero `currentTime` makes the browser fetch and
   * decode; `videoSeekTarget` picks a point just past the start, because the frame the page would
   * have shown is the first one.
   *
   * The playhead is put back afterwards. A capture must leave the page as it found it, and a video
   * silently moved off its start is exactly the kind of residue that turns a screenshot tool into
   * something a user stops trusting.
   */
  private async seekOffscreenVideos(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const video of document.querySelectorAll('video')) {
      pending.push(this.rescueVideo(video))
    }
    // A page with no such video pays nothing; one with several waits for them together.
    await Promise.all(pending)
  }

  private async rescueVideo(video: HTMLVideoElement): Promise<void> {
    const candidate = (): Parameters<typeof videoRescueStep>[0] => ({
      top: video.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
      loop: video.loop,
      duration: video.duration,
      hasPoster: video.poster.trim().length > 0,
      readyState: video.readyState,
    })

    let step = videoRescueStep(candidate())
    if (step === 'skip') return

    if (step === 'load-metadata') {
      /*
       * `preload="none"` is what a page puts on a video below the fold, so this is the ordinary
       * case rather than the exotic one. Nothing about the element is known yet -- not even how
       * long it is -- so metadata has to arrive before there is anything to seek to.
       */
      const originalPreload = video.preload
      this.ledger.addUndo(() => {
        video.preload = originalPreload
      })
      video.preload = 'metadata'
      try {
        video.load()
      } catch {
        this.noteBlackVideo()
        return
      }
      await waitForMediaEvent(video, 'loadedmetadata', VIDEO_METADATA_TIMEOUT_MS)
      step = videoRescueStep(candidate())
      /*
       * Metadata never arrived -- a dead source, or one slower than the budget. Either way this
       * video is about to be photographed as a black box, and returning quietly here is exactly the
       * silence this whole mechanism exists to end. Found by running the fixture's videos through
       * the real predicates: both sit at `readyState: 0` with `duration: NaN`, so they leave through
       * this branch and not through the seek below.
       */
      if (step !== 'seek') {
        if (video.readyState < 2) this.noteBlackVideo()
        return
      }
    }

    const original = video.currentTime
    this.ledger.addUndo(() => {
      video.currentTime = original
    })
    try {
      video.currentTime = videoSeekTarget(video.duration)
    } catch {
      // A source that refuses to seek is simply photographed as it is -- as a black box.
      this.noteBlackVideo()
      return
    }
    await waitForMediaEvent(video, 'seeked', VIDEO_SEEK_TIMEOUT_MS)
    /*
     * `waitForMediaEvent` resolves on the event, on an error, and on the timeout alike, so it cannot
     * say which happened. `readyState` can: below `HAVE_CURRENT_DATA` there is no frame to paint, so
     * this video is about to be photographed black whatever the reason was.
     */
    if (video.readyState < 2) this.noteBlackVideo()
  }

  private noteBlackVideo(): void {
    this.degradations['video-frame'] = (this.degradations['video-frame'] ?? 0) + 1
  }

  /**
   * Removes a sticky element's vertical stick offsets so it renders at its natural place in the
   * content. Horizontal offsets are left alone because capture only scrolls vertically.
   */
  private unstick(element: HTMLElement): void {
    this.ledger.setProperty(element, 'top', 'auto', 'important')
    this.ledger.setProperty(element, 'bottom', 'auto', 'important')
  }

  /**
   * Applies the overlay policy for the segment about to be photographed.
   *
   * `offset` is the content offset at the top of that segment, and decides where a top-anchored
   * overlay may appear: only in the segment that begins the capture. A header Google promotes to
   * fixed on first scroll is discovered at segment two, but its static original is already in
   * segment one's picture, so it is hidden here rather than stamped a second time under the seam.
   */
  private applyOverlayPolicy(seenOverlayIds: Set<number>, offset: number): void {
    for (const [id, overlay] of this.overlays) {
      if (!overlay.element.isConnected) continue
      const hidden = overlayHiddenInSegment(overlay.anchor, seenOverlayIds.has(id), offset)
      if (hidden) this.hideOverlay(overlay.element)
      else this.showOverlay(overlay.element)
    }
  }

  private hideOverlay(element: HTMLElement): void {
    // Both properties: `visibility` can be overridden by a descendant, `opacity` cannot.
    this.ledger.setProperty(element, 'visibility', 'hidden', 'important')
    this.ledger.setProperty(element, 'opacity', '0', 'important')
  }

  private showOverlay(element: HTMLElement): void {
    this.ledger.restoreProperty(element, 'visibility')
    this.ledger.restoreProperty(element, 'opacity')
  }

  private metrics(seenOverlayIds: number[]): CaptureMetrics {
    // Only top-anchored overlays are tracked as "seen": everything else is suppressed for the
    // whole capture, so it never needs to be remembered.
    const visibleOverlayIds: number[] = []
    const seen = new Set(seenOverlayIds)
    for (const [id, overlay] of this.overlays) {
      const element = overlay.element
      if (overlay.anchor !== 'top' || seen.has(id) || !element.isConnected) continue
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
      const requiredVisibleHeight = Math.min(rect.height, window.innerHeight) * 0.9
      if (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        visibleHeight >= requiredVisibleHeight &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      ) {
        visibleOverlayIds.push(id)
      }
    }

    const geometry = this.target.geometry()
    return {
      scrollX: geometry.offsetX,
      scrollY: geometry.offset,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      captureX: geometry.captureX,
      captureY: geometry.captureY,
      captureWidth: geometry.captureWidth,
      captureHeight: geometry.captureHeight,
      documentHeight: geometry.contentHeight,
      documentWidth: geometry.contentWidth,
      overlayIds: visibleOverlayIds,
    }
  }

  /*
   * The user's floor, spent only if the section's own settling did not already cover it.
   *
   * The wait that precedes this concludes when the page stops changing, which is the right answer
   * almost everywhere and the wrong one on an application shell: skeleton placeholders sized to
   * their final height are perfectly still, so the page reads as settled while it is still empty.
   * No timeout closes that -- the wait was not running out -- so this refuses to move on instead.
   *
   * Images are re-checked afterwards rather than sleeping and shooting blind: the point of holding
   * position is to let the page fetch what it was going to fetch, and the fetches that start during
   * the hold are exactly the ones worth waiting a moment longer for.
   */
  private async holdForSectionFloor(startedAt: number): Promise<void> {
    const remaining = remainingSectionWaitMs(this.sectionWaitMs, Date.now() - startedAt)
    if (remaining <= 0) return
    await new Promise((resolve) => setTimeout(resolve, remaining))
    await this.waitForImages()
    await nextPaint()
  }

  /**
   * Puts the scroller where the capture wants it and does not come back until it is there and has
   * stopped moving.
   *
   * `settle()` cannot do this job: it waits for the document's *height* to stop changing, and a page
   * animating its scroll offset is not changing height at all -- it is quiet by every measure that
   * wait takes, which is why a capture started at the bottom of a smooth-scrolling page used to
   * photograph the bottom, or the blank space above content a scroll-reveal had not revealed yet,
   * as its first section. The offset is re-asserted every frame, so a library that writes the
   * offset once per frame from its own eased target does not simply undo us.
   */
  private async arriveAt(offset: number): Promise<ScrollArrival> {
    const geometry = this.target.geometry()
    const result = await scrollToAndWait(
      {
        read: () => this.target.geometry().offset,
        write: (value) => this.target.scrollTo(value),
        frame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        now: () => performance.now(),
      },
      offset,
      {
        // A page clamped at its own floor has arrived at a target it cannot reach, which is the
        // last section of every capture. The geometry is re-read each time rather than captured
        // once, because a lazy page grows while this runs.
        settled: (value) =>
          scrollSettleOutcome(
            offset,
            value,
            this.target.geometry().contentHeight || geometry.contentHeight,
            geometry.captureHeight,
          ) === 'settled',
      },
    )
    if (!result.arrived && result.fought) this.degradations['scroll-fought'] = 1
    return result
  }

  private async settle(): Promise<void> {
    await waitForStableLayout(SETTLE_TIMEOUT_MS, () => this.target.geometry().contentHeight)
    if (this.imageWaitMs > 0 && hasVisibleImageWithoutSource()) {
      await new Promise((resolve) => setTimeout(resolve, LAZY_SOURCE_GRACE_MS))
    }
    await this.waitForImages()
    await nextPaint()
  }

  /**
   * Off means off, everywhere.
   *
   * Both the grace period for an unsourced lazy image and the wait for a loading one exist for the
   * same reason, so a user who turned the wait off must not still be charged the grace period --
   * that would be a setting that only half works. Every image wait in the session comes through
   * here, which is what keeps the two in step.
   */
  private async waitForImages(): Promise<void> {
    if (this.imageWaitMs <= 0) return
    await waitForVisibleImages(this.imageWaitMs)
  }

  private armWatchdog(): void {
    if (this.watchdog !== undefined) window.clearTimeout(this.watchdog)
    this.watchdog = window.setTimeout(() => {
      this.cleanup()
      activeSession = undefined
    }, SESSION_WATCHDOG_MS)
  }
}

function getDocumentHeight(): number {
  const body = document.body
  const root = document.documentElement
  return Math.max(
    root.scrollHeight,
    root.offsetHeight,
    root.clientHeight,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
  )
}

function getDocumentWidth(): number {
  const body = document.body
  const root = document.documentElement
  return Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0)
}

/**
 * Resolves when the video reports the event, or when the budget runs out -- whichever is first, and
 * never later than the budget. A page that stalls on a fetch still gets its screenshot.
 */
function waitForMediaEvent(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      video.removeEventListener(event, finish)
      video.removeEventListener('error', finish)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, timeoutMs)
    video.addEventListener(event, finish, { once: true })
    video.addEventListener('error', finish, { once: true })
  })
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function waitForStableLayout(timeoutMs: number, measureHeight: () => number): Promise<void> {
  const startedAt = Date.now()
  let stableSince = startedAt
  let lastHeight = -1
  const observer = new MutationObserver(() => {
    stableSince = Date.now()
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset'],
  })
  try {
    while (Date.now() - startedAt < timeoutMs) {
      await nextPaint()
      const height = measureHeight()
      if (height !== lastHeight) stableSince = Date.now()
      lastHeight = height
      if (Date.now() - startedAt >= 250 && Date.now() - stableSince >= 200) return
    }
  } finally {
    observer.disconnect()
  }
}

function hasVisibleImageWithoutSource(): boolean {
  return Array.from(document.images).some((image) => {
    const rect = image.getBoundingClientRect()
    return !image.currentSrc && rect.bottom > 0 && rect.top < window.innerHeight
  })
}

async function waitForVisibleImages(timeoutMs: number): Promise<void> {
  const pending = Array.from(document.images).filter((image) => {
    const rect = image.getBoundingClientRect()
    return !image.complete && rect.bottom > 0 && rect.top < window.innerHeight
  })
  if (pending.length === 0) return

  await Promise.race([
    Promise.all(
      pending.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => resolve(), { once: true })
          }),
      ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/**
 * The in-page region selector.
 *
 * It is a separate short-lived session rather than part of `CaptureSession`, because everything it
 * adds to the page must be gone *before* the first screenshot is taken — an overlay that survived
 * into capture would be photographed, which is the one defect this feature can produce that the user
 * cannot undo.
 *
 * Its own `MutationLedger` and watchdog enforce that. The watchdog matters more here than during
 * capture: selection waits on a human, so if the service worker dies while the overlay is up there
 * is nothing left to tell the page to clean up, and without a timer the user would be left with a
 * dimmed, un-clickable page and no way back.
 */
/** How close to a viewport edge the pointer must be before the page starts scrolling under it. */
const REGION_EDGE_PX = 48

/**
 * How long the context-menu suppressor outlives the selection it belonged to.
 *
 * Platforms disagree about which half of a click dispatches `contextmenu`: macOS raises it from
 * mousedown, Windows and Linux from mouseup. Either way it lands *after* the `pointerdown` that
 * commits an element pick, so a suppressor torn down with the overlay is already gone when the menu
 * it exists to stop is dispatched -- which is Chrome's own menu opening on top of the fresh capture.
 * A few hundred milliseconds spans both orderings without leaving a listener on the page for long
 * enough to swallow a right-click anyone would connect to it.
 */
const CONTEXT_MENU_GRACE_MS = 400

/**
 * The overlay hint, written as parts rather than a sentence.
 *
 * A key is a thing you press, and reading its name in the same weight as the words around it makes
 * it something to parse rather than something to find. Each `key` part is drawn as a key cap, so
 * "hold Ctrl" is legible at a glance from across the page -- which is the only glance this hint
 * ever gets, because the user is already aiming at something.
 */
type HintPart = { kind: 'text'; value: string } | { kind: 'key'; value: string } | { kind: 'icon'; value: string }

/** macOS prints the modifier as a glyph on every keyboard sold; Windows and Linux spell it. */
const CTRL_KEY_LABEL = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌃' : 'Ctrl'

const DRAG_HINT: HintPart[] = [
  { kind: 'icon', value: 'drag' },
  { kind: 'text', value: 'Drag to select an area · hold' },
  { kind: 'key', value: CTRL_KEY_LABEL },
  { kind: 'text', value: 'to pick an element ·' },
  { kind: 'key', value: 'Esc' },
  { kind: 'text', value: 'to cancel' },
]

const ELEMENT_HINT: HintPart[] = [
  { kind: 'icon', value: 'pointer' },
  { kind: 'text', value: 'Click to capture the highlighted element · release' },
  { kind: 'key', value: CTRL_KEY_LABEL },
  { kind: 'text', value: 'to drag instead' },
]

const HINT_ICONS: Record<string, string> = {
  // A hand with a horizontal double arrow: the gesture, not a mouse, because the gesture is what is
  // being asked for and a trackpad user does the same thing.
  drag: 'M2.5 8h11M4.5 6 2.5 8l2 2M11.5 6l2 2-2 2',
  pointer: 'M4 2.5 12.5 7 8.75 8.25 7.5 12z',
}

function renderHint(target: HTMLElement, parts: HintPart[]): void {
  // Built as nodes rather than assigned as markup: a page that sets `require-trusted-types-for`
  // makes `innerHTML` throw, and the overlay has to work on pages we have never seen.
  target.replaceChildren()
  for (const part of parts) {
    if (part.kind === 'text') {
      target.append(document.createTextNode(` ${part.value} `))
      continue
    }
    if (part.kind === 'key') {
      const cap = document.createElement('span')
      cap.className = 'pageshotter-region-key'
      cap.textContent = part.value
      target.append(cap)
      continue
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'pageshotter-region-hint-icon')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', HINT_ICONS[part.value] ?? '')
    svg.append(path)
    target.append(svg)
  }
}

/**
 * Walks up from the element under the pointer for as long as the highlight would not move.
 *
 * A hover lands on the innermost thing at that point, which on real pages is routinely a bare
 * `<span>` inside a link inside a heading, all drawn in exactly the same place. Every one of those
 * looks identical when outlined, so choosing between them by depth is choosing at random; the
 * outermost is the only one whose choice is defensible, because it is the one that also encloses
 * anything its narrower descendants left out. The walk stops the instant the box would change, so
 * what is captured is always what was outlined.
 */
function widestElementWithSameBox(element: Element): Element {
  const box: ViewportRect = element.getBoundingClientRect()
  let widest = element
  let parent = element.parentElement
  while (parent && parent !== document.documentElement && parent !== document.body) {
    if (!sameRect(parent.getBoundingClientRect(), box)) break
    widest = parent
    parent = parent.parentElement
  }
  return widest
}

function toDocumentPoint(point: RegionPoint): RegionPoint {
  return { x: point.x + window.scrollX, y: point.y + window.scrollY }
}

function documentScrollHeight(): number {
  return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
}

class RegionSelector {
  private readonly ledger = new MutationLedger()
  private readonly overlay = document.createElement('div')
  private readonly box = document.createElement('div')
  private readonly hint = document.createElement('div')
  private readonly size = document.createElement('div')
  private readonly guideX = document.createElement('div')
  private readonly guideY = document.createElement('div')
  /** Anchor of the drag, in *document* CSS pixels, so it survives the page scrolling under it. */
  private start: RegionPoint | undefined
  /** Last pointer position in viewport CSS pixels, which is what the edge test needs. */
  private pointer: RegionPoint = { x: 0, y: 0 }
  private autoScroll: number | undefined
  /** True while Ctrl is held and no drag is running: the page offers elements instead of a crosshair. */
  private elementMode = false
  /** The highlighted element's region, in document CSS pixels, or `undefined` if nothing is offered. */
  private elementRegion: SelectedRegion | undefined
  private settle: ((region: SelectedRegion | null) => void) | undefined
  private watchdog: number | undefined
  private finished = false

  /** Resolves with the region, or `null` if the user cancelled or the watchdog fired. */
  select(): Promise<SelectedRegion | null> {
    this.install()
    this.watchdog = window.setTimeout(() => this.finish(null), REGION_WATCHDOG_MS)
    return new Promise<SelectedRegion | null>((resolve) => {
      this.settle = resolve
    })
  }

  /** Cancels an in-flight selection from outside, e.g. when the user stops the capture. */
  cancel(): void {
    this.finish(null)
  }

  private install(): void {
    const style = document.createElement('style')
    style.dataset.pageshotter = 'region-select'
    style.textContent = `
      .pageshotter-region-overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        cursor: crosshair; background: rgba(10, 16, 13, 0.35);
      }
      /*
       * As soon as there is something selected -- a drag in progress, or an element under the
       * pointer in element mode -- the overlay itself goes clear and the box dims the rest of the
       * page with one enormous spread shadow. Dimming the selection along with everything else
       * defeats the point of the selection: you are choosing what to photograph, so that part has
       * to be legible.
       */
      .pageshotter-region-overlay[data-selecting='true'] { background: transparent; }
      .pageshotter-region-box {
        position: fixed; box-sizing: border-box; pointer-events: none;
        border: 1px solid #ffffff; outline: 1px solid rgba(0, 0, 0, 0.55);
        box-shadow: 0 0 0 100vmax rgba(10, 16, 13, 0.35); display: none;
      }
      /*
       * Element mode borrows the same box -- so the same dimming shows the same promise about what
       * will be photographed -- but dashes the border. A solid rule reads as an edge you placed; a
       * dashed one reads as an edge the page is offering you, which is exactly the difference.
       */
      .pageshotter-region-box[data-element='true'] { border-style: dashed; border-width: 2px; }
      /*
       * Two dashed rules spanning the viewport, crossing at the pointer. Without them the only cue
       * for where a drag will begin is the cursor itself, which on a dimmed page is easy to lose and
       * impossible to line up against content on the far side of the screen. They track the pointer
       * before and during the drag, so the second corner can be aimed as deliberately as the first.
       */
      .pageshotter-region-guide {
        position: fixed; pointer-events: none; z-index: 2147483647; display: none;
      }
      .pageshotter-region-guide-x {
        top: 0; bottom: 0; width: 1px;
        background: repeating-linear-gradient(to bottom, #fff 0 5px, #2b2b2b 5px 10px);
      }
      .pageshotter-region-guide-y {
        left: 0; right: 0; height: 1px;
        background: repeating-linear-gradient(to right, #fff 0 5px, #2b2b2b 5px 10px);
      }
      /*
       * A dashed rule one pixel tall is easy to lose against busy content, so each end carries a
       * solid marker pointing at it: the row is findable at a glance even where the dashes fall over
       * text of the same colour.
       */
      .pageshotter-region-guide-y::before,
      .pageshotter-region-guide-y::after {
        position: absolute; font: 11px/1 system-ui, sans-serif; color: #111;
        text-shadow: 0 0 2px #fff, 0 0 2px #fff;
      }
      .pageshotter-region-guide-y::before { content: '▽'; left: 2px; bottom: 1px; }
      .pageshotter-region-guide-y::after { content: '△'; right: 2px; top: 1px; }
      .pageshotter-region-size {
        position: fixed; pointer-events: none; z-index: 2147483647; display: none;
        font: 500 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #fff; background: rgba(17, 24, 20, 0.92);
        padding: 5px 8px; border-radius: 6px; white-space: nowrap;
      }
      .pageshotter-region-hint {
        position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
        pointer-events: none; z-index: 2147483647;
        font: 500 13px/1.4 system-ui, -apple-system, sans-serif;
        color: #fff; background: rgba(17, 24, 20, 0.92);
        padding: 7px 14px; border-radius: 999px;
        display: flex; align-items: center; gap: 2px; white-space: nowrap;
      }
      /*
       * A key cap, not bold text. Every property here is stated outright because this element is
       * rendered inside someone else's page: an inherited font or border would make the key look
       * like part of their design rather than part of ours.
       */
      .pageshotter-region-key {
        display: inline-block;
        font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #111; background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.35); border-bottom-width: 2px;
        border-radius: 4px; padding: 4px 6px; margin: 0 1px;
        min-width: 10px; text-align: center;
      }
      .pageshotter-region-hint-icon {
        width: 15px; height: 15px; flex: 0 0 auto;
        fill: none; stroke: #fff; stroke-width: 1.5;
        stroke-linecap: round; stroke-linejoin: round;
      }
    `
    ;(document.head ?? document.documentElement).append(style)
    this.ledger.addNode(style)

    this.overlay.className = 'pageshotter-region-overlay'
    this.box.className = 'pageshotter-region-box'
    this.hint.className = 'pageshotter-region-hint'
    renderHint(this.hint, DRAG_HINT)
    this.size.className = 'pageshotter-region-size'
    this.guideX.className = 'pageshotter-region-guide pageshotter-region-guide-x'
    this.guideY.className = 'pageshotter-region-guide pageshotter-region-guide-y'

    this.overlay.append(this.box)
    document.documentElement.append(this.overlay, this.hint, this.size, this.guideX, this.guideY)
    this.ledger.addNode(this.overlay)
    this.ledger.addNode(this.hint)
    this.ledger.addNode(this.size)
    this.ledger.addNode(this.guideX)
    this.ledger.addNode(this.guideY)

    // Placed at the centre so the guides exist before the pointer has moved. Waiting for the first
    // pointermove left the page dimmed with no crosshair at all, which looked broken.
    // The recorded pointer starts there too, so holding Ctrl before moving the mouse outlines what
    // the guides are already crossing rather than whatever happens to sit at the top-left corner.
    this.pointer = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) }
    this.moveGuides(this.pointer.x, this.pointer.y)
    window.addEventListener('pointermove', this.onPointerMove, true)

    this.overlay.addEventListener('pointerdown', this.onPointerDown)
    this.overlay.addEventListener('pointermove', this.onPointerMove)
    this.overlay.addEventListener('pointerup', this.onPointerUp)
    this.overlay.addEventListener('pointercancel', this.onPointerCancel)
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    // A keyup can never arrive if the window loses focus mid-press, which would strand the overlay
    // in element mode with a stale highlight and no way back to the crosshair.
    window.addEventListener('blur', this.onWindowBlur)
    // On macOS, Ctrl+click is the system gesture for a context menu. Without this a Mac user's
    // modifier opens the browser's menu over the overlay instead of picking the element beneath it.
    window.addEventListener('contextmenu', this.onContextMenu, true)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Element mode also accepts the secondary button, because that is what macOS reports for the
    // Ctrl+click that puts us in element mode in the first place.
    const accepted = this.elementMode ? event.button === 0 || event.button === 2 : event.button === 0
    if (!accepted) return
    event.preventDefault()
    if (this.elementMode) {
      // A click in element mode is the whole gesture: the region was decided by the hover.
      if (this.elementRegion) this.finish(this.elementRegion)
      return
    }
    this.pointer = { x: event.clientX, y: event.clientY }
    this.start = toDocumentPoint(this.pointer)
    this.overlay.dataset.selecting = 'true'
    this.draw(this.start, this.start)
    this.autoScroll = window.requestAnimationFrame(this.tickAutoScroll)
  }

  /**
   * Scrolls the page while the pointer is held near an edge, so a selection can run past the bottom
   * of the window. The anchor is in document coordinates, so content moving under the drag extends
   * the selection rather than dragging it along.
   *
   * The step scales with how far past the edge the pointer is, which is the difference between
   * nudging a selection a little further and pulling it down a long page without the pointer
   * leaving the window.
   */
  private readonly tickAutoScroll = (): void => {
    if (!this.start) return
    const overshootTop = REGION_EDGE_PX - this.pointer.y
    const overshootBottom = this.pointer.y - (window.innerHeight - REGION_EDGE_PX)
    const step =
      overshootTop > 0 ? -regionScrollStep(overshootTop) : overshootBottom > 0 ? regionScrollStep(overshootBottom) : 0

    if (step !== 0) {
      const before = window.scrollY
      window.scrollBy(0, step)
      // Redraw even when the page refused to move: the box is positioned against the live scroll
      // offset, so skipping this would leave it stale at the top and bottom of the document.
      if (window.scrollY !== before) this.draw(this.start, toDocumentPoint(this.pointer))
    }
    this.autoScroll = window.requestAnimationFrame(this.tickAutoScroll)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY }
    if (this.start) {
      this.moveGuides(event.clientX, event.clientY)
      this.draw(this.start, toDocumentPoint(this.pointer))
      return
    }
    // Read the modifier off the pointer event as well as off the keyboard: Ctrl may have been held
    // down before the overlay opened, in which case no keydown of ours ever fires.
    this.setElementMode(event.ctrlKey)
    if (this.elementMode) this.highlightElementAt(this.pointer)
    else this.moveGuides(event.clientX, event.clientY)
  }

  /** The guides follow the pointer whether or not a drag is in progress. */
  private moveGuides(x: number, y: number): void {
    this.guideX.style.display = 'block'
    this.guideY.style.display = 'block'
    this.guideX.style.left = `${x}px`
    this.guideY.style.top = `${y}px`
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.start) return
    const region = regionFromDrag(this.start, toDocumentPoint({ x: event.clientX, y: event.clientY }))
    this.start = undefined
    this.stopAutoScroll()
    // A click, or a drag too small to be deliberate, cancels rather than capturing a sliver.
    this.finish(region ?? null)
  }

  private stopAutoScroll(): void {
    if (this.autoScroll === undefined) return
    window.cancelAnimationFrame(this.autoScroll)
    this.autoScroll = undefined
  }

  private readonly onPointerCancel = (): void => {
    this.start = undefined
    this.stopAutoScroll()
    this.clearSelectionVisuals()
  }

  private clearSelectionVisuals(): void {
    this.box.style.display = 'none'
    this.size.style.display = 'none'
    delete this.overlay.dataset.selecting
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.finish(null)
      return
    }
    if (!event.ctrlKey || this.start) return
    this.setElementMode(true)
    this.highlightElementAt(this.pointer)
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.ctrlKey) return
    this.setElementMode(false)
  }

  private readonly onWindowBlur = (): void => {
    this.setElementMode(false)
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    /*
     * On macOS, Firefox turns Ctrl+click into a secondary press and dispatches `contextmenu` *before*
     * it, and with the menu prevented the press that `onPointerDown` waits for never comes: the
     * element stayed outlined and the click did nothing. So in element mode the menu event is the
     * pick too. Chrome sends the press first, which finishes the selection, and `finish` ignores
     * this second call -- as it does once the selection is over and only this suppressor remains.
     */
    if (this.elementMode && this.elementRegion) this.finish(this.elementRegion)
  }

  /** Switches between crosshair-drag and element-pick, and swaps every affordance that differs. */
  private setElementMode(active: boolean): void {
    if (active === this.elementMode) return
    this.elementMode = active
    this.elementRegion = undefined
    this.clearSelectionVisuals()
    renderHint(this.hint, active ? ELEMENT_HINT : DRAG_HINT)
    this.overlay.style.cursor = active ? 'pointer' : 'crosshair'
    if (active) {
      // The crosshair answers "where will my drag start"; in element mode the page has already
      // answered that, so the guides are two more lines over content you are trying to read.
      this.guideX.style.display = 'none'
      this.guideY.style.display = 'none'
      return
    }
    this.box.removeAttribute('data-element')
    this.moveGuides(this.pointer.x, this.pointer.y)
  }

  /**
   * Offers the element under the pointer, if there is one worth offering.
   *
   * The overlay is part of the page's hit-test stack, so the topmost hit is always one of our own
   * nodes; `elementsFromPoint` hands back the whole stack, and the first entry we do not own is the
   * element the person believes they are pointing at.
   */
  private highlightElementAt(point: RegionPoint): void {
    const element = this.elementAt(point)
    const region = element
      ? elementRectToRegion(element.getBoundingClientRect(), { x: window.scrollX, y: window.scrollY })
      : undefined
    this.elementRegion = region
    if (!region) {
      this.clearSelectionVisuals()
      return
    }
    this.box.dataset.element = 'true'
    this.overlay.dataset.selecting = 'true'
    this.drawRegion(region)
  }

  private elementAt(point: RegionPoint): Element | undefined {
    const hit = document.elementsFromPoint(point.x, point.y).find((node) => !this.owns(node))
    // The root and the body are the whole page, which is what the other two capture buttons are for.
    // Offering them here would turn a stray hover over the page background into a full-page capture.
    if (!hit || hit === document.documentElement || hit === document.body) return undefined
    return widestElementWithSameBox(hit)
  }

  private owns(node: Element): boolean {
    return (
      node === this.overlay ||
      node === this.hint ||
      node === this.size ||
      node === this.guideX ||
      node === this.guideY ||
      this.overlay.contains(node)
    )
  }

  /** `start` and `end` are document points; the box itself is drawn in viewport space. */
  private draw(start: RegionPoint, end: RegionPoint): void {
    this.drawRegion({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    })
  }

  /** Draws a document-space region, which is where the drag path and the element path converge. */
  private drawRegion(region: SelectedRegion): void {
    const left = region.x - window.scrollX
    const top = region.y - window.scrollY
    const { width, height } = region
    this.box.style.display = 'block'
    this.box.style.left = `${left}px`
    this.box.style.top = `${top}px`
    this.box.style.width = `${width}px`
    this.box.style.height = `${height}px`

    // CSS pixels, which is what is actually on screen under the cursor. The exported file is this
    // scaled by the capture scale, and the result page reports that number once it is known.
    this.size.textContent = `${Math.round(width)} × ${Math.round(height)}`
    this.size.style.display = 'block'
    // Tucked inside the selection's bottom-right corner, which is where the pointer already is on the
    // common drag. It moves outside only when the selection is too small to hold it without covering
    // the very content being chosen.
    const inset = 6
    const readout = this.size.getBoundingClientRect()
    const fitsInside = width > readout.width + inset * 2 && height > readout.height + inset * 2
    const boxLeft = fitsInside ? left + width - readout.width - inset : left + width + inset
    const boxTop = fitsInside ? top + height - readout.height - inset : top + height + inset
    this.size.style.left = `${Math.max(0, Math.min(boxLeft, window.innerWidth - readout.width))}px`
    this.size.style.top = `${Math.max(0, Math.min(boxTop, window.innerHeight - readout.height))}px`
  }

  /**
   * Tears the overlay down exactly once, whatever ended the selection — a drag, a click, Escape, an
   * outside cancellation, or the watchdog. The page is restored before the promise resolves, so the
   * capture that follows can never photograph any of this.
   */
  private finish(region: SelectedRegion | null): void {
    if (this.finished) return
    this.finished = true
    if (this.watchdog !== undefined) window.clearTimeout(this.watchdog)
    this.stopAutoScroll()
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onWindowBlur)
    // Deliberately outlives the rest of the teardown; see CONTEXT_MENU_GRACE_MS. It holds no page
    // state and mutates nothing, so it is safe to leave attached after the ledger has restored.
    window.setTimeout(() => {
      window.removeEventListener('contextmenu', this.onContextMenu, true)
    }, CONTEXT_MENU_GRACE_MS)
    window.removeEventListener('pointermove', this.onPointerMove, true)
    this.ledger.restore()
    this.settle?.(region)
    this.settle = undefined
  }
}

let activeSession: CaptureSession | undefined
let activeSelector: RegionSelector | undefined

declare global {
  interface Window {
    __pageshotterCaptureListener?: boolean
  }
}

if (!window.__pageshotterCaptureListener) {
  window.__pageshotterCaptureListener = true
  chrome.runtime.onMessage.addListener(
    (request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
      void handleRequest(request).then(sendResponse)
      return true
    },
  )
}

async function handleRequest(request: ContentRequest): Promise<ContentResponse> {
  try {
    switch (request.type) {
      case 'PING':
        return { ok: true }
      case 'SELECT_REGION': {
        activeSelector?.cancel()
        activeSelector = new RegionSelector()
        const region = await activeSelector.select()
        activeSelector = undefined
        // Removing the overlay from the DOM is not the same as the frame that showed it being
        // replaced. `captureVisibleTab` photographs whatever the compositor last produced, so
        // answering here -- one paint too early -- let the screenshot keep the one piece of overlay
        // that sits *inside* the selection: its size readout. Everything else is outside the crop,
        // which is why the leak showed up as a stray "921 x 346" chip and nothing else.
        if (region) await nextPaint()
        return {
          ok: true,
          region,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          // Where the page ended up, so a region that still fits on screen can be served by the
          // original single-screenshot path instead of the scroll loop.
          scroll: { x: window.scrollX, y: window.scrollY },
          documentScrolls: documentScrollHeight() > window.innerHeight + 1,
        }
      }
      case 'COLLECT_PAGE_CONTENT':
        // The scroll offset rides along because a visible-area capture's image origin *is* the
        // scroll offset, and the worker has no other way to learn it -- that path never measures
        // the page at all.
      {
        // The geometry has to be read once and used for both, or the rects and the origin the
        // worker subtracts are measured against two different scroll positions.
        const geometry = activeSession?.captureGeometry()
        const target = activeSession?.scrollTarget() ?? null
        const offset = geometry ? contentScrollOffset(geometry) : { x: window.scrollX, y: window.scrollY }
        return {
          ok: true,
          // With a session this is every scroll position's harvest merged, not just this one's; the
          // session is still alive here, which is what makes that possible. A visible-area capture
          // has no session, never scrolled, and is served by a single measurement.
          pageContent: activeSession ? activeSession.collectedContent() : collectPageContent(geometry, target),
          scroll: offset,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          captureOrigin:
            activeSession && geometry
              ? activeSession.harvestOriginFor(geometry)
              : geometry
                ? imageOriginFor(geometry)
                : { x: 0, y: 0 },
        }
      }
      case 'CANCEL_REGION':
        activeSelector?.cancel()
        activeSelector = undefined
        return { ok: true }
      case 'PREPARE_CAPTURE':
        activeSession?.cleanup()
        activeSession = new CaptureSession(request.jobId)
        return {
          ok: true,
          metrics: await activeSession.prepare(request.sectionWaitMs, request.imageWaitMs),
          pageUrl: location.href,
          degradations: activeSession.reportDegradations(),
        }
      case 'CAPTURE_POSITION':
        if (!activeSession) throw new Error('Capture session is not prepared.')
        return {
          ok: true,
          metrics: await activeSession.position(
            request.scrollY,
            request.seenOverlayIds,
            request.depthLimit,
          ),
          degradations: activeSession.reportDegradations(),
        }
      case 'HEARTBEAT_CAPTURE':
        if (!activeSession) throw new Error('Capture session is not prepared.')
        activeSession.heartbeat()
        return { ok: true }
      case 'CLEANUP_CAPTURE':
        // A capture can be torn down while a region is still being selected — the user stopped it,
        // or the worker restarted — and the overlay must go with it.
        activeSelector?.cancel()
        activeSelector = undefined
        activeSession?.cleanup()
        activeSession = undefined
        return { ok: true }
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'PAGE_PREPARATION_FAILED',
        message: error instanceof Error ? error.message : 'The page could not be prepared for capture.',
      },
    }
  }
}

/**
 * Harvests the page's links and text for the PDF layers, as the page stands right now.
 *
 * One call is one measurement of the live DOM. The capture makes many -- one at each scroll position
 * and one after the loop -- and `ContentHarvest` merges them, because neither moment is sufficient
 * alone: lazy content does not exist until it has been scrolled past, and virtualised content stops
 * existing once it has been scrolled away.
 *
 * Everything is measured in one walk. Each element's computed style is read exactly once and its
 * verdicts -- pinned, hidden, clipping -- are recorded for its descendants to consult by ancestor
 * lookup. The previous version re-read the whole ancestor chain's styles for every text node, which
 * on a deep page is the same style resolved dozens of times.
 *
 * What gets left out, and why:
 *
 * - **Fixed and sticky elements.** Their captured position is decided by overlay policy -- a bottom
 *   bar is suppressed after the first segment, a sticky nav is un-stuck -- so wherever they sit at
 *   measuring time is not where they are in the image, and a link box in the wrong place is worse
 *   than no link box.
 * - **Anything an ancestor hides**, by `visibility`, `display`, `opacity: 0`, or the
 *   `position: absolute` + near-zero `clip` idiom that hides text from the screen but not from
 *   screen readers.
 * - **Whatever falls outside a clipping ancestor.** Text scrolled out of view inside an
 *   `overflow: hidden` panel is not in the picture.
 *
 * Open shadow roots are walked too, so text inside a web component is not invisible to the PDF.
 * Closed roots cannot be reached by anyone, including us.
 */
function collectPageContent(geometry?: ImageSpaceGeometry, target?: HTMLElement | null): PageContent {
  // The capture target's content offset when there is a session, the window's otherwise. A
  // visible-area capture has no session and genuinely is anchored to the window scroll.
  const offset = geometry ? contentScrollOffset(geometry) : { x: window.scrollX, y: window.scrollY }
  const scrollX = offset.x
  const scrollY = offset.y
  const links: CapturedLink[] = []
  const runs: CapturedTextRun[] = []

  const hidden = new Set<Element>()
  const pinned = new Set<Element>()
  const clips = new Map<Element, ClientRectLike>()

  /*
   * Nothing outside the photographed region may reach the text layer.
   *
   * The screenshot is cropped to this rect at every scroll position, so a word outside it is in no
   * segment of the picture -- and, because it sits outside the scrolling target, it does not move
   * with the target either. Each pass therefore records it at a different image position, and the
   * harvest's dedup, which matches on position, cannot collapse copies that are nowhere near each
   * other. The fixture page's own nav landed in the PDF twelve times, once per segment, marching
   * down a document it never appeared in.
   *
   * `pinned` already excluded fixed, sticky and absolute chrome. That rule tests how an element is
   * positioned, and so missed the whole class: in an app-shell layout, *static* content outside the
   * scroller stays put exactly as fixed chrome does. This tests the consequence instead -- whether
   * the words were photographed -- which is the thing actually being claimed.
   *
   * It deliberately does not apply inside the capture target, nor at all when the document itself
   * is the target. That scroll extent is photographed in full across the run, so the union of its
   * capture rects is all of it, and clipping each pass to the band of the moment would keep only
   * whatever happened to be on screen -- catastrophically so once the harvest budget stops the
   * per-position passes and the final one has to carry the page alone. That is the same distinction
   * `withoutVerticalClip` draws below, and getting it wrong once already cost a page 1,209 words of
   * text layer down to 210.
   */
  const captureRect = geometry ? captureRectFor(geometry) : undefined

  /** The intersection of every clipping ancestor, in viewport coordinates. */
  const clipFor = (element: Element): ClientRectLike | undefined => {
    let box: ClientRectLike | undefined
    let current: Element | null = element
    while (current && current !== document.documentElement) {
      const clip = clips.get(current)
      if (clip) {
        box = box ? intersectRect(box, clip) : clip
        // Fully clipped away: nothing below this point can be visible either.
        if (!box) return undefined
      }
      current = current.parentElement
    }
    if (captureRect && target && !(element === target || target.contains(element))) {
      box = box ? intersectRect(box, captureRect) : captureRect
    }
    return box
  }

  const excluded = (element: Element, set: Set<Element>): boolean => {
    let current: Element | null = element
    while (current && current !== document.documentElement) {
      if (set.has(current)) return true
      current = current.parentElement
    }
    return false
  }

  const roots: (Document | ShadowRoot)[] = [document]
  for (let index = 0; index < roots.length && index < MAX_CONTENT_ROOTS; index += 1) {
    const root = roots[index]!
    const start: Node | null = root === document ? document.body : root
    if (!start) continue
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const current = node
      node = walker.nextNode()

      if (current.nodeType === Node.ELEMENT_NODE) {
        const element = current as Element
        if (element.shadowRoot) roots.push(element.shadowRoot)
        const style = getComputedStyle(element)
        // Chrome, by the same rule the image uses: fixed and sticky always, and an absolutely
        // positioned element painted over a nested scroller from outside it. Overlay policy decides
        // where such a thing appears in the picture -- usually only in the first segment, or nowhere
        // -- so wherever it sits at harvest time is not where it is in the image. One PDF
        // had the chat's own header text sitting in the middle of a paragraph three pages down,
        // which is what an unexcluded absolute header does.
        if (style.position === 'fixed' || style.position === 'sticky') pinned.add(element)
        else if (style.position === 'absolute' && isChromeOverTarget(element, target)) pinned.add(element)
        if (hides(style)) hidden.add(element)
        /*
         * The capture target does not clip the harvest, and neither does anything containing it.
         *
         * A scroll container's `overflow` cuts off what is outside its *visible* box, and for an
         * ordinary panel that is right -- text scrolled out of sight inside it is genuinely not in
         * the screenshot. But the capture target is the one element whose entire scroll extent was
         * photographed, so its own overflow hides nothing from the picture, and neither does the
         * overflow of any ancestor that merely bounds it on screen.
         *
         * This was silently throwing away almost the whole text layer. Measured on one reported
         * page: 1,209 words in the scroller at harvest time, of which the visible-box
         * clip kept 210 -- and the PDF contained 198 runs. Everything else was dropped, so most of
         * the document had no selectable text at all.
         */
        if (clipsOverflow(style)) {
          const rect = element.getBoundingClientRect()
          clips.set(
            element,
            target && element.contains(target) ? withoutVerticalClip(rect) : rect,
          )
        }
        if (
          element.tagName === 'A' &&
          links.length < MAX_CAPTURED_LINKS &&
          !excluded(element, pinned) &&
          !excluded(element, hidden)
        ) {
          const anchor = element as HTMLAnchorElement
          // Only web addresses. `javascript:` does nothing in a PDF reader, and a `blob:` or
          // extension URL is meaningless outside the browser that made it.
          if (/^https?:/i.test(anchor.href)) {
            const clip = clipFor(element)
            const rects = toContentRects(clipRects(anchor.getClientRects(), clip), scrollX, scrollY)
            if (rects.length > 0) links.push({ href: anchor.href, rects })
          }
        }
        continue
      }

      if (runs.length >= MAX_CAPTURED_RUNS) continue
      const text = current as Text
      const parent = text.parentElement
      if (!parent || (text.nodeValue ?? '').trim() === '') continue
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') continue
      if (excluded(parent, pinned) || excluded(parent, hidden)) continue
      const clip = clipFor(parent)
      for (const word of textNodeWords(text, clip)) {
        if (runs.length >= MAX_CAPTURED_RUNS) break
        runs.push({
          x: word.rect.left + scrollX,
          y: word.rect.top + scrollY,
          width: word.rect.width,
          height: word.rect.height,
          text: word.text,
        })
      }
    }
  }

  return { links, runs }
}

/**
 * How many shadow roots one page is allowed to contribute.
 *
 * A component-heavy application has hundreds; a generated one could have unbounded. The cap is a
 * stall guard, not a policy -- reaching it costs a page some searchable text, never a screenshot.
 */
const MAX_CONTENT_ROOTS = 2_000

/** Whether a computed style renders nothing at all. */
function hides(style: CSSStyleDeclaration): boolean {
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return true
  if (style.position !== 'absolute') return false
  // The screen-reader-only idiom, in both its spellings.
  if (style.clipPath.replace(/\s/g, '') === 'inset(50%)') return true
  const clip = cssClipSize(style.clip)
  return clip !== undefined && (clip.width < CLIP_HIDDEN_PX || clip.height < CLIP_HIDDEN_PX)
}

/**
 * Far enough above and below the viewport to cover any capture, in CSS pixels. The ceiling is 200
 * segments, so this is comfortably past the tallest page the extension will ever assemble.
 */
const UNCLIPPED_SPAN_PX = 10_000_000

/**
 * The same box, clipping horizontally but no longer vertically.
 *
 * Used for the capture target and its ancestors. Their `overflow` still cuts off what sits outside
 * them left and right -- the capture is only ever as wide as the container -- but it cuts off
 * nothing vertically, because the whole scroll extent was photographed.
 */
function withoutVerticalClip(rect: DOMRect): ClientRectLike {
  return {
    left: rect.left,
    width: rect.width,
    top: -UNCLIPPED_SPAN_PX,
    height: UNCLIPPED_SPAN_PX * 2,
  }
}

/**
 * Whether an absolutely positioned element is chrome drawn over the capture target.
 *
 * The same rule `CaptureSession.isChromeOverCapture` applies to the picture, in the one form the
 * harvest can use: it runs after the capture, when the overlay has already been suppressed, so there
 * is no capture rect left to intersect -- containment alone decides it. An element neither inside
 * the scrolled container nor an ancestor of it is not part of what was photographed.
 */
function isChromeOverTarget(element: Element, target: HTMLElement | null | undefined): boolean {
  if (!target) return false
  return !target.contains(element) && !element.contains(target)
}

/** Whether a computed style makes an element cut off what overflows it. */
function clipsOverflow(style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return false
  return [style.overflowX, style.overflowY].some(
    (overflow) => overflow === 'hidden' || overflow === 'auto' || overflow === 'scroll' || overflow === 'clip',
  )
}

/** Every rect held inside the clip, dropping those it cuts away entirely. */
function clipRects(rects: ArrayLike<ClientRectLike>, clip: ClientRectLike | undefined): ClientRectLike[] {
  const held: ClientRectLike[] = []
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]
    if (!rect) continue
    if (!clip) {
      held.push(rect)
      continue
    }
    const inside = intersectRect(rect, clip)
    if (inside) held.push(inside)
  }
  return held
}

/**
 * One measured box per word in a text node.
 *
 * A word is the unit because it is the largest span whose box can be trusted: it never wraps, so a
 * range around it reports exactly where those characters were drawn. The line-level runs this
 * replaces had to be stretched across their box by a horizontal scale factor, and since the page's
 * font is not the PDF's font, every character between the two ends landed by proportion -- which is
 * why dragging across a heading selected all but its last letter.
 *
 * The one case where a word does wrap is a long token broken mid-word by `word-break` or
 * hyphenation. Then the range reports several rects, and the word is subdivided by binary search
 * into the characters belonging to each -- rare, bounded, and measured rather than apportioned.
 */
function textNodeWords(node: Text, clip: ClientRectLike | undefined): { text: string; rect: ClientRectLike }[] {
  const value = node.nodeValue ?? ''
  const range = document.createRange()
  const words: { text: string; rect: ClientRectLike }[] = []

  const emit = (from: number, to: number): void => {
    const text = value.slice(from, to)
    if (text.trim() === '') return
    range.setStart(node, from)
    range.setEnd(node, to)
    const held = clipRects(range.getClientRects(), clip)
    const rect = held[0]
    if (!rect || rect.width < MIN_CONTENT_PX || rect.height < MIN_CONTENT_PX) return
    words.push({ text, rect })
  }

  for (const span of wordSpans(value)) {
    range.setStart(node, span.from)
    range.setEnd(node, span.to)
    const lineCount = range.getClientRects().length
    if (lineCount <= 1) {
      emit(span.from, span.to)
      continue
    }
    for (const line of lineSpans(node, span.from, span.to, lineCount, range)) emit(line.from, line.to)
  }
  return words
}

/**
 * Where a wrapped span breaks, as character offsets.
 *
 * Binary search for the first offset at which an extra client rect appears, per line. A linear scan
 * would answer the same question one character at a time; this costs lines x log(length) range
 * measurements, and a range measurement is a layout read.
 */
function lineSpans(
  node: Text,
  from: number,
  to: number,
  lineCount: number,
  range: Range,
): { from: number; to: number }[] {
  const rectsAt = (offset: number): number => {
    range.setStart(node, from)
    range.setEnd(node, offset)
    return range.getClientRects().length
  }

  const starts = [from]
  for (let line = 2; line <= lineCount; line += 1) {
    let low = starts[starts.length - 1]! + 1
    let high = to
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (rectsAt(middle) >= line) high = middle
      else low = middle + 1
    }
    if (low <= starts[starts.length - 1]!) break
    starts.push(low - 1)
  }

  return starts.map((start, index) => ({
    from: start,
    to: index + 1 < starts.length ? starts[index + 1]! : to,
  }))
}
