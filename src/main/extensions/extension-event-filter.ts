// What a broadcast event may carry to one listening extension: the per-
// listener filter the library's router asks before it delivers
// (setEventListenerFilter). Reads the loaded manifest, never a shell
// service, so it holds no state of its own.
import { session } from 'electron'
import { apiOrHostAccessFor, hasApiPermission, hostAccessFor } from './extension-host-access.js'
import { permissionHeld } from './extension-permission-check.js'

/** The four chrome.tabs fields Chrome itself only returns to an extension
 * holding `tabs` or a matching host permission -- the same set
 * vendor/.../src/browser/api/tabs.ts's own `filterTabDetails` strips for a
 * direct call, applied here to whatever shape a broadcast tabs.* event
 * argument carries (a full `chrome.tabs.Tab`, or `tabs.onUpdated`'s own
 * `changeInfo`, which may carry a subset of the same names). */
export function stripSensitiveTabFields (value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const copy = { ...(value as Record<string, unknown>) }
  delete copy.url
  delete copy.pendingUrl
  delete copy.title
  delete copy.favIconUrl
  return copy
}

/** A URL standing in for a broadcast `cookies.onChanged` event's own
 * cookie, for the same host-permission check `api/cookies.ts`'s own
 * `cookieUrl` applies to a direct `cookies.getAll` result -- duplicated
 * here in miniature rather than imported, since this file sits one layer
 * above that module (router.ts's per-listener filter, not a handler). */
export function cookieChangeUrl (cookie: { domain?: unknown, path?: unknown, secure?: unknown }): string | undefined {
  if (typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') return undefined
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  return `${cookie.secure === true ? 'https' : 'http'}://${domain}${cookie.path}`
}

/** What an event needs on top of its namespace's permission: given the
 * listener's extension and the event's own arguments, the arguments to
 * deliver, or undefined to deliver nothing. Keyed by the full event name,
 * one per line, alphabetical. */
export type EventGate = (query: { extensionId: string, manifest: unknown, args: readonly unknown[] }) => readonly unknown[] | undefined
export const EVENT_GATES: Readonly<Record<string, EventGate>> = {}

const NAMESPACE_PERMISSIONS = new Map<string, string>()

/** `install-apis.ts` registers each module's namespace with its permission:
 * an event named `<namespace>.<x>` then reaches only a listener holding it. */
export function registerEventPermission (namespace: string, permission: string): void {
  NAMESPACE_PERMISSIONS.set(namespace, permission)
}

/**
 * Installed with setEventListenerFilter (router.ts's own doc): per
 * listener, decides whether a broadcast event reaches `extensionId` at all,
 * and whether it carries every field or a stripped copy --
 * cookies.onChanged needs BOTH the `cookies` permission and host access to
 * the cookie's own URL (api/cookies.ts's UPSTREAM.md entry: the same rule
 * its own handlers apply); tabs.onCreated/onUpdated strip the four
 * sensitive fields (stripSensitiveTabFields above) unless the listener
 * holds `tabs` OR host access to the tab's URL (Chrome's own either/or
 * rule, `apiOrHostAccessFor`'s own doc); every other tabs.* event and every
 * webNavigation.* event either carries no such field (tabs.onActivated/
 * onRemoved) or requires the `webNavigation` permission outright.
 */
export function eventListenerFilter (extensionId: string, eventName: string, args: readonly unknown[]): readonly unknown[] | undefined {
  const manifest = session.defaultSession.extensions.getExtension(extensionId)?.manifest

  if (eventName === 'cookies.onChanged') {
    const changeInfo = args[0] as { cookie?: { domain?: unknown, path?: unknown, secure?: unknown } } | undefined
    const url = changeInfo?.cookie === undefined ? undefined : cookieChangeUrl(changeInfo.cookie)
    if (!hasApiPermission(manifest, 'cookies') || !hostAccessFor(extensionId, manifest, url)) return undefined
    return args
  }

  if (eventName === 'tabs.onCreated') {
    const details = args[0] as { url?: string } | undefined
    if (apiOrHostAccessFor(extensionId, manifest, 'tabs', details?.url)) return args
    return [stripSensitiveTabFields(details)]
  }

  if (eventName === 'tabs.onUpdated') {
    const [tabId, changeInfo, tab] = args as [unknown, unknown, { url?: string } | undefined]
    if (apiOrHostAccessFor(extensionId, manifest, 'tabs', tab?.url)) return args
    return [tabId, stripSensitiveTabFields(changeInfo), stripSensitiveTabFields(tab)]
  }

  if (eventName === 'windows.onCreated' || eventName === 'windows.onBoundsChanged') {
    const details = args[0] as { tabs?: Array<{ url?: string }> } | undefined
    if (details?.tabs === undefined) return args
    const tabs = details.tabs.map((tab) =>
      apiOrHostAccessFor(extensionId, manifest, 'tabs', tab?.url) ? tab : stripSensitiveTabFields(tab)
    )
    return [{ ...details, tabs }]
  }

  if (eventName.startsWith('webNavigation.')) {
    return hasApiPermission(manifest, 'webNavigation') ? args : undefined
  }

  const dot = eventName.indexOf('.')
  const required = dot < 0 ? undefined : NAMESPACE_PERMISSIONS.get(eventName.slice(0, dot))
  if (required !== undefined && !permissionHeld(extensionId, required)) return undefined
  const gate = EVENT_GATES[eventName]
  return gate === undefined ? args : gate({ extensionId, manifest, args })
}
