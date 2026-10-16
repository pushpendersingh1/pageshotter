import { BROWSER } from '../shared/browser'
import {
  REVIEW_FEEDBACK_URL,
  type ReviewState,
  getReviewState,
  putReviewState,
  respondToReviewPrompt,
} from '../shared/review-prompt'

/*
 * The store-review invitation, ported from an approved prototype — the design, copy, animation and
 * behaviour are the prototype's, not a redesign. Four decisions sit between it and this port:
 *
 * - State lives in the IndexedDB settings store, not `chrome.storage.local` (no `storage` permission).
 * - The store opens with `chrome.tabs.create`, still synchronously inside the click gesture.
 * - "Tell me privately" opens the extension's own support page (the "Tell us safely" link).
 * - The rules and copy are the prototype's; the demo-only wiring is not ported.
 */

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)'
const EASE_SPRING = 'cubic-bezier(.3,1.5,.5,1)'

const anim = (node: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) =>
  node.animate(frames, RM ? { ...opts, duration: 0, delay: 0 } : opts)

const STAR_PATH = 'M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z'

interface ReviewCard {
  root: HTMLElement
  playIntro: (delay?: number) => void
}

export function buildReview(count: number, onClose: () => void, card: HTMLElement): ReviewCard {
  const root = document.createElement('div')
  root.append(
    (document.getElementById('rv-tpl') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment,
  )
  root.querySelector('.rv-count')!.textContent = String(count)
  // An attribute cannot carry the build's browser marker, so the store is named here.
  root.querySelector('[data-step="ask"] .rv-frame')!.setAttribute('aria-label', `Rate on the ${BROWSER.storeName}`)
  const starsEl = root.querySelector('.rv-stars') as HTMLElement
  const hint = root.querySelector('.rv-hint') as HTMLElement
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rv-star'
    b.dataset.n = String(i)
    b.dataset.rv = 'rate'
    b.setAttribute('aria-label', `Rate ${i} star${i > 1 ? 's' : ''} on the ${BROWSER.storeName}`)
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`
    starsEl.append(b)
  }
  const stars = [...starsEl.children] as HTMLElement[]
  let userTouched = false
  let locked = false
  const paint = (n: number, withHint = true): void => {
    stars.forEach((s) => s.classList.toggle('is-on', Number(s.dataset.n) <= n))
    if (withHint) hint.textContent = n ? 'Opens the store to post your rating' : '\u00a0'
  }
  const touch = (e: Event): void => {
    const s = (e.target as HTMLElement).closest('.rv-star') as HTMLElement | null
    if (s && !locked) {
      userTouched = true
      paint(Number(s.dataset.n))
    }
  }
  starsEl.addEventListener('pointerover', touch)
  starsEl.addEventListener('focusin', touch)
  starsEl.addEventListener('pointerleave', () => !locked && paint(0))
  starsEl.addEventListener('focusout', () => !locked && paint(0))

  root.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-rv]') as HTMLElement | null
    if (!t) return
    e.preventDefault()
    const act = t.dataset.rv
    if (act === 'rate') {
      // Synchronous with the click: the ask is open, no dialog is closing around it, and the tab
      // must open before anything yields.
      if (BROWSER.reviewUrl) void chrome.tabs.create({ url: BROWSER.reviewUrl })
      locked = true
      void saveAnswer('rate')
      const n = Number(t.dataset.n || 5)
      celebrate(stars, n)
      setTimeout(() => showThanks(root, onClose, card), RM ? 0 : 620)
    } else if (act === 'later') {
      void saveAnswer('later')
      onClose()
    } else if (act === 'never') {
      void saveAnswer('never')
      onClose()
    } else if (act === 'feedback') {
      // The same snooze "Not now" gets: the ask has served its purpose either way.
      void saveAnswer('feedback')
      void chrome.tabs.create({ url: REVIEW_FEEDBACK_URL })
      onClose()
    }
  })

  return {
    root,
    playIntro: (delay = 0) => playIntro(root, stars, paint, () => userTouched, delay),
  }
}

async function saveAnswer(answer: 'rate' | 'later' | 'never' | 'feedback'): Promise<void> {
  try {
    const state = await getReviewState()
    await putReviewState(respondToReviewPrompt(state, answer, Date.now()))
  } catch {
    // A missed answer only means the ask may come back; nothing about the export depends on it.
  }
}

/*
 * The orchestrated moment: check draws, viewfinder brackets focus in, shutter flashes, stars
 * develop one by one, then a single "tap me" wave. Timings and easings are the prototype's.
 */
function playIntro(
  root: HTMLElement,
  stars: HTMLElement[],
  paint: (n: number, withHint?: boolean) => void,
  touched: () => boolean,
  d: number,
): void {
  const frame = root.querySelector('[data-step="ask"] .rv-frame') as HTMLElement
  focusBrackets(frame, d)

  anim(root.querySelector('.rv-flash') as HTMLElement, [
    { opacity: 0 },
    { opacity: 0.85, offset: 0.25 },
    { opacity: 0 },
  ], { duration: 360, delay: d + 340, easing: 'ease-out' })

  stars.forEach((s, i) =>
    anim(s.firstElementChild as SVGElement, [
      { opacity: 0, transform: 'scale(.2) rotate(-72deg)' },
      { opacity: 1, transform: 'scale(1.18) rotate(10deg)', offset: 0.65 },
      { opacity: 1, transform: 'none' },
    ], { duration: 420, delay: d + 400 + i * 65, easing: EASE_OUT, fill: 'backwards' }))

  if (RM) return
  const waveAt = d + 1080
  for (let n = 1; n <= 5; n++) setTimeout(() => !touched() && paint(n, false), waveAt + n * 70)
  setTimeout(() => !touched() && paint(0, false), waveAt + 5 * 70 + 380)
}

function focusBrackets(frame: HTMLElement, delay: number): void {
  const off: Array<[number, number]> = [[-12, -12], [12, -12], [-12, 12], [12, 12]]
  const corners = [...frame.querySelectorAll<HTMLElement>(':scope > i')]
  corners.forEach((c, i) => {
    const offset = off[i]
    if (!offset) return
    const [x, y] = offset
    anim(c, [
      { opacity: 0, transform: `translate(${x}px,${y}px) scale(1.4)` },
      { opacity: 1, transform: `translate(${-x * 0.18}px,${-y * 0.18}px) scale(.94)`, offset: 0.7 },
      { opacity: 1, transform: 'none' },
    ], { duration: 420, delay, easing: EASE_OUT, fill: 'backwards' })
  })
}

function celebrate(stars: HTMLElement[], n: number): void {
  stars.forEach((s, i) => {
    setTimeout(() => {
      if (i < n) {
        s.classList.add('is-on')
        anim(s.firstElementChild as SVGElement, [
          { transform: 'scale(1)' },
          { transform: 'scale(1.35)' },
          { transform: 'scale(1)' },
        ], { duration: 260, easing: EASE_SPRING })
      } else s.classList.remove('is-on')
    }, RM ? 0 : i * 55)
  })
  if (RM) return
  const target = stars[n - 1]
  if (!target) return
    setTimeout(() => {
      const colors = ['var(--rv-star)', 'var(--accent)', 'var(--rv-star)'] as const
      for (let k = 0; k < 10; k++) {
        const p = document.createElement('span')
        p.className = 'spark'
        p.style.background = colors[k % colors.length] ?? colors[0]
        target.append(p)
      const a = (k / 10) * Math.PI * 2
      const r = 26 + (k % 2) * 10
      p.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * r}px,${Math.sin(a) * r}px) scale(.2)`, opacity: 0 },
      ], { duration: 520, easing: EASE_OUT }).onfinish = () => p.remove()
    }
  }, (n - 1) * 55 + 60)
}

