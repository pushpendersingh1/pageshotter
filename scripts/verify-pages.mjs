import { readFile } from 'node:fs/promises'
import { glyphPaths } from './icons.mjs'

/*
 * Checks on the extension's shipped HTML that the test suite cannot make: Vitest runs in plain Node
 * with no DOM, so properties of markup -- and markup agreeing with source -- are asserted here.
 */
const failures = []

/*
 * `theme-boot.js` has one job: stamp the stored palette before the first paint, so a browser whose
 * OS says dark does not flash dark on every navigation for someone who chose light. It only does
 * that job if it is loaded *blocking* and *ahead of the stylesheets* -- add `defer`, or move it
 * below the first `<link>`, and it runs after the paint it exists to precede. The bug then looks
 * exactly like the fix, which is why this is asserted rather than remembered.
 */
const extensionPages = ['popup', 'result', 'editor', 'history', 'settings', 'welcome']
/**
 * The subset whose scripts require the control. welcome.html deliberately has none, and the popup
 * and settings page have none either: settings offers the choice as a field, and the popup follows it.
 */
const themeButtonPages = ['result', 'history']
for (const page of extensionPages) {
  const html = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8')
  const script = html.indexOf('<script src="theme-boot.js"></script>')
  const firstStylesheet = html.indexOf('<link rel="stylesheet"')
  if (script === -1) {
    failures.push(`${page}.html: must load theme-boot.js, or it flashes the wrong palette`)
  } else if (firstStylesheet !== -1 && script > firstStylesheet) {
    failures.push(`${page}.html: theme-boot.js must come before the first stylesheet`)
  }
  if (/<script[^>]*theme-boot[^>]*(defer|async|type="module")/.test(html)) {
    failures.push(`${page}.html: theme-boot.js must be a blocking classic script`)
  }
  /*
   * Every page whose script calls `wireThemeButton` looks up `#theme` with `requiredElement`, which
   * throws when it is missing -- and a throw at the top of the module leaves the whole page dead,
   * not merely unthemed. Moving that button between the sidebar and the top bar is exactly the edit
   * that drops it, and `npm run verify` was green with it gone from history.html. Nothing else in
   * the suite can see it: the pages have no DOM in the tests.
   */
  if (themeButtonPages.includes(page)) {
    const buttons = html.match(/id="theme"/g)?.length ?? 0
    if (buttons !== 1) {
      failures.push(`${page}.html: needs exactly one id="theme" control, found ${buttons}`)
    }
  }
}

/*
 * Every `.grouped-tool` in the dock is wired by `wireFlyout`, which reaches for `.tool-caret`,
 * `.group-main` and `.tool-flyout` with `requiredChild` -- and that throws at module top level, so a
 * single mistyped class name leaves the **whole editor dead**, not merely one flyout unopenable.
 *
 * This is not hypothetical: adding the Pen/Marker group with `class="group-caret"` instead of
 * `class="tool-caret"` shipped past a green `npm run verify` and threw `Missing .tool-caret` on
 * load. Nothing else in the suite can see it -- the tests have no DOM, and the glyph check only
 * reads icon names. Same reason, and same shape, as the `id="theme"` check above.
 */
{
  const html = await readFile(new URL('../public/editor.html', import.meta.url), 'utf8')
  const required = ['tool-caret', 'group-main', 'tool-flyout']
  const groups = [...html.matchAll(/data-tool-group="([^"]+)"/g)]
  if (groups.length === 0) failures.push('editor.html: no .grouped-tool in the dock, which cannot be right')
  for (const [index, group] of groups.entries()) {
    const start = group.index
    const end = groups[index + 1]?.index ?? html.length
    const block = html.slice(start, end)
    for (const part of required) {
      if (!block.includes(`class="${part}"`) && !block.includes(`${part}"`)) {
        failures.push(`editor.html: the "${group[1]}" tool group has no .${part}, so wireFlyout throws and the editor never loads`)
      }
    }
  }
  /*
   * Every dock button's tool must be one the editor knows. A `data-tool` the key map and `DRAW_TOOLS`
   * have never heard of is a button that silently does nothing -- the quiet twin of the throw above.
   */
  const editorSource = await readFile(new URL('../src/editor/editor.ts', import.meta.url), 'utf8')
  for (const match of html.matchAll(/data-tool="([^"]+)"/g)) {
    const tool = match[1]
    if (!new RegExp(`'${tool}'|\\b${tool}: true`).test(editorSource)) {
      failures.push(`editor.html: dock button data-tool="${tool}" is not a tool editor.ts knows`)
    }
  }
}

