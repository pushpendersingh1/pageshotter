import { DEFAULT_EDITOR_DEFAULTS, applyToolDefaults, extractToolDefault, shapeTypeForDefaults, type DefaultsKey, type EditorDefaults } from './editor-defaults'
import { Inspector } from './inspector'
import { drawMagnifier, drawSampleShape } from './export-renderer'
import { emptyDoc, nodeFromDrag, type SceneDoc, type ShapeNode } from './scene'
import { PRESENT_GRADIENTS, type PresentOptions } from '../result/presentation-options'

interface DefaultsDialogHost {
  defaults(): EditorDefaults
  save(defaults: EditorDefaults): Promise<EditorDefaults>
  reset(): Promise<EditorDefaults>
  alert(message: string): void
}

/** What the nav lists, in order. `capture` and `present` edit the document defaults, not a shape. */
type Page = DefaultsKey | 'capture' | 'present'

const ANNOTATIONS: readonly DefaultsKey[] = ['rectangle', 'ellipse', 'arrow', 'line', 'text', 'highlight', 'blur', 'freehand', 'marker', 'counter', 'magnifier', 'emoji']

const LABELS: Record<Page, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  line: 'Line',
  text: 'Text',
  highlight: 'Highlight',
  blur: 'Blur',
  counter: 'Counter',
  magnifier: 'Magnifier',
  freehand: 'Pen',
  marker: 'Marker',
  emoji: 'Emoji',
  image: 'Image',
  capture: 'Canvas',
  present: 'Present',
}

const SUBS: Record<Page, string> = {
  rectangle: 'New rectangles start from these values.',
  ellipse: 'New ellipses start from these values.',
  arrow: 'New arrows start from these values.',
  line: 'New lines start from these values.',
  text: 'New text starts from these values.',
  highlight: 'New highlights start from these values.',
  blur: 'New blurs start from these values.',
  counter: 'New counter badges start from these values.',
  magnifier: 'New magnifiers start from these values.',
  freehand: 'New pen strokes start from these values.',
  marker: 'New marker strokes start from these values. A marker tints what is under it; a pen paints over it.',
  emoji: 'New emoji start from these values.',
  image: '',
  capture: 'What the background and margin are on a capture you have not touched.',
  present: 'What Present draws around a capture you have not touched. The address always comes from the captured page.',
}

/** The sample shape's box, in scene units at density 1 — big enough that a corner radius shows. */
const SAMPLE = { start: { x: 40, y: 32 }, end: { x: 260, y: 152 } }

/**
 * One place to see and edit every default.
 *
 * The controls are **the inspector's**: a sample shape is built from the same factory drawing uses,
 * the saved default is written over it, and an `Inspector` in `defaults` mode renders it. Every edit
 * lands on the sample, is read back out with `extractToolDefault`, and autosaves. Nothing about a
 * control is written twice, so the sheet and the panel cannot drift.
 */
export class EditorDefaultsDialog {
  private defaults: EditorDefaults
  private saveQueue = Promise.resolve()
  private page: Page = 'rectangle'
  /** The document the inspector reads: one sample node, or none when a capture page is open. */
  private sample: SceneDoc = emptyDoc(300, 190)
  /** The sample node, typed: `sample.nodes` is the document's loose list. */
  private node: ShapeNode | undefined
  private readonly inspector: Inspector

  private readonly dialog = requiredElement<HTMLDialogElement>('editor-defaults-dialog')
  private readonly confirm = requiredElement<HTMLDialogElement>('editor-defaults-reset-dialog')
  private readonly form = requiredElement<HTMLElement>('editor-defaults-form')
  private readonly nav = requiredElement<HTMLElement>('editor-defaults-nav')
  private readonly status = requiredElement<HTMLElement>('editor-defaults-status')
  private readonly title = requiredElement<HTMLElement>('editor-defaults-title')
  private readonly sub = requiredElement<HTMLElement>('editor-defaults-sub')
  private readonly preview = requiredElement<HTMLElement>('editor-defaults-preview')
  private readonly resetOne = requiredElement<HTMLButtonElement>('editor-defaults-reset-one')

