import { deleteHistoryEntries, getHistoryPageContent, listHistory } from '../shared/capture-db'
import type { HistoryEntry } from '../shared/history'
import {
  deleteSelectedLabel,
  formatBytes,
  formatTimestamp,
  matchesHistoryQuery,
} from '../shared/history-policy'
import { pruneHistory } from '../shared/history-prune'
import { snippetFor } from '../shared/history-snippet'
import { applyStoredTheme, wireThemeButton } from '../shared/theme'

// Chrome follows the theme; the preference is read by every page and can be changed from any of
// them, so the button behaves identically here, in the popup, and on the result page.
void applyStoredTheme(document.documentElement)
wireThemeButton(requiredElement<HTMLButtonElement>('theme'), document.documentElement)

const list = requiredElement<HTMLUListElement>('history-list')
const summary = requiredElement<HTMLParagraphElement>('history-summary')
const empty = requiredElement<HTMLDivElement>('history-empty')
const emptyTitle = requiredElement<HTMLElement>('history-empty-title')
const emptyBody = requiredElement<HTMLSpanElement>('history-empty-body')
const search = requiredElement<HTMLInputElement>('history-search')
const searchClear = requiredElement<HTMLButtonElement>('search-clear')
const searchHotkey = requiredElement<HTMLElement>('search-hotkey')
const deleteSelected = requiredElement<HTMLButtonElement>('delete-selected')
/** The button's words, kept apart from its icon so rewriting one cannot remove the other. */
const deleteSelectedText = deleteSelected.querySelector('.button-label') ?? deleteSelected
const selectAllRow = requiredElement<HTMLDivElement>('select-all-row')
const selectAll = requiredElement<HTMLInputElement>('select-all')
const selectAllLabel = requiredElement<HTMLSpanElement>('select-all-label')
const storageLine = requiredElement<HTMLParagraphElement>('storage-line')
const resultHead = requiredElement<HTMLDivElement>('result-head')
const resultCopy = requiredElement<HTMLParagraphElement>('result-copy')
const sortSelect = requiredElement<HTMLSelectElement>('history-sort')
const hotkeyCommand = requiredElement<HTMLElement>('hotkey-command')
const hotkeyModifier = requiredElement<HTMLSpanElement>('hotkey-modifier')

/** Everything stored, newest first. The list on screen is this filtered by the search box. */
let entries: HistoryEntry[] = []
const selected = new Set<string>()
/** Object URLs for the thumbnails on screen, revoked whenever the list is rebuilt. */
let thumbnailUrls: string[] = []
/**
 * Rises on every redraw, so a snippet that arrives for a list that has since been retyped is
 * dropped instead of landing under the wrong row.
 */
let drawToken = 0
/**
 * Words already read back for an entry, so retyping does not re-read megabytes per keystroke. Held
 * to a handful of entries: this is a convenience for narrowing a search, not a second copy of the
 * database.
 */
const wordCache = new Map<string, string[]>()
const MAX_CACHED_ENTRIES = 12
/**
 * How many rows get a snippet. Each one is a read of that capture's harvested words, which are
 * megabytes where the entry itself is kilobytes -- so the rows someone is actually looking at get
 * one, and scrolling far enough to need more is not a case worth spending that on.
 */
const MAX_SNIPPET_ROWS = 12

void initialise()