/*
 * The result page names the long-page setting so a reader can go and change it, and it takes the
 * name from a constant. A settings page whose label has drifted from that constant sends the reader
 * hunting for a control that does not exist under that name -- and nothing in the test suite can
 * see it, because the pages have no DOM there and the label lives in markup.
 */
{
  const source = await readFile(new URL('../src/shared/capture-depth.ts', import.meta.url), 'utf8')
  const label = source.match(/LONG_PAGE_SETTING_LABEL = '([^']+)'/)?.[1]
  if (!label) {
    failures.push('capture-depth.ts: LONG_PAGE_SETTING_LABEL is gone, so the notice cannot name the setting')
  } else {
    const markup = await readFile(new URL('../public/settings.html', import.meta.url), 'utf8')
    if (!markup.includes(label)) {
      failures.push(`settings.html: no label reads "${label}", which is what the result page tells readers to look for`)
    }
  }
}

/*
 * Icons.
 *
 * Every glyph is named in the markup (`data-icon="trash"`) and filled from Tabler by
 * `scripts/icons.mjs` on the way into `dist/`. Three things have to stay true for that to keep
 * working, and none of them is visible to the test suite -- the pages have no DOM there, and these
 * are properties of markup rather than of a pure function.
 */
{
  const iconPages = [...extensionPages, 'export-menu']
  for (const page of iconPages) {
    const html = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8')

    /*
     * 1. Every `.icon` is empty. Pasting path data back into the HTML would render -- and would put
     * that glyph beyond every check here, including the one below that notices a Tabler rename.
     * One source of path data or none.
     */
    for (const [, body] of html.matchAll(/<svg\b[^>]*\bclass="icon"[^>]*>([\s\S]*?)<\/svg>/g)) {
      if (body.trim()) {
        failures.push(`${page}.html: an .icon carries inline path data; name it with data-icon instead`)
        break
      }
    }

    /*
     * 2. Every `.icon` names a glyph and sits on Tabler's 24 viewBox. A 16 viewBox left behind
     * renders the glyph at 1.5x the intended weight, which reads as a different icon set on the
     * same screen -- the exact mismatch the move to one viewBox was made to avoid.
     */
    for (const [, attrs] of html.matchAll(/<svg\b([^>]*\bclass="icon"[^>]*)>/g)) {
      if (!/data-icon="/.test(attrs)) {
        failures.push(`${page}.html: an .icon has no data-icon, so the build cannot fill it`)
      } else if (!attrs.includes('viewBox="0 0 24 24"')) {
        const name = /data-icon="([a-z0-9:-]+)"/.exec(attrs)?.[1]
        failures.push(`${page}.html: data-icon="${name}" is not on a 24 viewBox`)
      }
    }

    /*
     * 3. Every name resolves. The build throws too, but failing here names the page and the glyph,
     * and this is what catches an icon disappearing under a `@tabler/icons` upgrade.
     */
    for (const [, name] of html.matchAll(/data-icon="([a-z0-9:-]+)"/g)) {
      try {
        const paths = await glyphPaths(name)
        if (paths.includes('stroke="none"')) {
          failures.push(`${page}.html: data-icon="${name}" still carries Tabler's transparent bounding rect`)
        }
      } catch (error) {
        failures.push(`${page}.html: ${error.message}`)
      }
    }
  }

  /* And an unknown name must stop the build rather than render as nothing, in either set. */
  for (const unknown of ['pageshotter-not-a-real-icon', 'lucide:pageshotter-not-a-real-icon']) {
    await glyphPaths(unknown).then(
      () => failures.push(`icons.mjs: an unknown glyph "${unknown}" resolved instead of throwing`),
      () => {},
    )
  }
}

/*
 * The browser's name.
 *
 * The same pages ship to more than one browser, and the build names the right one only inside a
 * `data-browser` marker. A bare "Chrome" in the text would reach Edge users unchanged, so outside
 * comments and markers the word -- and a `chrome://` address -- fails the check. Every profile also
 * has to carry each field a marker asks for, or the build stops on that target alone.
 */
{
  const browsers = JSON.parse(await readFile(new URL('../src/shared/browsers.json', import.meta.url), 'utf8'))
  for (const page of [...extensionPages, 'export-menu']) {
    const html = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8')
    for (const [, , field] of html.matchAll(/<(\w+) data-browser="(\w+)">[^<]*<\/\1>/g)) {
      for (const [target, profile] of Object.entries(browsers)) {
        if (typeof profile[field] !== 'string') {
          failures.push(`${page}.html: data-browser="${field}" has no "${field}" in the ${target} profile`)
        }
      }
    }
    const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(\w+) data-browser="\w+">[^<]*<\/\1>/g, '')
    for (const [match] of text.matchAll(/\bChrome\b|chrome:\/\//g)) {
      failures.push(`${page}.html: "${match}" outside a data-browser marker would reach other browsers`)
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log(
    `Page checks passed: ${extensionPages.length} extension pages boot their theme before first paint, ` +
      `every named Tabler and Lucide glyph resolves, and the browser is named only through markers.`,
  )
}
