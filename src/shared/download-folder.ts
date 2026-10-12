/*
 * Where a saved capture goes.
 *
 * An extension cannot write to an arbitrary path, and PageShotter does not try to. What
 * `chrome.downloads.download` allows is a *relative* filename, and a relative filename containing a
 * separator creates that folder inside the user's own Downloads directory. That is the entire
 * capability PageShotter uses: a subfolder of a directory the browser already owns, not arbitrary
 * filesystem access.
 *
 * Everything here is therefore about making sure a stored string cannot become something else. The
 * rules are applied on the way out, at `downloadPath`, and not only when the value is saved: a
 * setting written by an older version, or edited in the database by hand, must not be able to
 * escape just because it was already on disk.
 */

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_DEPTH = 3
const MAX_SEGMENT = 60

/**
 * Reduce a stored folder value to something that can only ever be a subfolder.
 *
 * Traversal segments are **removed, not resolved**. `a/../../b` becomes `a/b` rather than being
 * walked, because resolving invites the question of what it resolves *relative to*, and the answer
 * must never be "somewhere above Downloads".
 */
export function sanitiseFolder(value: string): string {
  return value
    .split(/[/\\]+/)
    .map((segment) =>
      segment
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"|?*\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, MAX_SEGMENT)
        .replace(/[.\s]+$/, ''),
    )
    .filter((segment) => segment !== '')
    .map((segment) => (RESERVED_DEVICE_NAMES.test(segment) ? `${segment}-folder` : segment))
    .slice(0, MAX_DEPTH)
    .join('/')
}

/**
 * Why a typed folder cannot be used, or `undefined` if it can.
 *
 * An empty value is valid and means "no folder": captures land in Downloads itself, which is what
 * happens today and must stay reachable by clearing the box.
 */
export function folderProblem(typed: string): string | undefined {
  if (typed.trim() === '') return undefined
  if (sanitiseFolder(typed) === '') {
    return 'That folder name is only characters a folder cannot contain.'
  }
  return undefined
}

/**
 * The relative path handed to `chrome.downloads.download`.
 *
 * The filename is re-checked here even though it arrives from `sanitiseTypedFilename`, which already
 * strips separators. Two functions guard this and neither assumes the other ran: the cost is one
 * regex, and the failure it prevents is a capture written somewhere the user did not choose.
 */
export function downloadPath(folder: string, filename: string): string {
  const safeName = filename.replace(/[/\\]+/g, '-')
  const safeFolder = sanitiseFolder(folder)
  return safeFolder === '' ? safeName : `${safeFolder}/${safeName}`
}

/** The destination shown before save. Chrome's path is always relative to its Downloads directory. */
export function displayedDownloadPath(folder: string, filename: string): string {
  return `Downloads/${downloadPath(folder, filename)}`
}