async function initialise(): Promise<void> {
  search.addEventListener('input', draw)

  /*
   * Chrome's own cancel button is suppressed in `history.css`, so the clearing has to be ours. It is
   * hidden on an empty field rather than dimmed: a clear button with nothing to clear is a control
   * that does nothing, and `.search` is a flex row, so hiding it also closes the gap it was holding.
   */
  searchClear.addEventListener('click', () => {
    search.value = ''
    search.focus()
    draw()
  })
  sortSelect.addEventListener('change', draw)

  /*
   * The chip prints the binding for this platform and the page honours it, in that order: a chip
   * naming a shortcut that does nothing is worse than none. Mod+K focuses and selects, so a second
   * press retypes rather than appending, and Escape clears a search that is narrowing the list.
   */
  // The glyph is drawn, not typed: every other mark on these surfaces is a line SVG in the current
  // colour, and a text ⌘ would be the one that follows the system font instead. Off macOS there is
  // no glyph to draw, so the chip spells the modifier out.
  const mac = navigator.platform.toUpperCase().includes('MAC')
  hotkeyCommand.toggleAttribute('hidden', !mac)
  hotkeyModifier.hidden = mac
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'k' && (mac ? event.metaKey : event.ctrlKey)) {
      event.preventDefault()
      search.focus()
      search.select()
      return
    }
    if (event.key === 'Escape' && document.activeElement === search && search.value !== '') {
      search.value = ''
      draw()
    }
  })

  selectAll.addEventListener('change', () => {
    // Selects what is *visible*, not everything stored. A select-all that silently picked up rows
    // hidden by the search box would delete things the person never saw.
    for (const entry of visible()) {
      if (selectAll.checked) selected.add(entry.id)
      else selected.delete(entry.id)
    }
    draw()
  })
  deleteSelected.addEventListener('click', () => void removeSelected())

  await pruneHistory().catch(() => undefined)
  await reload()
}

async function reload(): Promise<void> {
  entries = await listHistory()
  // Anything that no longer exists cannot stay selected, or the count would promise a deletion that
  // has already happened.
  for (const id of [...selected]) if (!entries.some((entry) => entry.id === id)) selected.delete(id)
  draw()
}

function visible(): HistoryEntry[] {
  return sortEntries(
    entries.filter((entry) => matchesHistoryQuery(entry, search.value)),
    sortSelect.value,
  )
}

function draw(): void {
  for (const url of thumbnailUrls) URL.revokeObjectURL(url)
  thumbnailUrls = []
  list.replaceChildren()

  /*
   * The chip and the clear button share the trailing slot, and never both hold it. The chip
   * advertises the shortcut that *focuses* this field, so once there is something in the field the
   * hint is spent -- and it was standing between the cross and the edge of the control, which is the
   * one place a clear button is looked for. Every route that changes the query redraws, so deciding
   * both here is what keeps them from surviving each other.
   */
  const searching = search.value !== ''
  searchClear.hidden = !searching
  searchHotkey.hidden = searching

  const rows = visible()
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  const stored = `${entries.length} ${entries.length === 1 ? 'screenshot' : 'screenshots'} · ${formatBytes(bytes)}`
  summary.textContent =
    entries.length === 0
      ? 'Nothing stored'
      : rows.length === entries.length
        ? stored
        : `${rows.length} of ${stored}`
  // The sidebar reports what is on disk, never what the search box has narrowed it to: it is a
  // storage figure, and it should not move while someone types.
  storageLine.textContent = entries.length === 0 ? '' : stored

  deleteSelectedText.textContent = deleteSelectedLabel(selected.size)
  deleteSelected.disabled = selected.size === 0
  selectAllRow.hidden = rows.length === 0
  selectAll.checked = rows.length > 0 && rows.every((entry) => selected.has(entry.id))
  selectAllLabel.textContent = selectAll.checked ? 'Clear selection' : 'Select all'

  const message = emptyMessage()
  resultHead.hidden = rows.length === 0
  resultCopy.replaceChildren(...resultCopyParts(rows.length))

  if (rows.length === 0) {
    empty.hidden = false
    emptyTitle.textContent = message.title
    emptyBody.textContent = message.body
    return
  }
  empty.hidden = true

  const now = Date.now()
  for (const entry of rows) list.append(row(entry, now))

  drawToken += 1
  void fillSnippets(rows.slice(0, MAX_SNIPPET_ROWS), search.value, drawToken)
}

/**
 * Adds the matching sentence under each row, after the list is already on screen.
 *
 * Deliberately not part of `draw()`: the words behind a snippet are megabytes and live in their own
 * store, so waiting for them would make every keystroke stutter for a line of supporting evidence.
 * The list appears immediately and the snippets arrive under it.
 *
 * They come from the harvested runs rather than `entry.searchText`, which cannot answer this at all:
 * that index is deduplicated and lowercased, so nothing about it can be quoted back to anyone.
 */