function showThanks(root: HTMLElement, onClose: () => void, card: HTMLElement): void {
  const ask = root.querySelector('[data-step="ask"]') as HTMLElement
  const thanks = root.querySelector('[data-step="thanks"]') as HTMLElement
  morph(card, () => {
    ask.hidden = true
    thanks.hidden = false
  })
  focusBrackets(thanks.querySelector('.rv-frame') as HTMLElement, 120)
  anim(thanks.querySelector('.rv-frame svg') as SVGElement, [
    { transform: 'scale(0) rotate(-120deg)' },
    { transform: 'scale(1.2) rotate(12deg)', offset: 0.7 },
    { transform: 'none' },
  ], { duration: 520, delay: 220, easing: EASE_OUT, fill: 'backwards' })
  // Close a moment after they come back from the store tab
  const back = (): void => {
    if (document.visibilityState === 'visible') {
      document.removeEventListener('visibilitychange', back)
      setTimeout(onClose, 2400)
    }
  }
  document.addEventListener('visibilitychange', back)
  setTimeout(back, 50)
}

/** Smoothly animate a card's width/height across a content swap. */
export function morph(card: HTMLElement, swap: () => void): void {
  const a = card.getBoundingClientRect()
  swap()
  const b = card.getBoundingClientRect()
  anim(card, [
    { width: `${a.width}px`, height: `${a.height}px` },
    { width: `${b.width}px`, height: `${b.height}px` },
  ], { duration: 380, easing: EASE_OUT })
}

