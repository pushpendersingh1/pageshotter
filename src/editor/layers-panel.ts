/**
 * The layers panel: rows, drag-to-reorder and selection.
 *
 * The single largest piece of UI work in the editor. Two rules shape everything below:
 *
 * **1. Structure and state are separate functions, and hover is state.** `structure()` rebuilds the
 * rows; it runs on reorder, visibility and expansion, and on nothing else. `state()` only ever adds
 * and removes classes. Rebuilding the panel on hover destroys the node under the cursor, which
 * re-fires `pointerover`, which rebuilds again — a loop that froze the tab while the prototype for
 * that document was being built. It is a constraint on this editor too, so the split is structural
 * rather than a discipline to remember.
 *
 * **2. The drag is pointer-based, not HTML5 drag-and-drop.** HTML5 DnD cannot render a custom drop
 * indicator reliably, has no useful control over the drag image, and behaves differently across
 * platforms. The panel captures the pointer instead.
 *
 * Every number this file needs — the row height, the indent, the 8/12/8 drop bands, the depth cap,
 * the display order — comes from `scene`. That is the scene module's rule applied to a panel rather than a
 * renderer: a surface that computes its own geometry is a second source of truth.
 */
import {
  LAYER_ROW_HEIGHT,
  canDrop,
  dropPositionFor,
  findNode,
  isGroupNode,
  layerRows,
  moveNode,
  nodePath,
  type DropPosition,
  type KnownNode,
  type LayerRow,
  type SceneDoc,
} from './scene'

/** A collapsed group auto-expands after 500ms of hover, so a deep drop is one gesture. */
const AUTO_EXPAND_MS = 500

/** The list auto-scrolls when the pointer is within 24px of an edge, proportionally to how far in. */
const AUTOSCROLL_EDGE = 24
const AUTOSCROLL_MAX = 14
const AUTOSCROLL_TICK = 16

/** Below this the gesture is a click, not a drag. A row is 28px tall; 4px is a twitch. */
const DRAG_THRESHOLD = 4

export interface LayersHost {
  doc(): SceneDoc | undefined
  selection(): readonly string[]
  /** A panel click, range or arrow key. The editor stores the selection and calls `state()` back. */
  select(ids: string[]): void
  /** Bidirectional hover: the canvas outlines this node. `undefined` clears it. */
  hover(id: string | undefined): void
  /** Snapshot for undo, called exactly once per user gesture before the tree is touched. */
  beginEdit(): void
  /** The tree changed: the editor re-renders the canvas and calls `structure()` back. */
  changed(): void
  /** Whether the pinned Frame row is what is selected. */
  frameSelected(): boolean
  selectFrame(): void
}

interface Drag {
  id: string
  pointerId: number
  startY: number
  moved: boolean
  target?: { id: string; position: DropPosition }
  expandCandidate?: string
  expandAt?: number
}

export class LayersPanel {
  private rows: LayerRow[] = []
  private readonly elements = new Map<string, HTMLElement>()
  private readonly collapsed = new Set<string>()
  private hovered: string | undefined
  private anchor: string | undefined
  private drag: Drag | undefined
  private scroller = 0
  private renaming = false

  constructor(
    private readonly list: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly frameRow: HTMLElement,
    private readonly template: HTMLTemplateElement,
    private readonly icons: HTMLElement,
    /** The panel's own header readouts, and the size on the pinned Capture row. */
    private readonly head: { size: HTMLElement },
    private readonly host: LayersHost,
  ) {
    this.wire()
  }

  /** Rebuilds every row. Reorder, visibility and expansion only — never hover, never selection. */
  structure(): void {
    const doc = this.host.doc()
    if (!doc) return
    this.rows = layerRows(doc, this.collapsed)
    this.elements.clear()
    this.list.replaceChildren(...this.rows.map((row) => this.rowElement(row)))
    this.empty.hidden = this.rows.length > 0
    this.list.hidden = this.rows.length === 0
    this.head.size.textContent = `${doc.capture.width.toLocaleString()} \u00d7 ${doc.capture.height.toLocaleString()}`
    this.state()
  }