async function fillSnippets(rows: HistoryEntry[], query: string, token: number): Promise<void> {
  if (query.trim() === '') return
  for (const entry of rows) {
    if (token !== drawToken) return
    const words = await entryWords(entry.id)
    if (token !== drawToken) return
    if (!words) continue
    const snippet = snippetFor(words, query)
    if (!snippet) continue
    const target = list.querySelector<HTMLElement>(`[data-snippet="${cssEscape(entry.id)}"]`)
    if (!target) continue
    const parts: (string | Node)[] = []
    if (snippet.clippedStart) parts.push(cut('…'))
    snippet.parts.forEach((part, index) => {
      if (index > 0) parts.push(' ')
      if (!part.match) {
        parts.push(part.text)
        return
      }
      const mark = document.createElement('mark')
      mark.textContent = part.text
      parts.push(mark)
    })
    if (snippet.clippedEnd) parts.push(cut('…'))
    target.replaceChildren(...parts)
    target.hidden = false
  }
}

function cut(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'cut'
  span.textContent = text
  return span
}

async function entryWords(entryId: string): Promise<string[] | undefined> {
  const cached = wordCache.get(entryId)
  if (cached) return cached
  const content = await getHistoryPageContent(entryId).catch(() => undefined)
  if (!content) return undefined
  const words = content.runs.map((run) => run.text)
  if (wordCache.size >= MAX_CACHED_ENTRIES) {
    const oldest = wordCache.keys().next().value
    if (oldest !== undefined) wordCache.delete(oldest)
  }
  wordCache.set(entryId, words)
  return words
}

/**
 * Ids are generated by `crypto.randomUUID`, so this is belt and braces rather than a live concern --
 * but a selector built from stored data is exactly the kind of thing that stops being safe later.
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

/**
 * Two lines, because the useful half is the second one.
 *
 * A search here reads the text *inside* each capture as well as its title and address, which is the
 * feature people are least likely to guess -- and the moment they are most likely to need telling is
 * the moment it found nothing.
 */
function emptyMessage(): { title: string; body: string } {
  if (entries.length === 0) {
    return {
      title: 'No screenshots yet.',
      body: 'Captures you take will appear here, and stay on this computer.',
    }
  }
  return {
    title: 'No captured page contains that text.',
    body: 'Try another word or phrase. Search checks the text inside each capture.',
  }
}

/** What the list is showing, said in words rather than left to the count in the header. */
function resultCopyParts(shown: number): Node[] {
  const query = search.value.trim()
  const count = document.createElement('strong')
  count.textContent = `${shown} ${shown === 1 ? 'capture' : 'captures'}`
  if (query === '') return [count, document.createTextNode(' stored on this computer')]
  const term = document.createElement('span')
  term.className = 'query'
  term.textContent = query
  return [count, document.createTextNode(' match '), term]
}

/**
 * The address, split into the parts the row shows separately.
 *
 * All three tolerate an entry with no address at all -- a capture of a page whose URL was never
 * recorded still has a title, and a row that printed "undefined" beside it would be worse than one
 * that prints nothing.
 */
function siteUrl(entry: HistoryEntry): URL | undefined {
  try {
    return entry.url ? new URL(entry.url) : undefined
  } catch {
    return undefined
  }
}

/** The host without `www.`, which is noise in a column of them. */
function siteHost(entry: HistoryEntry): string {
  return siteUrl(entry)?.hostname.replace(/^www\./, '') ?? ''
}

function sitePath(entry: HistoryEntry): string {
  const url = siteUrl(entry)
  if (!url) return entry.url ?? ''
  const path = `${url.pathname}${url.search}`
  return path === '/' ? '' : path
}

/** The monogram: the first letter of the site, or of the title when there is no address. */
function siteInitial(entry: HistoryEntry): string {
  const source = siteHost(entry) || entry.title
  return (source.trim()[0] ?? '?').toUpperCase()
}

/** What a title sort compares: the title, or the address when a page never gave one. */
function sortKey(entry: HistoryEntry): string {
  return (entry.title.trim() || entry.url || '').toLocaleLowerCase()
}

/**
 * The order the list is drawn in. Held in memory rather than saved: it is a way of looking at the
 * list right now, and persisting it would put a new key on disk for something that costs one click
 * to set again.
 */
