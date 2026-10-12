import { getSetting, putSetting } from './capture-db'

/**
 * How far a capture follows a page that is still growing while it is being captured.
 *
 * The distinction this setting exists to draw is between two pages that look identical for the
 * first few sections: one that lazily fills in as you scroll and *does* have an end, and one that
 * appends as fast as it is scrolled and has none. No measurement separates them early, because
 * early on they behave the same way. So this is a policy, not a detection problem.
 */
export type LongPagePolicy = 'freeze' | 'follow' | 'unbounded'

export const DEFAULT_LONG_PAGE_POLICY: LongPagePolicy = 'follow'

/**
 * How many sections past the starting height `follow` will go.
 *
 * Counted in sections rather than as a multiple of the starting height, which was the first shape
 * tried and is wrong at both ends: a page one viewport tall would be allowed exactly one extra
 * section, too tight for a gallery that legitimately builds as it is scrolled, while a 60,000px
 * page would be allowed another 60,000 -- far past the point anyone reads. Sections are also the
 * unit capture actually spends, so ten of them costs about the same wherever they are spent.
 */
export const FOLLOW_EXTRA_SECTIONS = 10

/**
 * The wall clock a capture may not outrun, whatever the page does.
 *
 * This is the backstop behind the height rules, not the working limit, and the value is chosen so
 * that it cannot become one: the section ceiling already bounds a healthy capture at roughly 200
 * sections, which at the ~510ms capture quota plus settle costs around 140 seconds. Three minutes
 * sits just above that, so this can only fire on a page that is pathologically slow -- enormous
 * images, a heavy settle -- and never on one that is merely long. A shorter budget was tried and
 * reverted: below ~140s it stops being a backstop and starts truncating pages that would have
 * finished, which is the failure the height rules exist to avoid.
 */
export const CAPTURE_DEADLINE_MS = 180_000

/**
 * The setting's own label, defined once.
 *
 * The result page names this control so a reader can go and change it, and a name that does not
 * match what the settings page actually says sends them looking for something that is not there.
 * `verify-web.mjs` asserts the markup still carries it -- nothing in the test suite can, because the
 * label lives in HTML the tests have no DOM for.
 */
export const LONG_PAGE_SETTING_LABEL = 'Pages that never stop loading'

export const LONG_PAGE_CHOICES: ReadonlyArray<{ policy: LongPagePolicy; label: string }> = [
  { policy: 'freeze', label: 'Stop at the starting height' },
  { policy: 'follow', label: 'Follow it a little further' },
  { policy: 'unbounded', label: 'Keep going until it ends' },
]

/**
 * The deepest this capture may go, in CSS pixels, given the height the page had when it started.
 *
 * `frozenHeight` is measured once and never re-measured, which is the whole mechanism. Re-reading
 * the document height every section -- what this replaced -- moves the finish line away as fast as
 * capture walks towards it, so a feed is never finished and no threshold anywhere else can rescue
 * that. Freezing it means the loop terminates by construction rather than by heuristic.
 */
export function depthAllowance(
  policy: LongPagePolicy,
  frozenHeight: number,
  captureHeight: number,
  extraSections: number = FOLLOW_EXTRA_SECTIONS,
): number {
  if (policy === 'unbounded') return Number.POSITIVE_INFINITY
  if (policy === 'freeze') return Math.max(0, frozenHeight)
  return Math.max(0, frozenHeight) + Math.max(0, captureHeight) * Math.max(0, extraSections)
}

/**
 * Whether the page has outgrown what this policy allows, which is the one thing worth telling the
 * user about: it means the sections below are a prefix of something still being written, not a
 * short page. `unbounded` can never reach it, so it can never say so.
 */
export function outgrewAllowance(documentHeight: number, allowance: number): boolean {
  return documentHeight > allowance + 1
}

/** Whether a capture that began at `startedAt` has used its whole budget. */
export function deadlineReached(
  startedAt: number,
  now: number,
  budgetMs: number = CAPTURE_DEADLINE_MS,
): boolean {
  return now - startedAt >= budgetMs
}

const LONG_PAGE_POLICY_KEY = 'longPagePolicy'

function isLongPagePolicy(value: unknown): value is LongPagePolicy {
  return value === 'freeze' || value === 'follow' || value === 'unbounded'
}

/**
 * Stored beside the captures rather than in `chrome.storage.local`, for the same reason the history
 * settings are: `chrome.storage` needs a permission, and the permission list is an invariant here.
 */
export async function getLongPagePolicy(): Promise<LongPagePolicy> {
  const stored = await getSetting<unknown>(LONG_PAGE_POLICY_KEY)
  return isLongPagePolicy(stored) ? stored : DEFAULT_LONG_PAGE_POLICY
}

export async function setLongPagePolicy(policy: LongPagePolicy): Promise<void> {
  await putSetting(LONG_PAGE_POLICY_KEY, policy)
}
