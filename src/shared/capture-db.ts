import type { SceneDoc } from '../editor/scene'
import type { HistoryEntry, HistoryTile } from './history'
import { searchableText, type PageContent } from './page-content'
import type { CaptureJob, StoredSegment } from './messages'

const DATABASE_NAME = 'pageshotter-captures'
/**
 * Version 2 added the two history stores, version 3 settings, version 4 the page-content store,
 * version 5 the editor documents. Jobs and segments are unchanged:
 * they remain the short-lived record of a capture in flight, and history is the separate, deliberate
 * copy kept afterwards. Keeping them apart means the capture path cannot be slowed or broken by
 * retention.
 *
 * Settings live here, rather than in `chrome.storage.local`, because `chrome.storage` requires the
 * `storage` permission and the permission list is an invariant of this extension, not a preference.
 * A settings store in a database we already open costs nothing and keeps the manifest
 * at `activeTab` + `scripting`.
 */
const DATABASE_VERSION = 5
const JOBS_STORE = 'jobs'
const SEGMENTS_STORE = 'segments'
const HISTORY_STORE = 'history'
const HISTORY_TILES_STORE = 'historyTiles'
const SETTINGS_STORE = 'settings'
const PAGE_CONTENT_STORE = 'pageContents'
/**
 * Named for what it holds. The document is an annotation tree *plus* the crop and the Present
 * configuration, so `annotations` would be a name that stops being true the first time someone
 * crops a screenshot.
 */
const EDITOR_DOCS_STORE = 'editorDocs'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(JOBS_STORE)) {
        database.createObjectStore(JOBS_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(SEGMENTS_STORE)) {
        const store = database.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' })
        store.createIndex('jobId', 'jobId')
      }
      if (!database.objectStoreNames.contains(HISTORY_STORE)) {
        const store = database.createObjectStore(HISTORY_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!database.objectStoreNames.contains(HISTORY_TILES_STORE)) {
        const store = database.createObjectStore(HISTORY_TILES_STORE, { keyPath: 'id' })
        store.createIndex('entryId', 'entryId')
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(PAGE_CONTENT_STORE)) {
        database.createObjectStore(PAGE_CONTENT_STORE, { keyPath: 'entryId' })
        movePageContentOut(request.transaction)
      }
      if (!database.objectStoreNames.contains(EDITOR_DOCS_STORE)) {
        // Version 5 is purely additive, the same shape as version 4's guard above minus the
        // migration: nothing has ever stored an edit, so there is no data to convert and no
        // coordinate arithmetic to get wrong. An aborted upgrade reopens at version 4 with every
        // capture untouched.
        database.createObjectStore(EDITOR_DOCS_STORE, { keyPath: 'entryId' })
      }
    }
  })
}

/**
 * Moves the harvested page content off the history records and into its own store.
 *
 * Version 3 kept it on the entry, which meant listing history deserialized every capture's links and
 * text -- tens of thousands of positioned words per entry -- to draw a list that shows a thumbnail
 * and a date. The content is only ever wanted by one capture at a time, when it is reopened or
 * exported, so it belongs beside the tiles rather than beside the metadata.
 *
 * The entry keeps a `searchText` distillation, which is what makes history searchable by what the
 * page said rather than only by what its tab was called.
 *
 * Runs inside the version-change transaction, so a browser that dies mid-upgrade reopens at version
 * 3 with the entries untouched.
 */
function movePageContentOut(transaction: IDBTransaction | null): void {
  if (!transaction) return
  const entries = transaction.objectStore(HISTORY_STORE)
  const contents = transaction.objectStore(PAGE_CONTENT_STORE)
  const cursorRequest = entries.openCursor()
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) return
    const entry = cursor.value as HistoryEntry & { pageContent?: PageContent }
    const { pageContent, ...rest } = entry
    if (pageContent) {
      contents.put({ entryId: entry.id, content: pageContent })
      cursor.update({ ...rest, searchText: searchableText(pageContent) })
    }
    cursor.continue()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/**
 * Opens the database for one operation and always closes it, whether the work resolves or rejects.
 * An open connection is not harmless: it blocks the next version upgrade in every other extension page.
 */
async function withDatabase<T>(work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase()
  try {
    return await work(database)
  } finally {
    database.close()
  }
}

export async function putJob(job: CaptureJob): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(JOBS_STORE, 'readwrite')
    transaction.objectStore(JOBS_STORE).put(job)
    await transactionDone(transaction)
  })
}

export async function getJob(jobId: string): Promise<CaptureJob | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(JOBS_STORE, 'readonly')
    const result = await requestResult(transaction.objectStore(JOBS_STORE).get(jobId))
    return result as CaptureJob | undefined
  })
}

