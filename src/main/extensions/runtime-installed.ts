// What `chrome.runtime.onInstalled` delivers. Electron never dispatches that
// event, so an install or update parks its details here before the extension
// loads, and the extension's worker takes them once as it starts
// (api/runtime-api.ts answers it, preload/extension-apis/runtime.ts fires the
// listeners).

export interface InstalledDetails {
  readonly reason: 'install' | 'update'
  readonly previousVersion?: string
}

/** A worker that never starts (or does not ask) must not see an install long after it happened. */
export const INSTALLED_DETAILS_TTL_MS = 60_000

const pending = new Map<string, { readonly details: InstalledDetails, readonly at: number }>()

export function registerPendingInstalled (extensionId: string, details: InstalledDetails, now: number = Date.now()): void {
  pending.set(extensionId, { details, at: now })
}

export function clearPendingInstalled (extensionId: string): void {
  pending.delete(extensionId)
}

/** The details parked for `extensionId`, once: a restarted worker gets none. */
export function takePendingInstalled (extensionId: string, now: number = Date.now()): InstalledDetails | undefined {
  const held = pending.get(extensionId)
  pending.delete(extensionId)
  if (held === undefined || now - held.at > INSTALLED_DETAILS_TTL_MS) return undefined
  return held.details
}
