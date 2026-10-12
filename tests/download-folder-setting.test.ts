import { describe, expect, it, vi } from 'vitest'
import { commitFolderDraft, type FolderSettingActions } from '../src/settings/download-folder-setting'
import {
  DEFAULT_DOWNLOAD_FOLDER,
  downloadFolderPredatesRevocation,
  resolveDownloadFolder,
} from '../src/shared/history-settings'

function actions(permissionGranted = true) {
  return {
    requestPermission: vi.fn(async () => permissionGranted),
    removePermission: vi.fn(async () => true),
    saveFolder: vi.fn(async () => undefined),
  } satisfies FolderSettingActions
}

describe('commitFolderDraft', () => {
  it('requests permission before saving a new folder', async () => {
    const ports = actions(true)

    await expect(commitFolderDraft('', ' PageShotter ', false, ports)).resolves.toEqual({
      kind: 'set',
      folder: 'PageShotter',
    })
    expect(ports.requestPermission).toHaveBeenCalledOnce()
    expect(ports.saveFolder).toHaveBeenCalledWith('PageShotter')
    expect(ports.requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      ports.saveFolder.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('keeps a refused folder as a draft and does not save it', async () => {
    const ports = actions(false)

    await expect(commitFolderDraft('', 'PageShotter', false, ports)).resolves.toEqual({
      kind: 'permission-denied',
      folder: 'PageShotter',
    })
    expect(ports.saveFolder).not.toHaveBeenCalled()
  })

  it('updates a folder without asking again when permission is already held', async () => {
    const ports = actions()

    await commitFolderDraft('Old', 'New', true, ports)

    expect(ports.requestPermission).not.toHaveBeenCalled()
    expect(ports.saveFolder).toHaveBeenCalledWith('New')
  })

  it('can restore access for a folder left by an older build', async () => {
    const ports = actions(true)

    await expect(commitFolderDraft('PageShotter', 'PageShotter', false, ports)).resolves.toEqual({
      kind: 'set',
      folder: 'PageShotter',
    })
    expect(ports.requestPermission).toHaveBeenCalledOnce()
    expect(ports.saveFolder).toHaveBeenCalledWith('PageShotter')
  })

  it('clears the preference and removes permission without touching downloaded files', async () => {
    const ports = actions()

    await expect(commitFolderDraft('PageShotter', '', true, ports)).resolves.toEqual({
      kind: 'cleared',
      folder: '',
      permissionRemoved: true,
    })
    expect(ports.saveFolder).toHaveBeenCalledWith('')
    expect(ports.removePermission).toHaveBeenCalledOnce()
  })

  it('clears a stale folder without trying to remove permission that is already absent', async () => {
    const ports = actions()

    await expect(commitFolderDraft('PageShotter', '', false, ports)).resolves.toEqual({
      kind: 'cleared',
      folder: '',
      permissionRemoved: true,
    })
    expect(ports.removePermission).not.toHaveBeenCalled()
  })

  it('reports when Chrome keeps permission after the preference was cleared', async () => {
    const ports = actions()
    ports.removePermission.mockResolvedValue(false)

    await expect(commitFolderDraft('PageShotter', '', true, ports)).resolves.toEqual({
      kind: 'cleared',
      folder: '',
      permissionRemoved: false,
    })
    expect(ports.saveFolder).toHaveBeenCalledWith('')
  })

  it('sanitises a folder before it is persisted', async () => {
    const ports = actions()

    await expect(commitFolderDraft('', '../../etc', true, ports)).resolves.toEqual({
      kind: 'set',
      folder: 'etc',
    })
    expect(ports.saveFolder).toHaveBeenCalledWith('etc')
  })

  it('does nothing for an unchanged or invalid draft', async () => {
    const unchanged = actions()
    const invalid = actions()

    await expect(commitFolderDraft('PageShotter', 'PageShotter', true, unchanged)).resolves.toEqual({
      kind: 'unchanged',
      folder: 'PageShotter',
    })
    await expect(commitFolderDraft('', '///', false, invalid)).resolves.toEqual({
      kind: 'invalid',
      folder: '///',
    })
    expect(unchanged.saveFolder).not.toHaveBeenCalled()
    expect(invalid.requestPermission).not.toHaveBeenCalled()
  })
})

describe('downloadFolderPredatesRevocation', () => {
  it('clears a legacy string or an older versioned folder', () => {
    expect(downloadFolderPredatesRevocation('PageShotter', 200)).toBe(true)
    expect(downloadFolderPredatesRevocation({ folder: 'PageShotter', updatedAt: 100 }, 200)).toBe(true)
  })

  it('does not clear a folder committed at or after the revocation', () => {
    expect(downloadFolderPredatesRevocation({ folder: 'New', updatedAt: 200 }, 200)).toBe(false)
    expect(downloadFolderPredatesRevocation({ folder: 'New', updatedAt: 300 }, 200)).toBe(false)
  })
})

describe('resolveDownloadFolder', () => {
  it('defaults an unset folder to PageShotter but preserves an explicit empty choice', () => {
    expect(resolveDownloadFolder(undefined)).toBe(DEFAULT_DOWNLOAD_FOLDER)
    expect(resolveDownloadFolder({ folder: '', updatedAt: 1 })).toBe('')
  })

  it('defaults a corrupt stored value rather than silently undoing the upgrade default', () => {
    expect(resolveDownloadFolder(42)).toBe(DEFAULT_DOWNLOAD_FOLDER)
  })
})
