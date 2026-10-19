import { getSetting, putSetting, putSettingIf } from './capture-db'
import { sanitiseFolder } from './download-folder'
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from './history-policy'

/**
 * History preferences, stored beside the history they govern.
 *
 * Not `chrome.storage.local`, which is the idiomatic home for extension settings but requires the
 * `storage` permission -- and the permission list here is an invariant, not a preference. Keeping
 * them in the database we already open costs one object store and no manifest change. It is also
 * the more honest place: a setting about what is on this machine's disk, stored on this machine's
 * disk, with no sync surface to explain.
 */
const RETENTION_DAYS_KEY = 'historyRetentionDays'

export interface HistorySettings {
  /** `0` means forever: no age rule, though the count and size caps still apply. */
  retentionDays: number
}

/**
 * A week by default, and there is no on/off switch.
 *
 * A toggle read as a question about privacy and answered as one about storage: switching it off
 * emptied history, which is defensible but not what "keep a history" sounds like it controls, and
 * it left two settings that could disagree. One control that says how long things are kept says
 * everything the toggle did -- and "Forever" and a hand-cleared list cover both ends of it.
 *
 * A week rather than a month because the default should be the convenience this
 * exists for: a tab that survives a reload, and a capture findable the same afternoon. Anyone who
 * wants an archive can say so.
 */
export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  retentionDays: DEFAULT_HISTORY_LIMITS.maxAgeMs / (24 * 60 * 60 * 1000),
}

export async function getHistorySettings(): Promise<HistorySettings> {
  const days = await getSetting<number>(RETENTION_DAYS_KEY)
  return {
    retentionDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0
        ? days
        : DEFAULT_HISTORY_SETTINGS.retentionDays,
  }
}

export async function setHistorySettings(settings: Partial<HistorySettings>): Promise<void> {
  if (settings.retentionDays !== undefined) await putSetting(RETENTION_DAYS_KEY, settings.retentionDays)
}

/** The stored preference expressed as the limits the pruning rules take. */
export function limitsFor(settings: HistorySettings): HistoryLimits {
  return { ...DEFAULT_HISTORY_LIMITS, maxAgeMs: settings.retentionDays * 24 * 60 * 60 * 1000 }
}

/*
 * The Downloads subfolder captures are saved into. Empty means Downloads itself, which is where they
 * go today and what clearing the box returns you to.
 *
 * Stored here rather than in `chrome.storage.local` for the same reason as the retention period, and
 * read through `sanitiseFolder` at the point of use rather than trusted because it was saved.
 */
const DOWNLOAD_FOLDER_KEY = 'downloadFolder'
export const DEFAULT_DOWNLOAD_FOLDER = 'PageShotter'

interface StoredDownloadFolder {
  folder: string
  updatedAt: number
}

export async function getDownloadFolder(): Promise<string> {
  const stored = await getSetting<unknown>(DOWNLOAD_FOLDER_KEY)
  if (stored === undefined || isStoredDownloadFolder(stored) || typeof stored !== 'string') {
    return resolveDownloadFolder(stored)
  }

  const folder = sanitiseFolder(stored)
  // Migrate the old raw string atomically. Besides adding the revision, this removes traversal text
  // that older builds stored safely but only sanitised at export time. If another context committed
  // first, read its newer value rather than returning or overwriting the old one.
  const migrated = await putSettingIf<StoredDownloadFolder>(
    DOWNLOAD_FOLDER_KEY,
    { folder, updatedAt: Date.now() },
    (current) => typeof current === 'string',
  )
  return migrated ? folder : getDownloadFolder()
}

export function resolveDownloadFolder(stored: unknown): string {
  if (stored === undefined) return DEFAULT_DOWNLOAD_FOLDER
  if (isStoredDownloadFolder(stored)) return sanitiseFolder(stored.folder)
  if (typeof stored === 'string') return sanitiseFolder(stored)
  return DEFAULT_DOWNLOAD_FOLDER
}

export async function setDownloadFolder(folder: string): Promise<void> {
  await putSetting<StoredDownloadFolder>(DOWNLOAD_FOLDER_KEY, {
    folder: sanitiseFolder(folder),
    updatedAt: Date.now(),
  })
}

/** Clears only a folder that predates this revocation, never a later re-grant and commit. */
export async function clearDownloadFolderRevokedBefore(revokedAt: number): Promise<boolean> {
  return putSettingIf<StoredDownloadFolder>(
    DOWNLOAD_FOLDER_KEY,
    { folder: '', updatedAt: revokedAt },
    (stored) => downloadFolderPredatesRevocation(stored, revokedAt),
  )
}

export function downloadFolderPredatesRevocation(stored: unknown, revokedAt: number): boolean {
  return (
    typeof stored === 'string' ||
    (isStoredDownloadFolder(stored) && stored.updatedAt < revokedAt)
  )
}

function isStoredDownloadFolder(value: unknown): value is StoredDownloadFolder {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredDownloadFolder>
  return (
    typeof candidate.folder === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt)
  )
}

const AUTO_DOWNLOAD_KEY = 'autoDownload'
export const DEFAULT_AUTO_DOWNLOAD = false

/**
 * Whether a finished capture saves itself instead of opening for review.
 *
 * Off by default, and deliberately so: the result page is where a capture is checked, cropped,
 * edited and exported, and skipping it is a choice someone makes after they already know they want
 * the file and nothing else. Turning it on for everyone would hide the product behind a download.
 *
 * Only a *successful* capture is auto-saved. A failure, a cancellation or a stop still opens the
 * page, because those need reading.
 */
export async function getAutoDownload(): Promise<boolean> {
  return (await getSetting<unknown>(AUTO_DOWNLOAD_KEY)) === true
}

export async function setAutoDownload(on: boolean): Promise<void> {
  await putSetting(AUTO_DOWNLOAD_KEY, on === true)
}

const CONTEXT_MENU_KEY = 'contextMenu'
export const DEFAULT_CONTEXT_MENU = true

/**
 * Whether the capture items appear in the page's right-click menu.
 *
 * On by default, so anything but a stored `false` reads as on: the browser offers no way to hide one
 * extension's menu items, which makes this switch the only way out short of uninstalling.
 */
export async function getContextMenu(): Promise<boolean> {
  return (await getSetting<unknown>(CONTEXT_MENU_KEY)) !== false
}

export async function setContextMenu(on: boolean): Promise<void> {
  await putSetting(CONTEXT_MENU_KEY, on === true)
}
