/*
 * What a saved capture is called.
 *
 * This is a pure function over a date, a URL and a title, which is deliberate: the extension cannot
 * be run on the development machine, so the parts of the product that can be proved in Node are
 * worth keeping that way. Nothing here touches Chrome.
 *
 * Two rules the shape enforces rather than documents:
 *
 * - **The extension is appended after the length cap**, so a long title can never cut it off and a
 *   PNG can never be called `report.jpg`.
 * - **The result can never contain a path separator.** Every part is slugified to
 *   `[a-z0-9-]`, so a title of `../../etc/passwd` becomes `etc-passwd` rather than an escape. Saving
 *   into a folder is a separate capability that goes through the downloads API on purpose; a
 *   filename must not be able to smuggle one in.
 */

export type SuggestedFilenameParts = {
  title: string
  /** Absent when the capture has no stored address, which is the case for a restricted page. */
  url?: string
  capturedAt: Date
  extension: 'png' | 'jpg' | 'webp' | 'pdf'
}

const FALLBACK = 'pageshotter-capture'
const SUGGESTED_MAX_LENGTH = 120

/** Reduce any text to the safe alphabet. Accents fold to their base letter rather than vanishing. */
function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return slug(new URL(url).hostname)
  } catch {
    return ''
  }
}

/**
 * The name the save dialog suggests: `yyyy-mm-dd-HHMMSS-host-title.ext`.
 *
 * Date first, so a directory listing sorts chronologically; then the host and the title, which are
 * what someone scanning for one capture actually reads. Calendar fields come from the local clock,
 * not UTC: a capture taken at 22:30 on the 5th is named for the 5th, the day the person remembers.
 *
 * ponytail: one fixed pattern. A configurable naming template is new work for an accepted
 * requirement; the old interpreter is recoverable from git history.
 */
export function suggestedFilename(parts: SuggestedFilenameParts): string {
  const at = parts.capturedAt
  const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1, 2)}-${pad(at.getDate(), 2)}`
  const time = `${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
  /*
   * Slugified once more over the whole string. This collapses the run of dashes an empty host or
   * title leaves behind, and is the single place that guarantees the separator and traversal rules
   * above. The date means the base is never empty, so no fallback is needed.
   */
  const base = slug(`${date}-${time}-${hostOf(parts.url)}-${slug(parts.title)}`)
    .slice(0, SUGGESTED_MAX_LENGTH)
    .replace(/-+$/, '')
  return `${base}.${parts.extension}`
}

/*
 * A name the user typed, made safe without being rewritten.
 *
 * Deliberately *not* the same rules as the template. `slug` above folds a machine-generated string
 * to `[a-z0-9-]` because nothing is lost when a title becomes a filename fragment. A name someone
 * typed is different: "Q3 Report (final)" should be saved as "Q3 Report (final)", and folding it to
 * "q3-report-final" would be the product overruling a deliberate choice. So this removes only what
 * a filesystem genuinely refuses, and leaves everything else, accents and spaces included.
 *
 * What it still refuses is the part that matters: path separators. A typed name must not be able to
 * pick a directory, for the same reason the template cannot.
 */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const TYPED_MAX_LENGTH = 120

function cleanTyped(typed: string): string {
  return typed
    /* Path separators and the characters Windows refuses, plus C0/C1 control codes. */
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\<>:"|?*\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    /*
     * Windows silently strips a trailing dot or space, so a file saved as "report." opens as
     * "report" and a user who typed one and looked for the other is confused by their own OS.
     */
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, TYPED_MAX_LENGTH)
    .replace(/[.\s]+$/, '')
}

export function sanitiseTypedFilename(typed: string): string {
  const cleaned = cleanTyped(typed)
  if (cleaned === '') return FALLBACK
  /*
   * `CON`, `NUL`, `COM1` and friends are devices, not files, on Windows. A capture saved under one
   * cannot be opened afterwards. Suffixing keeps the name the user recognises; rejecting it outright
   * would mean explaining a forty-year-old DOS rule in a dialog.
   */
  if (RESERVED_DEVICE_NAMES.test(cleaned)) return `${cleaned}-capture`
  return cleaned
}

/**
 * Why a typed name cannot be used, or `undefined` if it can.
 *
 * `sanitiseTypedFilename` still falls back to a placeholder, because a function that returns a
 * filename must always return one. But a fallback is the wrong answer *in front of a person*: it
 * silently saves a file under a name they did not choose and did not see. So the dialog asks this
 * first and refuses to submit, and the sanitiser's fallback is left as the safety net it was.
 *
 * Two cases, deliberately separated. An empty box is a thing the user has not done yet; a box full
 * of slashes is a thing they have done that cannot work. Telling them apart is the difference
 * between an instruction and an explanation.
 */
export function filenameProblem(typed: string): string | undefined {
  if (typed.trim() === '') return 'Enter a file name.'
  /*
   * Checks the cleaning directly rather than comparing the result to the fallback. Comparing would
   * reject someone who typed `pageshotter-capture` on purpose, which is a name they are entitled to.
   */
  if (cleanTyped(typed) === '') {
    return 'That name is only characters a file cannot contain.'
  }
  return undefined
}
