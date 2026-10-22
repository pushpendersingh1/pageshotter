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
    esbuildTarget: target === 'firefox' ? `firefox${FIREFOX_MIN}` : 'chrome120',
    // Opera's review reads our code and refuses it minified; third-party libraries are exempt.
    minify: target !== 'opera',
  }
}

/** The data Firefox's Gmail prompt asks for; `src/result/gmail.ts` reads it from the manifest. */
const GMAIL_DATA_COLLECTION = 'websiteContent'

/**
 * Firefox's floor. 153 is the ESR, and the first release where `extension.isAllowedFileSchemeAccess`
 * reflects a real setting rather than always answering false, which the local-file remedy depends on.
 */
const FIREFOX_MIN = 153

/**
 * `public/manifest.json` is Chrome's, and Edge and Opera take it as it is. Firefox has no MV3 service worker,
 * so the same bundle runs as an event page there, and AMO requires an ID and a data-collection
 * declaration. Chrome-only keys are dropped rather than left for Firefox to warn about.
 */
export function manifestFor(target, manifest) {
  if (target !== 'firefox') return manifest
  const rest = { ...manifest }
  delete rest.minimum_chrome_version
  return {
    ...rest,
    background: { scripts: [manifest.background.service_worker] },
    browser_specific_settings: {
      gecko: {
        // Permanent once submitted to AMO: every installed copy is matched to its updates by it.
        id: 'pageshotter@pageshotter.com',
        strict_min_version: `${FIREFOX_MIN}.0`,
        // Nothing leaves the device unless the user sends a screenshot to Gmail, and Mozilla counts
        // that hand-off as website content leaving the add-on. So installing collects nothing, and
        // the Gmail button asks for `websiteContent` in the same prompt as Gmail access.
        data_collection_permissions: { required: ['none'], optional: [GMAIL_DATA_COLLECTION] },
      },
    },
  }
}
