import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'
import { buildTarget } from './targets.mjs'

const { outdir: dist, zip } = buildTarget()
const files = {}

/** Every entry is stamped with one fixed timestamp so the same `dist/` always zips to the same
 * bytes. Without it `zipSync` writes the current clock into each local header and the SHA-256 the
 * release checklist records would change on every repackage, fingerprinting the file rather than
 * the build. 1980-01-01 is the earliest moment the DOS time field can express. */
const EPOCH = new Date('1980-01-01T00:00:00Z')

async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const absolutePath = path.join(directory, entry.name)
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) await collect(absolutePath, relativePath)
    else files[relativePath] = [new Uint8Array(await readFile(absolutePath)), { mtime: EPOCH }]
  }
}

await collect(dist)
await writeFile(zip, zipSync(files, { level: 9 }))
console.log(`Packaged ${Object.keys(files).length} files in ${path.basename(zip)}`)