function sortEntries(rows: HistoryEntry[], order: string): HistoryEntry[] {
  const sorted = [...rows]
  switch (order) {
    case 'oldest':
      return sorted.sort((a, b) => a.createdAt - b.createdAt)
    case 'largest':
      return sorted.sort((a, b) => b.bytes - a.bytes)
    case 'title':
      return sorted.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    default:
      return sorted.sort((a, b) => b.createdAt - a.createdAt)
  }
}


function row(entry: HistoryEntry, now: number): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'history-row'

  const tick = document.createElement('input')
  tick.type = 'checkbox'
  tick.className = 'history-tick'
  tick.checked = selected.has(entry.id)
  tick.setAttribute('aria-label', `Select ${entry.title}`)
  tick.addEventListener('change', () => {
    if (tick.checked) selected.add(entry.id)
    else selected.delete(entry.id)
    draw()
  })

  const thumb = document.createElement('div')
  thumb.className = 'history-thumb'
  if (entry.thumbnail) {
    const url = URL.createObjectURL(entry.thumbnail)
    thumbnailUrls.push(url)
    const image = document.createElement('img')
    image.src = url
    // Decorative: the title beside it already names the capture, so announcing the picture as well
    // would read the same row twice to a screen reader.
    image.alt = ''
    thumb.append(image)
  }

  /*
   * Left: what the capture *is*. Right: where and when it came from.
   *
   * The split is the point. Everything that identifies the page -- its mark, its title, its path --
   * reads as one block down the left, and the two facts that place it among a hundred others sit
   * apart on the right where the eye can run down them. Mixing the two, which is what this row used
   * to do, made every line equally important and so none of them scannable.
   *
   * A button rather than a link, because the destination is built from a stored id: an <a href> for
   * an entry that has since been deleted is a promise the page cannot keep.
   */
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'history-open'

  const heading = document.createElement('span')
  heading.className = 'history-heading'
  // A monogram, not a favicon: fetching one would mean reaching the network for every row, which is
  // a host permission this extension does not have and a promise about staying local it would break.
  const mark = document.createElement('span')
  mark.className = 'history-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = siteInitial(entry)
  const name = document.createElement('strong')
  name.textContent = entry.title
  heading.append(mark, name)

  // The path alone. The host is on the right, and printing the whole address here repeated it --
  // but two captures of the same site are still told apart by their path, so it stays.
  const address = document.createElement('span')
  address.className = 'history-path'
  address.textContent = sitePath(entry)
  address.title = entry.url ?? ''

  const description = document.createElement('span')
  description.className = 'history-detail'
  const pixels = entry.regionCrop
    ? `${entry.regionCrop.width.toLocaleString()} × ${entry.regionCrop.height.toLocaleString()} px`
    : `${entry.width.toLocaleString()} × ${entry.height.toLocaleString()} px`
  description.textContent =
    `${pixels} · ${formatBytes(entry.bytes)}${entry.regionCrop ? ' · selected region' : ''}`

  open.append(heading, address, description)
  open.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`result.html?job=${encodeURIComponent(entry.id)}`) })
  })

  const facts = document.createElement('div')
  facts.className = 'history-facts'
  const when = document.createElement('strong')
  when.className = 'history-when'
  when.textContent = formatTimestamp(entry.createdAt, now)
  const host = document.createElement('span')
  host.className = 'history-host'
  host.textContent = siteHost(entry)
  facts.append(when, host)

  // Empty and hidden until `fillSnippets` has something to put in it, which only ever happens while
  // a search is running.
  const snippet = document.createElement('p')
  snippet.className = 'history-snippet'
  snippet.dataset.snippet = entry.id
  snippet.hidden = true

  item.append(tick, thumb, open, facts, snippet)
  return item
}

async function removeSelected(): Promise<void> {
  if (selected.size === 0) return
  if (deleteSelected.dataset.confirming !== 'true') {
    deleteSelected.dataset.confirming = 'true'
    deleteSelectedText.textContent = `Delete ${selected.size}? Click again`
    window.setTimeout(() => {
      if (deleteSelected.dataset.confirming !== 'true') return
      delete deleteSelected.dataset.confirming
      draw()
    }, 4_000)
    return
  }
  delete deleteSelected.dataset.confirming
  await deleteHistoryEntries([...selected])
  selected.clear()
  await reload()
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element as T
}