  /** Classes only. Selection, hover and the drop indicator all live here. */
  state(): void {
    const selected = new Set(this.host.selection())
    const drop = this.drag?.target
    for (const row of this.rows) {
      const element = this.elements.get(row.id)
      // `continue`, not `return`: this was a `forEach` callback, where `return` skipped one row. In a
      // loop it would abandon every row after the first miss, leaving their classes stale.
      if (!element) continue
      element.classList.toggle('is-selected', selected.has(row.id))
      element.setAttribute('aria-selected', String(selected.has(row.id)))
      element.classList.toggle('is-hovered', row.id === this.hovered)
      element.classList.toggle('is-dragging', this.drag?.moved === true && row.id === this.drag.id)
      element.classList.toggle('drop-before', drop?.id === row.id && drop.position === 'before')
      element.classList.toggle('drop-after', drop?.id === row.id && drop.position === 'after')
      element.classList.toggle('drop-into', drop?.id === row.id && drop.position === 'inside')
    }
    /*
     * Lit only when it has actually been clicked.
     *
     * It used to light whenever nothing else was selected, because for one commit an empty selection
     * and this row put the same thing in the inspector. They do not any more -- an empty selection
     * is the canvas and this row is the frame -- and lighting it for the canvas made the row look
     * already chosen, so clicking it appeared to do nothing. That is how Present became unfindable
     * from the panel.
     */
    this.frameRow.setAttribute('aria-pressed', String(this.host.frameSelected()))
  }

  /** A canvas hover, pointing the other way. Class work only. */
  setHovered(id: string | undefined): void {
    if (this.hovered === id) return
    this.hovered = id
    this.state()
  }

  /** The rows currently displayed, top-most first. The editor's arrow keys walk this. */
  displayed(): readonly LayerRow[] {
    return this.rows
  }

  private rowElement(row: LayerRow): HTMLElement {
    const element = this.template.content.firstElementChild?.cloneNode(true) as HTMLElement
    element.dataset.id = row.id
    element.style.setProperty('--depth', String(row.depth))
    element.title = row.name

    const chevron = requiredChild<HTMLButtonElement>(element, '.row-chevron')
    // A childless row keeps the chevron's cell and hides its glyph. Removing the element collapses
    // its grid column and drags the name, eye and lock 24px left — the name belongs on one vertical
    // line whatever the type, so what a leaf row gets is a 12px spacer, not one less column.
    chevron.classList.toggle('is-empty', !row.hasChildren)
    chevron.classList.toggle('is-open', row.expanded)
    chevron.setAttribute('aria-label', row.expanded ? 'Collapse group' : 'Expand group')

    const glyph = this.icons.querySelector(`[data-type="${row.node.type}"]`)
    if (glyph) requiredChild<HTMLElement>(element, '.row-type').replaceChildren(glyph.cloneNode(true))

    requiredChild<HTMLElement>(element, '.row-name').textContent = row.name

    // Eye and lock appear on hover and stay visible once set, or the panel lies about the state.
    const hidden = row.node.hidden === true
    const locked = row.node.locked === true
    const eye = requiredChild<HTMLButtonElement>(element, '.row-eye')
    eye.classList.toggle('is-set', hidden)
    // Which glyph shows is CSS keyed on `is-set`: `.hidden` is an HTMLElement property, so setting it
    // on an SVG is a no-op expando and both eyes rendered together.
    eye.setAttribute('aria-label', hidden ? 'Show layer' : 'Hide layer')
    const lock = requiredChild<HTMLButtonElement>(element, '.row-lock')
    lock.classList.toggle('is-set', locked)
    lock.setAttribute('aria-label', locked ? 'Unlock layer' : 'Lock layer')
    element.classList.toggle('is-hidden-layer', hidden)

    this.elements.set(row.id, element)
    return element
  }

  private wire(): void {
    this.list.addEventListener('click', (event) => this.onClick(event))
    this.list.addEventListener('dblclick', (event) => this.onDoubleClick(event))
    this.list.addEventListener('pointerover', (event) => this.onPointerOver(event))
    this.list.addEventListener('pointerleave', () => this.setHover(undefined))
    this.list.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.list.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.list.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.list.addEventListener('pointercancel', () => this.endDrag(false))
    this.list.addEventListener('keydown', (event) => this.onKeyDown(event))
    this.frameRow.addEventListener('click', () => this.host.selectFrame())
  }

