import {
  presentedPdfOptions,
  unsplitPageProblem,
  type PdfOptions,
  type PdfPageSizeName,
} from './pdf-layout'
import {
  clampJpegQuality,
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_SCALE,
  exportAdvice,
  exportLimitParts,
  exportOutcome,
  exportOutcomeLabel,
  exportOutcomeParts,
  formatBytes,
  isSingleImageFormat,
  scaledDimension,
  limitsForFormat,
  readExportFormat,
  readExportScale,
  type ExportFormat,
} from './export-options'
import { singleImageLimitParts } from '../shared/capture-plan'
import { flattenParts, noticeText, type NoticePart } from '../shared/notice-parts'
import type { CropRect } from './crop-geometry'
import {
  DEFAULT_EXPORT_PREFERENCES,
  DEFAULT_JPEG_QUALITY,
  getExportPreferences,
  setExportFormat,
  setExportScale,
  setJpegQuality,
  setPdfOptions,
} from './export-preferences'

/**
 * The export menu: one format choice and whatever that format can actually be told to do.
 *
 * This replaced three separate download buttons. The reason is not tidiness -- it is that they
 * were not equal choices. PNG, JPEG and WebP are the same picture at different sizes, while PDF is
 * a different kind of file with four options of its own, and a row of buttons made the PDF options
 * reachable only through a caret nobody found. One primary button that names the format it will
 * produce, with the format picker inside it, puts the choice and its consequences in one place.
 *
 * Only options the extension can honour appear here. The export scale the reference mock drew now
 * exists and so is drawn; the URL stamp still does not, and a control that does nothing is worse
 * than an absent one, so it is still absent.
 *
 * Scale sits outside the format panels because it applies to all three raster formats, and it is
 * hidden for PDF, which is laid out to a page size rather than resampled.
 *
 * The two PDF text checkboxes are one setting wearing two hats, which is clearer
 * than it sounds: "disable text selection" and "text-searchable" are the off and on
 * states of the same layer, so they are kept mutually exclusive rather than allowed to contradict
 * each other. Presenting it as two lines makes the default -- no text layer -- a choice the user can
 * see they have made, instead of an absence.
 */
/** Long enough to sit out a slider drag; short enough that the number is not a separate step. */
const MEASURE_DELAY = 260

export class ExportMenu {
  private format: ExportFormat = DEFAULT_EXPORT_FORMAT
  private jpegQuality = DEFAULT_JPEG_QUALITY
  private exportScale = DEFAULT_EXPORT_SCALE
  private options: PdfOptions = { ...DEFAULT_EXPORT_PREFERENCES.pdf }

  private readonly elements: MenuElements

  constructor(
    /** Where the `export-menu.html` fragment was expanded; both surfaces pass `document`. */
    root: ParentNode,
    /** The crop being exported, so the single-page limit can be checked against real numbers. */
    private readonly cropOf: () => CropRect | undefined,
    /**
     * Told whenever a choice that changes what the export *can produce* is made -- the format, so
     * the primary button can rename itself, and the scale, because the single-image ceiling is
     * measured against it. Scale used not to report, so accepting the notice's own "at 25% it fits"
     * left that notice on screen still saying the export could not be made.
     */
    private readonly onOptionsChange: (format: ExportFormat) => void,
    /**
     * The finished presented size, in output pixels, when the user is wrapping the capture in a
     * browser frame -- or `null` when Present is off. The frame adds chrome and margin, so the
     * single-image ceiling and the outcome line have to be measured against the framed picture, not
     * the crop that would have fit alone.
     */
    private readonly presentedSizeOf: () => { width: number; height: number } | null = () => null,
    /**
     * Whether the picture being exported has a transparent background. Only the editor can produce
     * one, so the result page leaves this alone.
     */
    private readonly transparentOf: () => boolean = () => false,
    /**
     * The size the file would actually be, in bytes, encoded with the options as they now stand --
     * or `undefined` when there is nothing to encode.
     *
     * There is no way to know a compressed size except to compress, so this really does the export;
     * both surfaces hand back the same blob their Download button would produce, and cache it, so
     * pressing Download after looking at the size costs nothing. Measured on a 3,008 x 1,940 capture
     * in Chrome: PNG 25ms, JPEG 31ms, WebP 225ms -- which is why it runs behind a delay and never
     * during a drag.
     */
    private readonly measureOf: () => Promise<number | undefined> = async () => undefined,
  ) {
    const elements = (this.elements = bindElements(root))
    const { toggle, menu } = elements
    toggle.addEventListener('click', () => this.setOpen(menu.hidden === true))
    // Closing on an outside click rather than on blur, because the menu holds several controls and
    // moving between them must not dismiss it.
    document.addEventListener('click', (event) => {
      if (menu.hidden) return
      const target = event.target as Node
      if (!menu.contains(target) && target !== toggle && !toggle.contains(target)) this.setOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        this.setOpen(false)
        // Focus goes back to the control that opened the menu, or Escape leaves the keyboard user
        // with nothing selected and no way back except Tab from the top of the page.
        toggle.focus()
      }
    })

