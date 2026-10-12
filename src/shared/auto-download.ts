/**
 * Whether a finished capture can be saved without anyone watching.
 *
 * Two surfaces have to agree on this and they cannot see each other's reasoning: the service worker
 * decides whether to open the result tab in the background, and the result page decides whether to
 * save and close itself. If they ever disagreed the failure is invisible and bad in both directions
 * -- a background tab that sits there forever having saved nothing, or a foreground tab that
 * downloads and vanishes while the user is reading it. So the rule lives here and both call it.
 *
 * The permission is the whole subtlety. An anchor download needs none but cannot name a folder, so
 * an unattended save into a folder needs `downloads` -- and `downloads` is optional, requested from
 * a click. There is no click here. When it has not been granted, this returns false and the capture
 * opens normally, which is the only path that can ask for it.
 */
export function canSaveUnattended(
  autoDownload: boolean,
  folder: string,
  downloadsGranted: boolean,
): boolean {
  if (!autoDownload) return false
  return folder === '' || downloadsGranted
}