  private rowAt(target: EventTarget | null): LayerRow | undefined {
    const element = target instanceof Element ? target.closest<HTMLElement>('.layer-row') : null
    const id = element?.dataset.id
    return id === undefined ? undefined : this.rows.find((row) => row.id === id)
  }

  private setHover(id: string | undefined): void {
    if (this.hovered === id) return
    this.hovered = id
    this.host.hover(id)
    this.state()
  }

  private onPointerOver(event: PointerEvent): void {
    if (this.drag) return
    this.setHover(this.rowAt(event.target)?.id)
  }

  private onClick(event: MouseEvent): void {
    const row = this.rowAt(event.target)
    if (!row || this.drag?.moved === true) return
    const target = event.target as HTMLElement
    if (target.closest('.row-chevron')) {
      this.setExpanded(row.id, this.collapsed.has(row.id))
      return
    }
    if (target.closest('.row-eye')) return this.toggleFlag(row.node, 'hidden')
    if (target.closest('.row-lock')) return this.toggleFlag(row.node, 'locked')
    this.selectFromClick(row, event)
  }

  /** Click selects; Shift takes the range in display order; Cmd/Ctrl toggles one row. */
  private selectFromClick(row: LayerRow, event: MouseEvent): void {
    const current = [...this.host.selection()]
    if (event.shiftKey && this.anchor !== undefined) {
      const from = this.rows.findIndex((candidate) => candidate.id === this.anchor)
      const to = this.rows.findIndex((candidate) => candidate.id === row.id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        this.host.select(this.rows.slice(start, end + 1).map((candidate) => candidate.id))
        return
      }
    }
    if (event.metaKey || event.ctrlKey) {
      this.anchor = row.id
      this.host.select(current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])
      return
    }
    this.anchor = row.id
    this.host.select([row.id])
  }

  private setExpanded(id: string, expanded: boolean): void {
    if (expanded) this.collapsed.delete(id)
    else this.collapsed.add(id)
    this.structure()
  }

  private toggleFlag(node: KnownNode, flag: 'hidden' | 'locked'): void {
    this.host.beginEdit()
    node[flag] = node[flag] !== true
    // Hiding a node changes the bounds, so this is a document change and not only a row class.
    this.host.changed()
  }

  private onDoubleClick(event: MouseEvent): void {
    const row = this.rowAt(event.target)
    if (!row || !(event.target as HTMLElement).closest('.row-name')) return
    this.beginRename(row)
  }

  /**
   * Renaming happens in an input over the row, and commits as **one** undo step containing the whole
   * edit rather than one per keystroke.
   */
  private beginRename(row: LayerRow): void {
    const element = this.elements.get(row.id)
    const name = element?.querySelector<HTMLElement>('.row-name')
    if (!element || !name || this.renaming) return
    this.renaming = true
    const input = document.createElement('input')
    input.className = 'row-rename'
    input.value = row.name
    input.spellcheck = false
    name.replaceChildren(input)
    input.focus()
    input.select()

    let settled = false
    const finish = (commit: boolean): void => {
      if (settled) return
      settled = true
      this.renaming = false
      const value = input.value.trim()
      if (commit && value !== '' && value !== row.name) {
        this.host.beginEdit()
        row.node.name = value
        this.host.changed()
        return
      }
      this.structure()
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') finish(true)
      if (event.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.renaming) return
    const selection = this.host.selection()
    const current = this.rows.findIndex((row) => row.id === selection.at(-1))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = this.rows[Math.min(this.rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (!next) return
      this.anchor = next.id
      this.host.select([next.id])
      this.elements.get(next.id)?.scrollIntoView({ block: 'nearest' })
      return
    }
    const row = this.rows[current]
    if (!row) return
    if (event.key === 'ArrowRight' && row.hasChildren && !row.expanded) {
      event.preventDefault()
      this.setExpanded(row.id, true)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.hasChildren && row.expanded) this.setExpanded(row.id, false)
      else if (row.parentId !== undefined) this.host.select([row.parentId])
    }
  }

  // --- the drag ---------------------------------------------------------------

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.renaming) return
    const row = this.rowAt(event.target)
    if (!row || (event.target as HTMLElement).closest('button')) return
    this.drag = { id: row.id, pointerId: event.pointerId, startY: event.clientY, moved: false }
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.moved) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return
      drag.moved = true
      this.list.setPointerCapture(event.pointerId)
      this.list.classList.add('is-dragging-rows')
    }
    event.preventDefault()
    this.autoScroll(event.clientY)
    drag.target = this.dropTarget(drag.id, event.clientY)
    this.considerAutoExpand(drag)
    this.state()
  }

  /** Which row the pointer is over, and which of the two operations its band asks for. */
  private dropTarget(dragId: string, clientY: number): { id: string; position: DropPosition } | undefined {
    const doc = this.host.doc()
    if (!doc) return undefined
    for (const row of this.rows) {
      const element = this.elements.get(row.id)
      if (!element) continue
      const box = element.getBoundingClientRect()
      if (clientY < box.top || clientY >= box.bottom) continue
      // The bands are specified against a 28px row; a zoomed page must not move them.
      const offsetY = ((clientY - box.top) / (box.height || LAYER_ROW_HEIGHT)) * LAYER_ROW_HEIGHT
      const position = dropPositionFor(offsetY, row.isGroup)
      // A refused drop shows no indicator at all, rather than one the drop then rejects.
      return canDrop(doc.nodes, dragId, row.id, position) ? { id: row.id, position } : undefined
    }
    return undefined
  }

  private considerAutoExpand(drag: Drag): void {
    const target = drag.target
    const candidate = target?.position === 'inside' && this.collapsed.has(target.id) ? target.id : undefined
    if (candidate !== drag.expandCandidate) {
      drag.expandCandidate = candidate
      drag.expandAt = candidate === undefined ? undefined : Date.now() + AUTO_EXPAND_MS
      return
    }
    if (candidate === undefined || drag.expandAt === undefined || Date.now() < drag.expandAt) return
    drag.expandCandidate = undefined
    drag.expandAt = undefined
    this.setExpanded(candidate, true)
  }

  private autoScroll(clientY: number): void {
    const box = this.list.getBoundingClientRect()
    const above = box.top + AUTOSCROLL_EDGE - clientY
    const below = clientY - (box.bottom - AUTOSCROLL_EDGE)
    const step = above > 0 ? -rate(above) : below > 0 ? rate(below) : 0
    if (step === 0) {
      this.stopScrolling()
      return
    }
    if (this.scroller !== 0) return
    // An interval rather than rAF: the scroll must continue while the pointer is held still, and a
    // pointermove-driven scroll stops the moment the pointer does.
    this.scroller = window.setInterval(() => {
      this.list.scrollTop += step
    }, AUTOSCROLL_TICK)
  }

  private stopScrolling(): void {
    if (this.scroller === 0) return
    window.clearInterval(this.scroller)
    this.scroller = 0
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return
    this.endDrag(true)
  }

  private endDrag(commit: boolean): void {
    const drag = this.drag
    this.stopScrolling()
    this.list.classList.remove('is-dragging-rows')
    if (!drag) return
    const doc = this.host.doc()
    const target = drag.target
    this.drag = undefined
    if (!commit || !drag.moved || !target || !doc) {
      this.state()
      return
    }
    this.host.beginEdit()
    // A group drag takes its children with it, and the whole move is one undo step, because the
    // children hang off the node being moved rather than being moved themselves.
    if (moveNode(doc.nodes, drag.id, target.id, target.position)) this.host.changed()
    else this.state()
  }

  /** Expands every ancestor of `id` so a canvas selection is visible in the panel. */
  revealAncestors(id: string): void {
    const doc = this.host.doc()
    const path = doc ? nodePath(doc.nodes, id) : undefined
    if (!path) return
    let opened = false
    for (const ancestor of path.slice(0, -1)) {
      if (isGroupNode(ancestor) && this.collapsed.delete(ancestor.id)) opened = true
    }
    if (opened) this.structure()
  }

  /** True when the id is one the panel can show — the editor guards canvas selection with it. */
  has(id: string): boolean {
    const doc = this.host.doc()
    return doc !== undefined && findNode(doc.nodes, id) !== undefined
  }
}

function rate(distance: number): number {
  return Math.min(AUTOSCROLL_MAX, Math.max(2, Math.round(distance / 2)))
}

function requiredChild<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element as T
}
