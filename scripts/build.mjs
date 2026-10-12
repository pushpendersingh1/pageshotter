import { build, context } from 'esbuild'
import { watch as watchFiles } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { inlineIcons } from './icons.mjs'

const watch = process.argv.includes('--watch')
const root = path.resolve(import.meta.dirname, '..')
const publicDir = path.join(root, 'public')
const outdir = path.join(root, 'dist')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
console.log(`Inlined ${await prepareAssets()} Tabler glyphs`)

/** Always from the original `public/` inputs, so a rerun never expands already-expanded markup. */
async function prepareAssets() {
  await cp(publicDir, outdir, { recursive: true })
  await injectHtmlFragments(outdir)
  return inlineIcons(outdir)
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
  target: 'chrome120',
  sourcemap: watch,
  minify: !watch,
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
  console.log('Watching extension sources...')
} else {
  await build(options)
}
