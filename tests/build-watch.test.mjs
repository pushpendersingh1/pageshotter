import { spawn } from 'node:child_process'
import { appendFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { expect, it } from 'vitest'

/*
 * `npm run dev` once watched only what esbuild bundles: an edit to CSS, a page, the export-menu
 * fragment or an icon marker never reached dist/, so the loaded extension showed stale UI.
 * This runs the real watcher in a disposable copy, because the build script resolves dist/ beside
 * itself and must never write into this checkout's public/. Plain JavaScript because the TypeScript
 * project carries no Node types, and this is the one test that needs Node APIs.
 */
const repo = path.resolve(import.meta.dirname, '..')

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return true
    await setTimeout(50)
  }
  return false
}

it('re-prepares public/ assets while watching', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pageshotter-watch-'))
  let watcher
  try {
    for (const part of ['public', 'scripts', 'src']) {
      await cp(path.join(repo, part), path.join(dir, part), { recursive: true })
    }
    await symlink(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir')

    let log = ''
    watcher = spawn(process.execPath, ['scripts/build.mjs', '--watch'], { cwd: dir })
    watcher.stdout.on('data', (chunk) => (log += chunk))
    watcher.stderr.on('data', (chunk) => (log += chunk))
    expect(await eventually(async () => log.includes('Watching extension sources'))).toBe(true)

    const input = (file) => path.join(dir, 'public', file)
    const output = (file) => readFile(path.join(dir, 'dist', file), 'utf8').catch(() => '')
    await appendFile(input('result.css'), '\n/* watched-css */\n')
    await appendFile(input('export-menu.html'), '<!-- watched-fragment -->\n')
    const history = await readFile(input('history.html'), 'utf8')
    await writeFile(
      input('history.html'),
      history.replace('</body>', '<svg class="icon" data-icon="bug" viewBox="0 0 24 24"></svg></body>'),
    )

    expect(await eventually(async () => (await output('result.css')).includes('watched-css'))).toBe(true)
    expect(await eventually(async () => (await output('editor.html')).includes('watched-fragment'))).toBe(true)
    expect(
      await eventually(async () => {
        const html = await output('history.html')
        return html.includes('data-icon="bug"') && !/data-icon="bug"[^>]*><\/svg>/.test(html)
      }),
    ).toBe(true)
  } finally {
    watcher?.kill()
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)