    for (const button of elements.formats) {
      button.addEventListener('click', () => this.changeFormat(readExportFormat(button.dataset.format)))
    }

    // JPEG and WebP share one stored quality: they are the same decision about the same picture, and
    // two remembered numbers would mean the slider jumping when the format changed.
    for (const slider of [elements.jpegQuality, elements.webpQuality]) {
      slider.addEventListener('input', () => {
        this.jpegQuality = clampJpegQuality(slider.value, this.jpegQuality)
        void setJpegQuality(this.jpegQuality).catch(() => undefined)
        this.draw()
      })
    }

    elements.scale.addEventListener('change', () => {
      this.applyScale(readExportScale(Number(elements.scale.value)))
    })

    elements.noText.addEventListener('change', () => this.change({ textSearchable: !elements.noText.checked }))
    elements.text.addEventListener('change', () => this.change({ textSearchable: elements.text.checked }))
    elements.links.addEventListener('change', () => this.change({ directLinks: elements.links.checked }))
    elements.split.addEventListener('change', () => this.change({ splitToPages: elements.split.checked }))
    elements.customSize.addEventListener('change', () =>
      this.change({ pageSize: elements.customSize.checked ? (elements.pageSize.value as PdfPageSizeName) : 'fit' }),
    )
    elements.pageSize.addEventListener('change', () =>
      this.change({ pageSize: elements.pageSize.value as PdfPageSizeName }),
    )
  }

  /** Loads the remembered choices; falls back to the defaults if nothing is stored. */
  async load(): Promise<void> {
    const preferences = await getExportPreferences()
    this.options = preferences.pdf
    this.format = preferences.format
    this.jpegQuality = preferences.jpegQuality
    this.exportScale = preferences.scale
    this.draw()
    this.onOptionsChange(this.format)
  }

  current(): ExportFormat {
    return this.format
  }

  /**
   * Accepts the scale the refusal named, from outside the menu.
   *
   * The `<select>` is updated too rather than only the stored value: the menu is one caret away, and
   * finding it still reading 100% after the page said it had switched to 25% would make the control
   * and the picture disagree about what is about to be exported.
   */
  setScale(scale: number): void {
    this.elements.scale.value = String(scale)
    this.applyScale(readExportScale(scale))
  }

  private applyScale(scale: number): void {
    this.exportScale = scale
    void setExportScale(this.exportScale).catch(() => undefined)
    this.draw()
    this.onOptionsChange(this.format)
  }

  /** The 0-1 fraction `encodeJpeg` expects, not the percentage the slider shows. */
  quality(): number {
    return clampJpegQuality(this.jpegQuality, DEFAULT_JPEG_QUALITY) / 100
  }

  /** 1 unless the user chose to resample. Never applied to Copy or to PDF. */
  scale(): number {
    return isSingleImageFormat(this.format) ? readExportScale(this.exportScale) : DEFAULT_EXPORT_SCALE
  }

  /**
   * The PDF options as they will actually be applied.
   *
   * A capture with no harvested content cannot have the layers that depend on it, and returning the
   * user's preference regardless would produce a PDF that silently lacks what was ticked.
   */
  pdfOptions(hasContent: boolean): PdfOptions {
    // A presented PDF is the framed picture on one page of its own shape; the stored page and layer
    // choices describe a document and are not applied to it.
    if (this.presenting) return presentedPdfOptions(this.options)
    return {
      ...this.options,
      directLinks: this.options.directLinks && hasContent,
      textSearchable: this.options.textSearchable && hasContent,
    }
  }

  /**
   * Whether the current options can produce a file at all, and why not if they cannot -- as the
   * marked-up runs the refusal is drawn from, so the sentence shown before the button is pressed and
   * the one shown after it cannot be worded, or emphasised, differently.
   */
  problemParts(): readonly NoticePart[] | undefined {
    const crop = this.cropOf()
    if (!crop) return undefined
    if (this.format === 'pdf') {
      if (this.presenting) {
        // One page the shape of the framed picture, measured against that picture, not the crop.
        const size = this.presentedSizeOf() ?? crop
        const tooLong = unsplitPageProblem({ x: 0, y: 0, width: size.width, height: size.height }, this.pdfOptions(this.hasContent))
        // Its own wording: the generic one says to turn on Split to pages, which a presented PDF does not offer.
        return tooLong
          ? [noticeText('This framed picture is too long for one PDF page — PDF pages stop at 200 inches. Export it as PNG, JPEG or WebP instead.')]
          : undefined
      }
      const pdf = unsplitPageProblem(crop, this.options)
      return pdf ? [noticeText(pdf)] : undefined
    }
    // Checked here as well as shown on the page, so clicking Download on an image the format cannot
    // hold explains itself instead of spending a full-size canvas to arrive at the same sentence.
    // The ceiling is measured against the *framed* picture while Present is on; padding and chrome
    // add pixels a crop alone never had to fit.
    const size = this.presentedSizeOf()
    if (size) {
      const limits = limitsForFormat(this.format)
      if (!limits) return undefined
      // The ceiling is measured against the file, so the export scale applies here as it does to
      // the outcome line. `presentedSizeOf` reports the framed picture at its own size.
      const scale = this.scale()
      const parts = singleImageLimitParts(scaledDimension(size.width, scale), scaledDimension(size.height, scale), limits)
      return parts ?? undefined
    }
    return exportLimitParts(this.format, crop.width, crop.height, this.scale()) ?? undefined
  }

  /**
   * Present mode wraps every export in a mock browser window. While it is on, the outcome line and the
   * single-image ceiling describe the framed size rather than the crop's, and a PDF is that framed
   * picture on one page of its own shape (`presentedPdfOptions`).
   */
  setPresenting(on: boolean): void {
    this.presenting = on
    this.draw()
    this.onOptionsChange(this.format)
  }

  private presenting = false
  /** The last measured file size, cleared whenever anything that changes the file changes. */
  private bytes: number | undefined
  private measureTimer = 0
  /** Whether an encode is in flight or waiting out its delay, which is what the spinner shows. */
  private measuring = false
  /** Rises on every schedule, so a slow encode that lands after its options changed is dropped. */
  private measureToken = 0

  /** The same refusal as plain prose, for the menu's own one-line note. */
  problem(): string | undefined {
    const parts = this.problemParts()
    return parts ? flattenParts(parts) : undefined
  }

  setAvailable(hasContent: boolean, reason?: string): void {
    this.hasContent = hasContent
    this.unavailableReason = reason
    this.draw()
  }

  /** Re-reads anything measured against the crop, which changes under the menu while it is open. */
  refresh(): void {
    this.draw()
  }

  private hasContent = true
  private unavailableReason: string | undefined

  /**
   * The outcome line. Hidden for PDF, which is laid out to a page size rather than resampled, so a
   * pixel count for it would describe something the file does not have.
   */
  private drawOutcome(): void {
    const { outcome, outcomeSize, outcomeRatio, ratioPart } = this.elements
    const crop = this.cropOf()
    if (!crop || !isSingleImageFormat(this.format)) {
      outcome.hidden = true
      return
    }
    outcome.hidden = false
    // While Present is on the outcome line names the framed size: that is the file the button will
    // produce, and a line describing the unframed crop would promise a file with no frame in it.
    const presented = this.presenting ? this.presentedSizeOf() : null
    const size = presented ?? { width: crop.width, height: crop.height }
    const result = exportOutcome(size.width, size.height, this.scale())
    const parts = exportOutcomeParts(result)
    outcomeSize.textContent = parts.size
    // The measured file size joins the ratio rather than taking a third line: at 260px a mono line
    // holds about 30 characters and "full resolution - 1.2 MB" is 24 of them.
    outcomeRatio.textContent = parts.ratio
    // The size joins the ratio rather than taking a third line: at 260px a mono line holds about 30
    // characters and "full resolution - 1.2 MB" is 24 of them.
    const weight = this.bytes === undefined ? '' : formatBytes(this.bytes)
    const { outcomeWeight, outcomeWeightValue } = this.elements
    outcomeWeight.dataset.state = weight !== '' ? 'done' : this.measuring ? 'busy' : 'off'
    outcomeWeightValue.textContent = weight
    // The two lines read as one fact, so the group carries the joined sentence as its label. A size
    // still being measured says so, rather than reading as a file with no size.
    const label = `Export size: ${exportOutcomeLabel(result)}`
    outcome.setAttribute(
      'aria-label',
      weight !== '' ? `${label}, ${weight}` : this.measuring ? `${label}, file size calculating` : label,
    )
    // The glyph is scaled linearly, matching the 16-unit outline it sits inside.
    const side = Math.max(2, 16 * this.scale())
    ratioPart.setAttribute('width', String(side))
    ratioPart.setAttribute('height', String(side))
  }

  private setOpen(open: boolean): void {
    this.elements.menu.hidden = !open
    this.elements.toggle.setAttribute('aria-expanded', String(open))
    this.scheduleMeasure()
  }

  /**
   * Encodes the file, once the options have stopped moving, to say what it will weigh.
   *
   * Behind a delay because the only way to know is to do it, and because every keystroke on the
   * quality slider changes the answer. Skipped for PDF -- the writer would have to lay out the whole
   * document to produce a byte count, which is the export itself -- and skipped while the menu is
   * shut or the export is impossible, where the number would be a lie or a waste.
   */
  private scheduleMeasure(): void {
    this.bytes = undefined
    this.measureToken += 1
    const token = this.measureToken
    window.clearTimeout(this.measureTimer)
    // PDF is skipped deliberately: its size is only knowable by laying out the whole document, which
    // is the export itself, which is ruled out for now.
    this.measuring = !this.elements.menu.hidden && isSingleImageFormat(this.format) && !this.problem()
    if (!this.measuring) return
    this.measureTimer = window.setTimeout(() => {
      void this.measureOf()
        .then((size) => {
          if (token !== this.measureToken) return
          this.measuring = false
          this.bytes = size
          // `drawOutcome`, not `draw`: the full pass would schedule another measurement from this
          // one's own result, and the two would take turns forever.
          this.drawOutcome()
        })
        .catch(() => {
          if (token !== this.measureToken) return
          // A failed encode leaves no number and no spinner: the row says the size it always said.
          this.measuring = false
          this.drawOutcome()
        })
    }, MEASURE_DELAY)
  }

  private changeFormat(format: ExportFormat): void {
    this.format = format
    void setExportFormat(format).catch(() => undefined)
    this.draw()
    this.onOptionsChange(format)
  }

  private change(patch: Partial<PdfOptions>): void {
    this.options = { ...this.options, ...patch }
    void setPdfOptions(this.options).catch(() => undefined)
    this.draw()
  }

  private draw(): void {
    this.scheduleMeasure()
    const { formats, panels, jpegQuality, jpegQualityOut, webpQuality, webpQualityOut } = this.elements
    for (const button of formats) {
      button.setAttribute('aria-pressed', String(button.dataset.format === this.format))
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== this.format

    for (const [slider, out] of [
      [jpegQuality, jpegQualityOut],
      [webpQuality, webpQualityOut],
    ] as const) {
      slider.value = String(this.jpegQuality)
      out.textContent = `${this.jpegQuality}%`
    }

    this.elements.scaleRow.hidden = !isSingleImageFormat(this.format)
    this.elements.scale.value = String(this.scale())
    this.drawOutcome()

    const { noText, text, links, split, customSize, pageSize, note } = this.elements
    // The boxes show what the file will be written with. While presenting that is the fixed one-page
    // set, not the stored choices, which stay untouched for when Present goes off: a disabled box
    // still ticked "Split to pages" described a split the presented PDF never does.
    const effective = this.presenting ? presentedPdfOptions(this.options) : this.options
    noText.checked = !effective.textSearchable
    text.checked = effective.textSearchable
    links.checked = effective.directLinks
    split.checked = effective.splitToPages
    customSize.checked = effective.pageSize !== 'fit'
    pageSize.hidden = effective.pageSize === 'fit'
    if (effective.pageSize !== 'fit') pageSize.value = effective.pageSize

    // A layer that needs page text is offered only where page text exists, and says why when it
    // does not -- a checkbox that is simply grey teaches the user nothing.
    text.disabled = !this.hasContent
    links.disabled = !this.hasContent
    noText.disabled = !this.hasContent
    // A presented PDF is always one page the shape of the framed picture, so the page options would
    // be controls that do nothing; they are shown, disabled, beside the sentence that says why.
    split.disabled = this.presenting
    customSize.disabled = this.presenting
    pageSize.disabled = this.presenting

    /*
     * Both of the sentences below describe the PDF, so both are gated on the PDF being the format.
     *
     * They used to be pushed for every format and filtered afterwards by `shown`, which took the
     * *last* message -- so on a format with no advice to give, the last one left was whichever PDF
     * sentence had been pushed, and it appeared under PNG and WebP. In the editor `hasContent` is
     * always false, so "Text and links could not be read from this page" was showing on every
     * format, every time. It belongs to PDF only.
     */
    const messages: string[] = []
    const pdf = this.format === 'pdf'
    if (pdf && this.presenting) messages.push('With Present on, the PDF is one page the size of the framed picture.')
    if (pdf && !this.hasContent) {
      // The recorded reason, where there is one. Only the genuinely unknowable case gets a general
      // explanation, and even that says what was true rather than why it might have been.
      messages.push(
        this.unavailableReason
          ? `Text and links could not be read from this page — ${this.unavailableReason}`
          : 'Text and links are read from the page itself, and this capture has none stored.',
      )
    }
    const limit = this.problem()
    if (this.format === 'pdf') {
      if (limit) messages.push(limit)
    } else if (!limit) {
      // Advice is withheld while the export is impossible. The page already carries that sentence,
      // and a tip about file size beside a refusal is noise at the moment it is least welcome --
      // one message at a time is the rule that keeps this menu from becoming a lecture.
      const crop = this.cropOf()
      const advice =
        crop &&
        exportAdvice({
          format: this.format,
          quality: this.jpegQuality,
          scale: this.scale(),
          hasText: this.hasContent,
          transparent: this.transparentOf(),
          width: crop.width,
          height: crop.height,
        })
      if (advice) messages.push(advice)
    }
    // Nothing left to filter: a non-PDF format can only have put advice here, and there is at most
    // one of those. The size limit for a raster format is shown on the page beside the picture it is
    // about, by `updateExportNote`.
    note.textContent = messages.join(' ')
    note.hidden = messages.length === 0 || messages[0] === undefined || messages[0] === ''
  }
}

