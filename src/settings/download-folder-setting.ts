import { folderProblem, sanitiseFolder } from '../shared/download-folder'

export interface FolderSettingActions {
  requestPermission(): Promise<boolean>
  removePermission(): Promise<boolean>
  saveFolder(folder: string): Promise<void>
}

export type FolderCommitResult =
  | { kind: 'unchanged' | 'invalid' | 'permission-denied'; folder: string }
  | { kind: 'set'; folder: string }
  | { kind: 'cleared'; folder: string; permissionRemoved: boolean }

/** Commits one folder draft without letting storage get ahead of Chrome's permission state. */
export async function commitFolderDraft(
  savedFolder: string,
  draft: string,
  permissionGranted: boolean,
  actions: FolderSettingActions,
): Promise<FolderCommitResult> {
  const typed = draft.trim()
  if (folderProblem(typed) !== undefined) return { kind: 'invalid', folder: typed }
  const folder = sanitiseFolder(typed)
  const saved = sanitiseFolder(savedFolder)
  if (folder === saved && (folder === '' || permissionGranted)) return { kind: 'unchanged', folder }

  if (folder === '') {
    await actions.saveFolder('')
    const permissionRemoved = !permissionGranted || (await actions.removePermission())
    return { kind: 'cleared', folder, permissionRemoved }
  }

  if (!permissionGranted && !(await actions.requestPermission())) {
    return { kind: 'permission-denied', folder }
  }

  await actions.saveFolder(folder)
  return { kind: 'set', folder }
}
