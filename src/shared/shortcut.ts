/**
 * What Chrome actually bound to the capture command, which is not what the manifest asked for.
 *
 * `suggested_key` only applies when the combination is still free at install time, and on a browser
 * with a few extensions in it very often it is not. Any page that prints a shortcut has to read the
 * real one, or it promises a key that does nothing -- so both pages that do (welcome and settings)
 * read it through here rather than each rolling its own lookup and drifting on the command name.
 */

/** The manifest's name for the full-page capture command. */
export const CAPTURE_COMMAND = 'capture-full-page'

/** The assigned shortcut, or an empty string when there is none and when the list cannot be read. */
export async function captureShortcut(): Promise<string> {
  try {
    const commands = await chrome.commands.getAll()
    return commands.find((command) => command.name === CAPTURE_COMMAND)?.shortcut ?? ''
  } catch {
    // An unreadable command list is indistinguishable from an unassigned shortcut, and both are
    // served correctly by pointing at Chrome's own shortcuts page.
    return ''
  }
}