export async function putSegment(segment: StoredSegment): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(SEGMENTS_STORE, 'readwrite')
    transaction.objectStore(SEGMENTS_STORE).put(segment)
    await transactionDone(transaction)
  })
}

export async function getSegments(jobId: string): Promise<StoredSegment[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(SEGMENTS_STORE, 'readonly')
    const index = transaction.objectStore(SEGMENTS_STORE).index('jobId')
    const result = await requestResult(index.getAll(jobId))
    return (result as StoredSegment[]).sort((a, b) => a.index - b.index)
  })
}

export async function getJobs(): Promise<CaptureJob[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(JOBS_STORE, 'readonly')
    const result = await requestResult(transaction.objectStore(JOBS_STORE).getAll())
    return result as CaptureJob[]
  })
}

export async function deleteSegments(jobId: string): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(SEGMENTS_STORE, 'readwrite')
    const segmentStore = transaction.objectStore(SEGMENTS_STORE)
    const cursorRequest = segmentStore.index('jobId').openKeyCursor(IDBKeyRange.only(jobId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      segmentStore.delete(cursor.primaryKey)
      cursor.continue()
    }
    await transactionDone(transaction)
  })
}

export async function deleteCapture(jobId: string): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [JOBS_STORE, SEGMENTS_STORE, EDITOR_DOCS_STORE],
      'readwrite',
    )
    transaction.objectStore(JOBS_STORE).delete(jobId)
    transaction.objectStore(EDITOR_DOCS_STORE).delete(jobId)
    const segmentStore = transaction.objectStore(SEGMENTS_STORE)
    const cursorRequest = segmentStore.index('jobId').openKeyCursor(IDBKeyRange.only(jobId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      segmentStore.delete(cursor.primaryKey)
      cursor.continue()
    }
    await transactionDone(transaction)
  })
}

export async function deleteExpiredCaptures(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const jobs = await getJobs()
  const cutoff = Date.now() - maxAgeMs
  await Promise.all(jobs.filter((job) => job.updatedAt < cutoff).map((job) => deleteCapture(job.id)))
}

/**
 * Writes one finished capture to history, tiles and all, and evicts what retention says must make
 * room for it -- in a single transaction.
 *
 * One transaction because a half-written entry is worse than no entry: the list would offer a
 * screenshot that cannot be opened. And the evictions belong in it too: committed separately and
 * first, a write that then failed -- realistically on the disk quota -- would have lost the older
 * captures and kept nothing in their place. Now a failure leaves history exactly as it was.
 *
 * `evict` sees the entries stored at the moment of the write and must be synchronous: anything
 * awaited that is not one of this transaction's own requests lets it commit early.
 */
export async function replaceHistoryEntry(
  entry: HistoryEntry,
  tiles: HistoryTile[],
  pageContent: PageContent | undefined,
  evict: (current: HistoryEntry[]) => string[],
): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [HISTORY_STORE, HISTORY_TILES_STORE, PAGE_CONTENT_STORE, EDITOR_DOCS_STORE],
      'readwrite',
    )
    const current = (await requestResult(transaction.objectStore(HISTORY_STORE).getAll())) as HistoryEntry[]
    deleteEntriesIn(transaction, evict(current))
    transaction.objectStore(HISTORY_STORE).put(entry)
    const tileStore = transaction.objectStore(HISTORY_TILES_STORE)
    for (const tile of tiles) tileStore.put(tile)
    if (pageContent) transaction.objectStore(PAGE_CONTENT_STORE).put({ entryId: entry.id, content: pageContent })
    await transactionDone(transaction)
  })
}

/**
 * The links and text harvested for one capture, read only when that capture is opened.
 *
 * Deliberately not part of `listHistory`: this is the large half of a history record, and the list
 * has no use for it.
 */
export async function getHistoryPageContent(entryId: string): Promise<PageContent | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(PAGE_CONTENT_STORE, 'readonly')
    const record = (await requestResult(transaction.objectStore(PAGE_CONTENT_STORE).get(entryId))) as
      | { entryId: string; content: PageContent }
      | undefined
    return record?.content
  })
}

// --- editor documents --------------------------------------------------------

/**
 * Writes one capture's editor document, replacing whatever was there.
 *
 * The editor saves through this only when the user presses Done, so
 * closing the tab or a crash before Done loses that session's edits. Documents are keyed by the capture's id and deleted wherever the
 * capture itself is deleted -- `deleteCapture`, `deleteHistoryEntries`, `clearHistory` -- so an edit
 * can never outlive the pixels it marks up.
 */
export async function putEditorDoc(entryId: string, doc: SceneDoc): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(EDITOR_DOCS_STORE, 'readwrite')
    transaction.objectStore(EDITOR_DOCS_STORE).put({ entryId, doc })
    await transactionDone(transaction)
  })
}