/** Saves a blob through an anchor: no permission, no folder. Each surface decides when that is enough. */
export function saveWithAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

type MenuElements = ReturnType<typeof bindElements>

/**
 * Finds the menu's controls in the fragment. The fragment is one file, so the ids and data attributes
 * are listed once, here, rather than in every surface that includes it.
 */
function bindElements(root: ParentNode) {
  const one = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing ${selector}`)
    return element
  }
  const menu = one<HTMLElement>('#export-menu')
  return {
    toggle: one<HTMLButtonElement>('#export-options'),
    menu,
    formats: [...menu.querySelectorAll<HTMLButtonElement>('[data-format]')],
    panels: [...menu.querySelectorAll<HTMLElement>('[data-panel]')],
    jpegQuality: one<HTMLInputElement>('#jpeg-quality'),
    jpegQualityOut: one<HTMLElement>('#jpeg-quality-out'),
    webpQuality: one<HTMLInputElement>('#webp-quality'),
    webpQualityOut: one<HTMLElement>('#webp-quality-out'),
    scaleRow: one<HTMLElement>('#scale-row'),
    scale: one<HTMLSelectElement>('#export-scale'),
    outcome: one<HTMLElement>('#export-outcome'),
    outcomeSize: one<HTMLElement>('#export-outcome-size'),
    outcomeRatio: one<HTMLElement>('#export-outcome-ratio'),
    outcomeWeight: one<HTMLElement>('#export-outcome-weight'),
    outcomeWeightValue: one<HTMLElement>('#export-outcome-weight .weight-value'),
    ratioPart: one<SVGRectElement>('#ratio-part'),
    noText: one<HTMLInputElement>('#pdf-no-text'),
    text: one<HTMLInputElement>('#pdf-text'),
    links: one<HTMLInputElement>('#pdf-links'),
    split: one<HTMLInputElement>('#pdf-split'),
    customSize: one<HTMLInputElement>('#pdf-custom-size'),
    pageSize: one<HTMLSelectElement>('#pdf-page-size'),
    note: one<HTMLParagraphElement>('#export-menu-note'),
  }
}
