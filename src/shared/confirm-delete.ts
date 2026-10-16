/**
 * The delete confirmation, and the print handoff, shared by the result page and the editor.
 *
 * Both surfaces show the same capture and both now offer the same two actions on it, so they ask
 * the question the same way. The dialog is built here rather than written into two HTML files,
 * which is what keeps the wording, the focus order and the motion from drifting apart.
 */

/**
 * Waits for animations to finish, but never on their word alone.
 *
 * `Animation.finished` is the right signal and it is not a guaranteed one: Chrome freezes the
 * document timeline in a tab that is not being painted, and a frozen animation reports `running`
 * with a `currentTime` of 0 forever, so its promise never settles. Waiting on that with no way out
 * leaves the dialog on screen and the caller's promise pending -- the deletion neither happens nor
 * visibly fails. The timeout is a ceiling on the wait, not a delay: with the timeline moving, the
 * animations settle first and it is never reached.
 *
 * Reduced motion removes the animations entirely, so the list is empty and this returns at once.
 */
async function settledOrAfter(animations: Animation[], ceilingMs: number): Promise<void> {
  if (animations.length === 0) return
  await Promise.race([
    Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))),
    new Promise((resolve) => window.setTimeout(resolve, ceilingMs)),
  ])
}

/** Resolves true only if the person confirmed; Escape, the backdrop and Keep all resolve false. */
export function confirmDelete(options: { heading: string; detail: string }): Promise<boolean> {
  const dialog = document.createElement('dialog')
  dialog.className = 'pd-dialog'
  dialog.setAttribute('aria-labelledby', 'pd-heading')
  dialog.innerHTML = `
    <div class="pd-body">
      <div class="pd-head">
        <span class="pd-mark" aria-hidden="true"><svg class="icon" data-icon="trash" viewBox="0 0 24 24" focusable="false"></svg></span>
        <h2 id="pd-heading"></h2>
      </div>
      <p class="pd-detail"></p>
    </div>
    <div class="pd-actions">
      <button class="btn pd-keep" type="button"></button>
      <button class="btn danger pd-confirm" type="button"><span class="button-label"></span></button>
    </div>`

  // `textContent`, never interpolation: the detail carries a page title, which is someone else's
  // text and must never be parsed as markup.
  const heading = dialog.querySelector('#pd-heading') as HTMLElement
  const detail = dialog.querySelector('.pd-detail') as HTMLElement
  const keep = dialog.querySelector('.pd-keep') as HTMLButtonElement
  const confirm = dialog.querySelector('.pd-confirm') as HTMLButtonElement
  heading.textContent = options.heading
  detail.textContent = options.detail
  keep.textContent = 'Keep it'
  ;(confirm.querySelector('.button-label') as HTMLElement).textContent = 'Delete'

  // The icon markers are inlined at build time in the page's own HTML; one created at runtime has to
  // be filled from a glyph already on the page, and is simply left empty when there is none.
  const source = document.querySelector('svg[data-icon="trash"]')
  const mark = dialog.querySelector('svg[data-icon="trash"]')
  // Cloned nodes rather than `innerHTML`: the same glyph, without handing a store's linter markup to vet.
  if (source && mark) mark.replaceChildren(...[...source.childNodes].map((node) => node.cloneNode(true)))

  document.body.append(dialog)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    /* The sweep is allowed to finish before the dialog leaves, so the commit is seen rather than
     * merely started. */
    const commit = async (): Promise<void> => {
      confirm.dataset.committing = 'true'
      keep.disabled = true
      confirm.disabled = true
      await settledOrAfter(confirm.getAnimations({ subtree: true }), 500)
      close(true)
    }

    const close = (value: boolean): void => {
      dialog.dataset.closing = 'true'
      void settledOrAfter(dialog.getAnimations(), 400).then(() => {
        dialog.remove()
        finish(value)
      })
    }

    keep.addEventListener('click', () => close(false))
    confirm.addEventListener('click', () => void commit())
    // Escape fires `cancel`; the default close would skip the exit animation, so it is taken over.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      close(false)
    })
    dialog.showModal()
    keep.focus()
  })
}

/**
 * Print an image, by making it the only thing on the page while the print dialog is open.
 *
 * The first version loaded the blob URL into an iframe and printed that, which **clipped every
 * capture** to its left half in print preview. A browser given an image as a document renders an *image document*, and an image
 * document prints at the image's natural size with no fit-to-page step at all: a 1,440px-wide
 * capture against roughly 816px of printable width simply loses everything past the right edge.
 * Nothing in the iframe could fix that, because the document being printed was not ours to style.
 *
 * So the image is printed from this page instead, where its width can be set against the page box.
 * `@media print` in `confirm-delete.css` hides every other top-level element for the duration, which
 * is also why this needs no iframe, no generated markup and nothing that has to clear the extension
 * content-security policy.
 *
 * Printing what an export would produce, rather than the interface around it, is still the point:
 * the sheet is the encoded blob at full resolution, not the preview tiles or the editor canvas.
 */
export function printImage(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const sheet = document.createElement('img')
  sheet.className = 'pd-print-sheet'
  sheet.alt = ''
  const cleanUp = (): void => {
    sheet.remove()
    URL.revokeObjectURL(url)
  }
  // Printing before the image has decoded prints an empty box, so the dialog waits for the load.
  sheet.addEventListener('load', () => {
    try {
      window.print()
    } finally {
      cleanUp()
    }
  })
  sheet.addEventListener('error', cleanUp)
  sheet.src = url
  document.body.append(sheet)
}
