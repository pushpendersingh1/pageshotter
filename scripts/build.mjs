import { build, context } from 'esbuild'
import { watch as watchFiles } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { inlineIcons } from './icons.mjs'
import { buildTarget, manifestFor } from './targets.mjs'

const watch = process.argv.includes('--watch')
const root = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(root, 'public')
const { target, profile, outdir, esbuildTarget, minify } = buildTarget()

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
console.log(`Inlined ${await prepareAssets()} Tabler glyphs`)

/** Always from the original `public/` inputs, so a rerun never expands already-expanded markup. */
async function prepareAssets() {
  await cp(publicDir, outdir, { recursive: true })
  await injectHtmlFragments(outdir)
  await nameTheBrowser(outdir)
  await writeManifest(outdir)
  return inlineIcons(outdir)
}

/**
 * Pages say "Chrome" only inside an element marked with the profile field it stands for --
 * `<span data-browser="name">Chrome</span>` -- and this fills each one from the target's profile.
 * `public/` keeps Chrome's wording so the pages still read correctly when opened as they are.
 * `scripts/verify-pages.mjs` fails on any "Chrome" outside a marker.
 */
async function nameTheBrowser(directory) {
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith('.html')) continue
    const file = path.join(directory, entry)
    const html = await readFile(file, 'utf8')
    const named = html.replace(
      /<(\w+) data-browser="(\w+)">[^<]*<\/\1>/g,
      (_, tag, field) => {
        if (typeof profile[field] !== 'string') throw new Error(`${entry}: no browser field "${field}"`)
        return `<${tag} data-browser="${field}">${profile[field]}</${tag}>`
      },
    )
    if (named !== html) await writeFile(file, named)
  }
}

async function writeManifest(directory) {
  const file = path.join(directory, 'manifest.json')
  const original = JSON.parse(await readFile(file, 'utf8'))
  const manifest = manifestFor(target, original)
  // Untouched targets keep the file byte for byte, so Chrome's package never drifts on formatting.
  if (manifest !== original) await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function injectHtmlFragments(directory) {
  const menuPath = path.join(directory, 'export-menu.html')
  const menu = await readFile(menuPath, 'utf8')
  for (const page of ['result', 'editor']) {
    const file = path.join(directory, `${page}.html`)
    let html = await readFile(file, 'utf8')
    if (!html.includes('<!-- export-menu -->')) throw new Error(`${page}.html is missing the export-menu marker`)
    html = html.replace('<!-- export-menu -->', menu)
    await writeFile(file, html)
  }
  await rm(menuPath)
}

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/service-worker.ts',
    batch: 'src/batch/batch.ts',
    content: 'src/content/capture-session.ts',
    editor: 'src/editor/editor.ts',
    history: 'src/history/history.ts',
    popup: 'src/popup/popup.ts',
    result: 'src/result/result.ts',
    settings: 'src/settings/settings.ts',
    // Its own bundle on purpose: every page loads it from <head>, in front of the first paint.
    'theme-boot': 'src/shared/theme-boot.ts',
    welcome: 'src/welcome/welcome.ts',
  },
  outdir,
  bundle: true,
  entryNames: '[name]',
  format: 'iife',
  platform: 'browser',
  target: esbuildTarget,
  define: { __BROWSER_PROFILE__: JSON.stringify(profile) },
  sourcemap: watch,
  minify: minify && !watch,
  logLevel: 'info',
}

if (watch) {
  const buildContext = await context(options)
  await buildContext.watch()

  /*
   * esbuild watches only what it bundles, so CSS, pages, the export-menu fragment and icon markers
   * are re-prepared here. Debounced because one save is several events; chained so two runs never
   * write dist/ at once; a failure is logged rather than ending the watch.
   *
   * ponytail: any change re-copies all of public/, and a file deleted from public/ stays in dist/
   * until the next full build. Fine at this size; track deletions if dist/ ever misleads.
   */
  let queue = Promise.resolve()
  let timer
  watchFiles(publicDir, { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      queue = queue.then(prepareAssets).then(
        (glyphs) => console.log(`Assets rebuilt, inlined ${glyphs} Tabler glyphs`),
        (error) => console.error(`Asset rebuild failed: ${error.message}`),
      )
    }, 50)
  })
  /*
   * The browser profile is defined into the bundle and the build scripts are loaded once, so a
   * watcher that outlives a change to either keeps building with what it started with. That is how
   * an Edge build once shipped `__BROWSER_PROFILE__` undefined and every icon empty. Stopping loudly
   * beats a dist/ that looks current and is not.
   */
  for (const stale of [path.join(root, 'src/shared/browsers.json'), path.join(root, 'scripts')]) {
    watchFiles(stale, { recursive: true }, () => {
      console.error(`${path.relative(root, stale)} changed: restart \`npm run dev\` to build with it.`)
      process.exit(1)
    })
  }
  console.log('Watching extension sources...')
} else {
  await build(options)
}