  constructor(private readonly host: DefaultsDialogHost) {
    this.defaults = structuredClone(host.defaults())
    this.inspector = new Inspector(
      this.form,
      // The sheet has its own head, and none of its three parts belong to a default: there is
      // nothing to name, hide or delete. Detached elements keep the inspector's contract honest.
      {
        title: document.createElement('span'),
        hide: document.createElement('button'),
        remove: document.createElement('button'),
        sectionMenu: document.createElement('template'),
      },
      {
        doc: () => this.sample,
        selection: () => this.sample.nodes.map((node) => node.id),
        beginEdit: () => {},
        cancelEdit: () => {},
        changed: () => this.pull(),
        outputLabel: () => '',
        frameSelected: () => this.page === 'present',
        crop: () => undefined,
        cropChanged: () => {},
        clearCrop: () => {},
        toggleVisibility: () => {},
        deleteSelection: () => {},
        toolDefault: async () => false,
      },
      'defaults',
    )
    requiredElement<HTMLButtonElement>('editor-defaults').addEventListener('click', () => void this.open())
    requiredElement<HTMLButtonElement>('editor-defaults-close').addEventListener('click', () => this.dialog.close())
    this.resetOne.addEventListener('click', () => void this.resetPage())
    requiredElement<HTMLButtonElement>('editor-defaults-reset').addEventListener('click', () => {
      this.dialog.close()
      this.confirm.returnValue = ''
      this.confirm.showModal()
    })
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close()
    })
    this.confirm.addEventListener('close', () => void this.afterResetDecision())
    this.buildNav()
  }

  private async open(): Promise<void> {
    await this.saveQueue
    this.defaults = structuredClone(this.host.defaults())
    this.show(this.page)
    this.say('Changes save on this device as you make them.')
    this.dialog.showModal()
    // Without this the dialog autofocuses Close, which draws a focus ring on the way out of the
    // sheet before anything has been looked at. The page you are on is the right place to start.
    this.nav.querySelector<HTMLButtonElement>('.dd-nav-item[aria-pressed="true"]')?.focus()
  }

  private buildNav(): void {
    const groups: [string, readonly Page[]][] = [
      ['Annotations', ANNOTATIONS],
      ['Capture', ['capture', 'present']],
    ]
    for (const [label, pages] of groups) {
      const eyebrow = document.createElement('span')
      eyebrow.className = 'eyebrow'
      eyebrow.textContent = label
      this.nav.append(eyebrow)
      for (const page of pages) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dd-nav-item'
        button.dataset.page = page
        button.textContent = LABELS[page]
        button.addEventListener('click', () => this.show(page))
        this.nav.append(button)
      }
    }
  }

  /** Points the inspector at one page: a sample shape, or the sample document's own canvas. */
  private show(page: Page): void {
    this.page = page
    for (const button of this.nav.querySelectorAll<HTMLButtonElement>('.dd-nav-item')) {
      button.setAttribute('aria-pressed', String(button.dataset.page === page))
    }
    this.title.textContent = LABELS[page]
    this.sub.textContent = SUBS[page]
    this.resetOne.textContent = `Reset ${LABELS[page].toLowerCase()}`
    this.sample = emptyDoc(300, 190)
    this.node = undefined
    this.sample.canvas = { ...this.sample.canvas, ...this.defaults.canvas }
    this.sample.present = { ...this.sample.present, ...this.defaults.present, url: 'example.com' }
    if (page !== 'capture' && page !== 'present') {
      const node = nodeFromDrag(shapeTypeForDefaults(page), SAMPLE.start, SAMPLE.end, 1)
      if (node) {
        applyToolDefaults(node, this.defaults.tools[page], 1)
        // The Marker page's sample has to *be* a marker, or it previews as a pen stroke. `marker` is
        // not a defaultable key -- the tool decides it -- so the sample sets it the way the tool does.
        if (page === 'marker' && node.type === 'freehand') node.marker = true
        // The saved weight and head are the Line style's: a solid arrow's follow its length. So the
        // sample is a Line arrow, or its Weight and Head rows would have nothing to show.
        if (node.type === 'arrow') node.style = 'line'
        this.sample.nodes.push(node)
        this.node = node
      }
    }
    this.inspector.render()
    this.drawPreview()
  }

  /** Reads the sample back into the defaults after an inspector edit, then saves. */
  private pull(): void {
    const page = this.page
    if (page === 'capture' || page === 'present') {
      this.defaults.canvas = {
        background: this.sample.canvas.background,
        customColor: this.sample.canvas.customColor,
        margin: this.sample.canvas.margin,
      }
      const present: Partial<PresentOptions> = { ...this.sample.present }
      delete present.url
      this.defaults.present = present
    } else {
      const node = this.node
      if (node) this.defaults.tools[page] = extractToolDefault(node, 1)
    }
    this.save()
    this.inspector.render()
    this.drawPreview()
  }

  private async resetPage(): Promise<void> {
    const page = this.page
    if (page === 'capture' || page === 'present') {
      this.defaults.canvas = structuredClone(DEFAULT_EDITOR_DEFAULTS.canvas)
      this.defaults.present = structuredClone(DEFAULT_EDITOR_DEFAULTS.present)
    } else {
      this.defaults.tools[page] = structuredClone(DEFAULT_EDITOR_DEFAULTS.tools[page])
    }
    this.save()
    await this.saveQueue
    this.show(page)
  }

  private async afterResetDecision(): Promise<void> {
    if (this.confirm.returnValue === 'reset') {
      try {
        await this.saveQueue
        this.defaults = structuredClone(await this.host.reset())
        this.show(this.page)
        this.say('Factory defaults restored.', 'done')
        this.host.alert('Editor defaults were restored. Existing editor documents were not changed.')
      } catch {
        this.say('The defaults could not be reset.', 'problem')
        this.host.alert('Editor defaults could not be reset. Existing editor documents were not changed.')
      }
    }
    this.dialog.showModal()
  }

  /**
   * A mini page with the sample on it, so a number in the pane has something to be true of. Drawn in
   * CSS rather than on a canvas: the preview only has to show colour, weight, radius and opacity,
   * and a Konva stage for that would be a second renderer to keep honest.
   */
  private drawPreview(): void {
    const paper = this.preview.firstElementChild
    if (!(paper instanceof HTMLElement)) return
    paper.replaceChildren()

    // The capture defaults are the well and the page itself: background, margin, corners, shadow and
    // the frame bar. A shape default is what sits on top of them.
    const { background, customColor, margin } = this.sample.canvas
    const stops = background === 'none' || background === 'custom' ? undefined : PRESENT_GRADIENTS[background]
    // `none` means transparent, so the well wears the canvas's own checkerboard rather than a flat
    // colour -- a "Transparent" default drawn as solid dark says the opposite of what it is.
    this.preview.dataset.background = background
    this.preview.style.background = stops
      ? `linear-gradient(135deg,${stops.map((stop) => stop.color).join(',')})`
      : background === 'custom'
        ? customColor
        : ''
    this.preview.style.padding = `${Math.round(margin / 6)}px`
    const present = this.sample.present
    paper.style.borderRadius = `${present.corners}px`
    paper.style.boxShadow = present.shadow ? '0 1px 2px rgb(26 26 26 / .08), 0 8px 22px rgb(26 26 26 / .18)' : 'none'
    if (present.on) {
      const bar = document.createElement('i')
      bar.className = 'dd-chrome'
      bar.dataset.chrome = present.chrome
      paper.append(bar)
    }
    for (const top of [18, 34, 50]) {
      const line = document.createElement('i')
      line.className = 'dd-bar'
      line.style.top = `${top + (present.on ? 14 : 0)}px`
      line.style.width = `${top === 34 ? 168 : 116}px`
      paper.append(line)
    }

    const node = this.node
    if (!node) return
    if (node.type === 'freehand' || node.type === 'counter' || node.type === 'magnifier') {
      paper.append(sampleCanvas(node, present.on ? 14 : 0))
      return
    }
    const mark = document.createElement('span')
    mark.className = 'dd-mark'
    mark.dataset.type = node.type
    mark.style.opacity = String(node.opacity)
    if (node.type === 'rectangle' || node.type === 'ellipse') {
      mark.style.border = `${Math.max(1, node.strokeWidth)}px solid ${paint(node.stroke)}`
      mark.style.background = paint(node.fill)
      if (node.type === 'rectangle') mark.style.borderRadius = `${node.radius}px`
    }
    if (node.type === 'arrow' || node.type === 'line') {
      // Drawn as an SVG rather than out of CSS borders. A border-built head is laid out against the
      // padding box and sized in border widths, so its tip walked off the shaft as soon as the
      // weight changed; a line and a polygon are what Konva draws anyway.
      mark.append(segment(node.type === 'arrow' ? Math.max(4, node.headSize) : 0, Math.max(1, node.strokeWidth), paint(node.stroke)))
    }
    if (node.type === 'text') {
      mark.textContent = 'Most teams pick this'
      mark.style.color = paint(node.color)
      const family = node.fontFamily === undefined || node.fontFamily === '' ? 'var(--ui)' : node.fontFamily
      mark.style.font = `${node.italic === true ? 'italic ' : ''}${node.fontWeight} ${node.fontSize}px ${family}`
      mark.style.textAlign = node.align
      if (node.fill !== undefined) {
        // The filled box, without its pointer: the sample shows the look, not a placement.
        mark.style.background = paint(node.fill)
        mark.style.padding = `${node.fontSize * 0.2}px ${node.fontSize * 0.45}px`
        mark.style.borderRadius = `${node.fontSize * 0.3}px`
      }
      if (node.stroke !== 'none') {
        mark.style.setProperty('-webkit-text-stroke', `${node.strokeWidth / 2}px ${paint(node.stroke)}`)
      }
    }
    if (node.type === 'highlight') mark.style.background = paint(node.color)
    if (node.type === 'blur') mark.style.backdropFilter = `blur(${node.radius / 2}px)`
    if (node.type === 'emoji') {
      mark.textContent = '\u{1F642}'
      mark.style.fontSize = `${Math.min(64, node.fontSize)}px`
    }
    paper.append(mark)
  }

  private say(message: string, state?: 'done' | 'problem'): void {
    this.status.textContent = message
    if (state) this.status.dataset.state = state
    else delete this.status.dataset.state
  }

  private save(): void {
    const snapshot = structuredClone(this.defaults)
    this.say('Saving...')
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        this.defaults = structuredClone(await this.host.save(snapshot))
        this.say('Changes save on this device as you make them.')
      } catch {
        this.say('Could not save these defaults.', 'problem')
      }
    })
  }
}

