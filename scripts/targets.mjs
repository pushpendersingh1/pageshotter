import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** One profile per browser this repository builds for; `src/shared/browser.ts` reads the same file. */
export const BROWSERS = JSON.parse(await readFile(path.join(root, 'src/shared/browsers.json'), 'utf8'))

/**
 * The `--target <browser>` argument, defaulting to Chrome. Chrome keeps `dist/` and
 * `pageshotter-extension.zip`, the paths every existing instruction and release record names; every
 * other browser gets its own directory beside it, never inside it, so no target's files can end up
 * in another's package.
 */
export function buildTarget(argv = process.argv) {
  const index = argv.indexOf('--target')
  const target = index === -1 ? 'chrome' : argv[index + 1]
  if (!Object.hasOwn(BROWSERS, target)) {
    throw new Error(`Unknown --target "${target}". Known: ${Object.keys(BROWSERS).join(', ')}`)
  }
  const suffix = target === 'chrome' ? '' : `-${target}`
  return {
    target,
    profile: BROWSERS[target],
    outdir: path.join(root, `dist${suffix}`),
    zip: path.join(root, `pageshotter-extension${suffix}.zip`),
  }
}
