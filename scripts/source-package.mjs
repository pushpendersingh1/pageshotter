import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/*
 * The source package AMO requires with every Firefox upload. The extension is bundled and minified,
 * so a reviewer has to be able to rebuild it from source and get the same bytes.
 *
 * It is `git archive HEAD` plus BUILDING.md -- the committed tree and nothing else, so a stray local
 * edit can never reach a reviewer, and the archive's timestamps are the commit's, so the same commit
 * always gives the same zip. For the same reason it refuses a dirty tree: the extension zip is built
 * from the working tree, and the two must describe one commit.
 */
const root = path.resolve(import.meta.dirname, '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

/** Called before anything is zipped, so a refusal leaves no half-made release behind. */
export function assertCleanTree() {
  const dirty = git('status', '--porcelain', '--untracked-files=normal').trimEnd()
  if (dirty) {
    throw new Error(
      `Refusing to package for AMO from a working tree with changes:\n${dirty}\n` +
        'Commit or stash them first, so the source and the extension zip are the same commit.',
    )
  }
}

export async function writeSourcePackage(zip) {
  assertCleanTree()
  const commit = git('rev-parse', 'HEAD').trim()
  const { engines, version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const scratch = await mkdtemp(path.join(tmpdir(), 'pageshotter-source-'))
  try {
    const building = path.join(scratch, 'BUILDING.md')
    await writeFile(building, buildingNotes({ commit, version, node: engines.node }))
    git('archive', '--format=zip', `--add-file=${building}`, '-o', zip, 'HEAD')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return commit
}

function buildingNotes({ commit, version, node }) {
  return `# Building PageShotter ${version} for Firefox

This archive is the source of the extension package submitted to addons.mozilla.org, exactly as
committed at \`${commit}\` in https://github.com/pushpendersingh1/pageshotter.

## Requirements

- Node.js ${node} (built with ${process.version}) and the npm that ships with it
- Any OS; the build does not depend on the platform

## Steps

\`\`\`sh
npm ci
npm run build:firefox
node scripts/package.mjs --target firefox
\`\`\`

\`npm ci\` installs the exact versions pinned in \`package-lock.json\`. The build is esbuild, run by
\`scripts/build.mjs\`; it bundles and minifies \`src/\` and copies \`public/\`. Nothing is downloaded during
the build.

## Output

- \`dist-firefox/\` -- the unpacked extension
- \`pageshotter-extension-firefox.zip\` -- the package. Its entries carry a fixed timestamp, so it is
  byte-for-byte identical to the uploaded file: compare with \`shasum -a 256\`.
`
}