/**
 * The sample line or arrow, drawn the way `preview-renderer` asks Konva to draw one: the pointer is
 * **filled and stroked** with the same ink and weight, which is why a heavier arrow has a bigger head
 * on the canvas. A flat filled triangle kept its size while the weight grew.
 */
function segment(head: number, weight: number, ink: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const length = 130
  // The stroke on the pointer adds half a weight all round, and its mitred apex a little more.
  const room = weight * 2
  const height = Math.max(weight, head + room) + 2
  const mid = height / 2
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(length + room))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${length + room} ${height}`)
  const tip = length - room / 2
  const shaft = document.createElementNS(ns, 'line')
  shaft.setAttribute('x1', '0')
  shaft.setAttribute('y1', String(mid))
  shaft.setAttribute('x2', String(tip))
  shaft.setAttribute('y2', String(mid))
  shaft.setAttribute('stroke', ink)
  shaft.setAttribute('stroke-width', String(weight))
  svg.append(shaft)
  if (head > 0) {
    const point = document.createElementNS(ns, 'polygon')
    point.setAttribute('points', `${tip},${mid} ${tip - head},${mid - head / 2} ${tip - head},${mid + head / 2}`)
    point.setAttribute('fill', ink)
    point.setAttribute('stroke', ink)
    point.setAttribute('stroke-width', String(weight))
    point.setAttribute('stroke-linejoin', 'miter')
    svg.append(point)
  }
  return svg
}

/** A colour a CSS preview can use: `none` means nothing is painted, not the word. */
function paint(value: unknown): string {
  return typeof value === 'string' && value !== 'none' ? value : 'transparent'
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element as T
}

/** The sample paper's size in CSS pixels (`.dd-paper`) and its grey text bars (`.dd-bar`). */
const PAPER = { width: 300, height: 112 }
const BARS = [
  { x: 22, y: 18, width: 116, height: 7 },
  { x: 22, y: 34, width: 168, height: 7 },
  { x: 22, y: 50, width: 116, height: 7 },
]

/**
 * The pen, marker, counter and magnifier samples, drawn by the export's own code on a canvas the
 * size of the paper. They had no CSS sample, so their pages showed an empty paper.
 * `drop` is how far the paper's bars sit below a Present bar.
 */
function sampleCanvas(node: ShapeNode, drop: number): HTMLCanvasElement {
  const ratio = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  canvas.className = 'dd-sample'
  canvas.width = PAPER.width * ratio
  canvas.height = PAPER.height * ratio
  canvas.style.opacity = String(node.opacity)
  const offscreen = new OffscreenCanvas(canvas.width, canvas.height)
  const context = offscreen.getContext('2d')
  if (!context) return canvas
  context.scale(ratio, ratio)
  if (node.type === 'freehand') {
    // A wave across the bars, so a marker is seen tinting them rather than painting over them.
    const points: number[] = []
    for (let step = 0; step <= 48; step += 1) points.push(step * 5, Math.sin((step / 48) * Math.PI * 2) * 16)
    drawSampleShape(context, { ...node, transform: { ...node.transform, x: 34, y: 44 + drop }, points })
    // The canvas cannot see the paper under it; the element blends with it as the stroke would.
    if (node.marker) canvas.style.mixBlendMode = 'multiply'
  } else if (node.type === 'counter') {
    drawSampleShape(context, { ...node, width: 40, height: 40, tip: { x: 20, y: 62 }, transform: { ...node.transform, x: 60, y: 18 + drop } })
  } else if (node.type === 'magnifier') {
    const bars = BARS.map((bar) => ({ ...bar, y: bar.y + drop }))
    const source = { x: 30, y: 30 + drop, width: 36, height: 26 }
    const zoom = 2.6
    const lens = { x: 170, y: 43 + drop - (source.height * zoom) / 2, width: source.width * zoom, height: source.height * zoom }
    drawMagnifier(context, node, source, lens, (target, into) => {
      // The paper under the source, drawn big: white, and the bars that cross it.
      target.fillStyle = '#FFFFFF'
      target.fillRect(into.x, into.y, into.width, into.height)
      target.fillStyle = '#E8EAEE'
      for (const bar of bars) {
        target.fillRect(into.x + (bar.x - source.x) * zoom, into.y + (bar.y - source.y) * zoom, bar.width * zoom, bar.height * zoom)
      }
    })
  }
  canvas.getContext('2d')?.drawImage(offscreen, 0, 0)
  return canvas
}
