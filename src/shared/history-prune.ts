import { deleteHistoryEntries, listHistory } from './capture-db'
import { expiredHistoryIds } from './history-policy'
import { getHistorySettings, limitsFor } from './history-settings'

/**
 * Applies the retention rules to whatever is stored right now.
 *
 * Deliberately not driven by `chrome.alarms` on a daily timer: that would cost
 * a new permission, and this extension's whole argument is `activeTab` + `scripting` and nothing
 * else. Instead this runs at the three moments that already exist and that between them cover every
 * way a stale entry can be noticed -- the service worker starting, a capture being saved, and the
 * history page being opened. The only state it cannot reach is a browser left running for longer
 * than the retention period with the extension never touched, and the first of those three events
 * settles that as soon as anything happens at all.
 *
 * Returns how many entries it removed, which the caller may ignore.
 */
export async function pruneHistory(now = Date.now()): Promise<number> {
  const settings = await getHistorySettings()
  const entries = await listHistory()
  const doomed = expiredHistoryIds(
    entries.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, bytes: entry.bytes })),
    now,
    limitsFor(settings),
  )
  await deleteHistoryEntries(doomed)
  return doomed.length
}
