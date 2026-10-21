// The details page's "Run in private windows" switch: whether a private window starts with a copy
// of the extension (`../launch/private-extensions.ts`). The choice is kept in the profile's prefs and
// read when a private window opens, so a change reaches the windows opened afterwards. Pure over
// the prefs store.
import type { ExtensionPart } from './extensions-detail-parts.js'
import type { ExtensionsDomainDeps } from './extensions-domain.js'

export interface PrivateWindowsDetails {
  readonly enabled: boolean
}

/** Nothing inside a private window, whose copies are changed in a normal window, so the page leaves the switch out. */
export const privateWindowsPart: ExtensionPart = (entry, _facts, deps) => {
  if (deps.isPrivate) return {}
  const details: PrivateWindowsDetails = { enabled: deps.prefs.get(entry.id).privateWindows }
  return { privateWindows: details }
}

export function setPrivateWindows (body: Readonly<Record<string, unknown>>, deps: ExtensionsDomainDeps): { ok: true } | undefined {
  const { id, enabled } = body
  if (deps.isPrivate || typeof id !== 'string' || typeof enabled !== 'boolean') return undefined
  if (!deps.extensions.list().some((entry) => entry.id === id)) return undefined
  deps.prefs.update(id, { privateWindows: enabled })
  return { ok: true }
}
