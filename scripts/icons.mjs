/**
 * Inlines Tabler Icons (MIT) into the built HTML.
 *
 * Markup names a glyph and nothing else:
 *
 *     <svg class="icon" data-icon="crop" viewBox="0 0 24 24" aria-hidden="true" focusable="false"></svg>
 *
 * and this step fills it with Tabler's paths on the way into `dist/`. The alternative -- pasting
 * path data into five HTML files by hand -- puts the same glyph in several places at once and
 * offers no way to notice when two of them drift. Naming the glyph also makes the markup readable:
 * `data-icon="trash"` says what the button does; a 90-character bezier does not.
 *
 * Nothing is fetched and nothing is bundled. `@tabler/icons` is a **dev** dependency read off disk
 * at build time, which is what keeps this inside the no-remote-code invariant. The
 * package is 49 MB and 5,130 glyphs; only the paths of the glyphs actually named ever reach `dist/`.
 *
 * Weight is not set here. Every glyph inherits `stroke-width` from `.icon` in `tokens.css`, which is
 * 2.0 on the 24 viewBox both sets share: Tabler's own design weight, after 1.6
 * looked faint.
 *
 * The editor's tool and shape glyphs come from Lucide (ISC) instead:
 * markup names them `data-icon="lucide:square"`. `lucide-static` is a dev dependency read off disk
 * the same way, so the invariant above holds for both sets.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readdir, writeFile } from 'node:fs/promises'

const OUTLINE = path.resolve(
  import.meta.dirname,
  '..',
  'node_modules',
  '@tabler',
  'icons',
  'icons',
  'outline',
)

/**
 * Tabler ships every glyph with a leading transparent square that exists only to pin the bounding
 * box. It draws nothing, and `.icon` sets `fill: none` anyway, so carrying it would add ~30 bytes
 * per glyph to say nothing at all.
 */
const BOUNDING_RECT = /<path\s+stroke="none"\s+d="M0 0h24v24H0z"\s+fill="none"\s*\/>/

/** `<svg …>` wrapper and everything outside it; what is left is the drawing itself. */
const SVG_BODY = /<svg\b[^>]*>([\s\S]*?)<\/svg>/

const cache = new Map()

/**
 * The inner paths of one Tabler outline glyph, whitespace collapsed onto a single line.
 *
 * Throws on an unknown name rather than emitting an empty glyph. A typo in `data-icon` should stop
 * the build loudly: an icon that silently renders as nothing is invisible in exactly the surfaces
 * -- a toolbar, a menu row -- where a missing glyph is hardest to spot after the fact.
 */
export async function tablerPaths(name) {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  let source
  try {
    source = await readFile(path.join(OUTLINE, `${name}.svg`), 'utf8')
  } catch {
    throw new Error(`Unknown Tabler icon "${name}". Check icons/outline for the exact file name.`)
  }

  const body = SVG_BODY.exec(source)?.[1]
  if (body === undefined) throw new Error(`Tabler icon "${name}" has no <svg> element`)

  const paths = body
    .replace(BOUNDING_RECT, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()
  if (!paths) throw new Error(`Tabler icon "${name}" is empty once its bounding rect is stripped`)

  cache.set(name, paths)
  return paths
}

const LUCIDE = path.resolve(import.meta.dirname, '..', 'node_modules', 'lucide-static', 'icons')

/** The prefix that names a Lucide glyph in markup: the editor's tool and shape icons. */
export const LUCIDE_PREFIX = 'lucide:'

/** The prefix that names one of the project's own glyphs. */
export const LOCAL_PREFIX = 'local:'

/**
 * The project's own glyphs, on the same 24 grid and stroke as Lucide's so they sit in the same dock.
 * The counter's "1" is a stroked path rather than a `<text>`: `.icon` turns fill off,
 * and a text glyph would draw in whatever font each machine happens to have.
 */
const LOCAL = {
  counter: '<circle cx="12" cy="12" r="10"/><path d="M10.5 9.5 12.5 8v8"/>',
  magnifier: '<circle cx="9" cy="15" r="5.3"/><path d="m12.54 11.46 4.19-4.19"/><circle cx="18" cy="6" r="1.8"/>',
}

/**
 * The inner elements of any named glyph: `local:` names from `LOCAL`, `lucide:` names from
 * `lucide-static`, every other name from Tabler. Lucide files carry a licence comment outside the `<svg>` and no bounding rect, so only the
 * wrapper comes off. Throws on an unknown name, for the same reason `tablerPaths` does.
 */
export async function glyphPaths(name) {
  if (name.startsWith(LOCAL_PREFIX)) {
    const paths = LOCAL[name.slice(LOCAL_PREFIX.length)]
    if (!paths) throw new Error(`Unknown local icon "${name}". Add it to LOCAL in scripts/icons.mjs.`)
    return paths
  }
  if (!name.startsWith(LUCIDE_PREFIX)) return tablerPaths(name)
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  const file = name.slice(LUCIDE_PREFIX.length)
  let source
  try {
    source = await readFile(path.join(LUCIDE, `${file}.svg`), 'utf8')
  } catch {
    throw new Error(`Unknown Lucide icon "${file}". Check lucide-static/icons for the exact file name.`)
  }

  const body = SVG_BODY.exec(source)?.[1]
  if (body === undefined) throw new Error(`Lucide icon "${file}" has no <svg> element`)
  const paths = body.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
  if (!paths) throw new Error(`Lucide icon "${file}" is empty`)

  cache.set(name, paths)
  return paths
}

/** An empty `<svg … data-icon="name" …></svg>`, which is the only form the markup ever writes. */
const PLACEHOLDER = /(<svg\b[^>]*\bdata-icon="([a-z0-9:-]+)"[^>]*>)\s*<\/svg>/g

/**
 * Fills every `data-icon` placeholder in one HTML string. Returns the markup and how many glyphs
 * were filled, so the build can report a number that would drop to zero if the attribute were ever
 * renamed out from under this step.
 */
export async function inlineIconsInHtml(html) {
  const names = [...html.matchAll(PLACEHOLDER)].map((match) => match[2])
  const paths = new Map(await Promise.all(names.map(async (n) => [n, await glyphPaths(n)])))
  return {
    html: html.replace(PLACEHOLDER, (_all, open, name) => `${open}${paths.get(name)}</svg>`),
    filled: names.length,
  }
}

/** Rewrites every `.html` directly inside `directory` in place. Returns the total glyphs filled. */
export async function inlineIcons(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue
    const file = path.join(directory, entry.name)
    const { html, filled } = await inlineIconsInHtml(await readFile(file, 'utf8'))
    if (filled) await writeFile(file, html)
    total += filled
  }
  return total
}