/** The prototype's save-form exit: a short fade upward, used before the dialog morphs. */
export function fadeOutUp(node: HTMLElement): Promise<unknown> {
  return anim(node, [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: 'translateY(-6px)' },
  ], { duration: 150, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => undefined)
}

/*
 * ---------- the popover, anchored under the button the ask came from ----------
 *
 * In the prototype the caret sits a fixed distance from the card's right edge, because the only
 * anchor was the Download button. Here the ask can come from Copy as well, so the caret is placed
 * from the anchor's own box.
 */

const POPOVER_ID = 'rv-pop'

export function openPop(anchor: HTMLElement, state: ReviewState): void {
  const pop = document.getElementById(POPOVER_ID) as HTMLElement
  const rv = buildReview(state.exports, () => closePop(pop, anchor), pop)
  placeCaret(pop, anchor)
  pop.replaceChildren(rv.root)
  pop.hidden = false
  anim(anchor, [
    { transform: 'scale(1)' },
    { transform: 'scale(.95)' },
    { transform: 'scale(1)' },
  ], { duration: 220, easing: EASE_SPRING })
  pop.style.transformOrigin = 'calc(100% - var(--pop-caret)) -8px'
  anim(pop, [
    { opacity: 0, transform: 'translateY(-10px) scale(.6)', clipPath: 'inset(0 0 100% 60% round 14px)' },
    { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0 round 14px)' },
  ], { duration: 420, easing: EASE_OUT })
  rv.playIntro(160)
  rv.root.querySelector<HTMLElement>('.rv-cta')?.focus({ preventScroll: true })
}

function placeCaret(pop: HTMLElement, anchor: HTMLElement): void {
  const popRight = pop.getBoundingClientRect().right
  const box = anchor.getBoundingClientRect()
  const caret = Math.max(18, popRight - box.right + box.width / 2 - 6)
  pop.style.setProperty('--pop-caret', `${Math.round(caret)}px`)
}

export function closePop(pop: HTMLElement, anchor: HTMLElement): void {
  anim(pop, [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: 'translateY(-6px) scale(.97)' },
  ], { duration: 160, easing: 'ease-in' }).onfinish = () => {
    pop.hidden = true
    pop.replaceChildren()
    anchor.focus({ preventScroll: true })
  }
}

/** Escape inside the popover acts as "Not now", exactly as it does in the dialog. */
export function popoverLater(pop: HTMLElement): void {
  pop.querySelector<HTMLElement>('[data-rv="later"]')?.click()
}
