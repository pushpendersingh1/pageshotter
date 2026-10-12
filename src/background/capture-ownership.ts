/**
 * Which capture owns which tab.
 *
 * One capture owns a tab at a time. The reservation must exist **before the first await**: the
 * first version set `activeTabs` only after `putJob` resolved, so two requests for the same tab —
 * a keyboard command racing the popup — both passed the guard and both drove a capture loop over
 * one page.
 *
 * Release is owner-checked, so a finishing capture can only ever free the reservation it made
 * itself and can never drop one a successor legitimately holds.
 */
export class CaptureOwnership {
  private readonly owners = new Map<number, string>()

  /** Claims the tab for `jobId`; `false` means another capture already owns it. */
  reserve(tabId: number, jobId: string): boolean {
    if (this.owners.has(tabId)) return false
    this.owners.set(tabId, jobId)
    return true
  }

  /** Frees the tab only if this capture is still its owner. */
  release(tabId: number, jobId: string): void {
    if (this.owners.get(tabId) === jobId) this.owners.delete(tabId)
  }

  owner(tabId: number): string | undefined {
    return this.owners.get(tabId)
  }
}