/**
 * The capture's editor document, or `undefined` when it has never been edited.
 *
 * Returned raw rather than parsed: `parseSceneDoc` needs the capture's dimensions to fill a partial
 * record, and this module has no business knowing them. The caller parses.
 */
export async function getEditorDoc(entryId: string): Promise<unknown> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(EDITOR_DOCS_STORE, 'readonly')
    const record = (await requestResult(transaction.objectStore(EDITOR_DOCS_STORE).get(entryId))) as
      | { entryId: string; doc: unknown }
      | undefined
    return record?.doc
  })
}

export async function getHistoryEntry(entryId: string): Promise<HistoryEntry | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(HISTORY_STORE, 'readonly')
    const result = await requestResult(transaction.objectStore(HISTORY_STORE).get(entryId))
    return result as HistoryEntry | undefined
  })
}

/** Tiles for one entry, in the order they stack down the image. */
export async function getHistoryTiles(entryId: string): Promise<HistoryTile[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(HISTORY_TILES_STORE, 'readonly')
    const index = transaction.objectStore(HISTORY_TILES_STORE).index('entryId')
    const tiles = (await requestResult(index.getAll(IDBKeyRange.only(entryId)))) as HistoryTile[]
    return tiles.sort((a, b) => a.index - b.index)
  })
}

/**
 * Every entry, newest first, without their tiles.
 *
 * The list page needs forty rows of metadata, not forty full-size screenshots, so neither the tiles
 * nor the harvested page content are touched here -- that is the difference between a list that
 * opens instantly and one that decodes hundreds of megabytes to draw itself. What the list *can*
 * search is on the entry: `searchText`, a few kilobytes of the page's own words.
 */
export async function listHistory(): Promise<HistoryEntry[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(HISTORY_STORE, 'readonly')
    const entries = (await requestResult(transaction.objectStore(HISTORY_STORE).getAll())) as HistoryEntry[]
    return entries.sort((a, b) => b.createdAt - a.createdAt)
  })
}

export async function deleteHistoryEntries(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [HISTORY_STORE, HISTORY_TILES_STORE, PAGE_CONTENT_STORE, EDITOR_DOCS_STORE],
      'readwrite',
    )
    deleteEntriesIn(transaction, entryIds)
    await transactionDone(transaction)
  })
}

/** Queues the deletion of each entry with its tiles, page content and editor document. */
function deleteEntriesIn(transaction: IDBTransaction, entryIds: string[]): void {
  const entryStore = transaction.objectStore(HISTORY_STORE)
  const tileStore = transaction.objectStore(HISTORY_TILES_STORE)
  const contentStore = transaction.objectStore(PAGE_CONTENT_STORE)
  const editorStore = transaction.objectStore(EDITOR_DOCS_STORE)
  const tileIndex = tileStore.index('entryId')
  for (const entryId of entryIds) {
    entryStore.delete(entryId)
    contentStore.delete(entryId)
    editorStore.delete(entryId)
    const cursorRequest = tileIndex.openKeyCursor(IDBKeyRange.only(entryId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      tileStore.delete(cursor.primaryKey)
      cursor.continue()
    }
  }
}

/** Empties history outright, which is what the page's "Delete all" must mean. */
export async function clearHistory(): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(
      [HISTORY_STORE, HISTORY_TILES_STORE, PAGE_CONTENT_STORE, EDITOR_DOCS_STORE],
      'readwrite',
    )
    transaction.objectStore(HISTORY_STORE).clear()
    transaction.objectStore(HISTORY_TILES_STORE).clear()
    transaction.objectStore(PAGE_CONTENT_STORE).clear()
    transaction.objectStore(EDITOR_DOCS_STORE).clear()
    await transactionDone(transaction)
  })
}

/** One stored preference. Returns `undefined` when it has never been set, so callers own the default. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(SETTINGS_STORE, 'readonly')
    const record = (await requestResult(transaction.objectStore(SETTINGS_STORE).get(key))) as
      | { key: string; value: T }
      | undefined
    return record?.value
  })
}

export async function putSetting<T>(key: string, value: T): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(SETTINGS_STORE, 'readwrite')
    transaction.objectStore(SETTINGS_STORE).put({ key, value })
    await transactionDone(transaction)
  })
}

/** Replaces one setting only when its current value still describes the state the caller observed. */
export async function putSettingIf<T>(
  key: string,
  value: T,
  predicate: (current: unknown) => boolean,
): Promise<boolean> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(SETTINGS_STORE, 'readwrite')
    const store = transaction.objectStore(SETTINGS_STORE)
    const record = (await requestResult(store.get(key))) as { key: string; value: unknown } | undefined
    const shouldPut = predicate(record?.value)
    if (shouldPut) store.put({ key, value })
    await transactionDone(transaction)
    return shouldPut
  })
}
