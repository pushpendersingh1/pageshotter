import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildTarget, manifestFor } from '../scripts/targets.mjs'

const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'))

describe('manifestFor', () => {
  it('hands Chrome and Edge the manifest untouched, so their packages stay byte-identical', () => {
    expect(manifestFor('chrome', manifest)).toBe(manifest)
    expect(manifestFor('edge', manifest)).toBe(manifest)
  })

  it('gives Firefox an event page, its permanent ID and a no-collection declaration', () => {
    const firefox = manifestFor('firefox', manifest)
    expect(firefox.background).toEqual({ scripts: ['background.js'] })
    expect(firefox.minimum_chrome_version).toBeUndefined()
    expect(firefox.browser_specific_settings.gecko).toEqual({
      id: 'pageshotter@pageshotter.com',
      strict_min_version: '153.0',
      data_collection_permissions: { required: ['none'] },
    })
  })

  /* A permission added for Firefox alone would be a store disclosure nobody wrote. */
  it('asks Firefox for exactly the permissions Chrome has', () => {
    const firefox = manifestFor('firefox', manifest)
    expect(firefox.permissions).toEqual(manifest.permissions)
    expect(firefox.optional_permissions).toEqual(manifest.optional_permissions)
    expect(firefox.host_permissions).toEqual(manifest.host_permissions)
    expect(manifest.minimum_chrome_version).toBe('120')
  })
})

describe('buildTarget', () => {
  it('builds Firefox beside Chrome, for the Firefox engine', () => {
    const firefox = buildTarget(['node', 'build.mjs', '--target', 'firefox'])
    expect(firefox.outdir).toMatch(/dist-firefox$/)
    expect(firefox.zip).toMatch(/pageshotter-extension-firefox\.zip$/)
    expect(firefox.esbuildTarget).toBe('firefox153')
    expect(buildTarget(['node', 'build.mjs']).esbuildTarget).toBe('chrome120')
  })
})
