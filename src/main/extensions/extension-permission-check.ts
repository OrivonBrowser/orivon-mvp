// The one answer to "does this extension hold this permission right now",
// installed as the router's permission check (`api/install-apis.ts` makes
// the one setPermissionCheck call, so this file stays free of the library). Three sources, in order: the original record of a permission
// `loadableManifest` strips from the loaded copy; the loaded manifest's own
// `permissions`; then the optional permissions the person granted at runtime.
// Every handler registered with a `permission`, and every event gate built on
// `held`, reads this and nothing else.
import type { ExtensionPrefsStore } from './extension-prefs.js'

const DNR_PERMISSION = 'declarativeNetRequest'
const DNR_HOST_ACCESS_PERMISSION = 'declarativeNetRequestWithHostAccess'

/** A permission `loadableManifest` strips from the loaded copy (native
 * messaging and every `webRequest*`/`declarativeNetRequest*` name,
 * `src/main/extensions/README.md`'s Design notes): answered from the
 * ORIGINAL record instead of the loaded manifest. */
export function isStrippedPermissionName (permission: string): boolean {
  return permission === 'nativeMessaging' || permission.startsWith('declarativeNetRequest') || permission.startsWith('webRequest')
}

export interface PermissionCheckDeps {
  /** The extension's pre-strip permission list, `[]` when it is not loaded. */
  readonly stripped: (extensionId: string) => readonly string[]
  /** The loaded manifest's own `permissions`, undefined when not loaded. */
  readonly manifestPermissions: (extensionId: string) => readonly string[] | undefined
  readonly prefs: ExtensionPrefsStore
}

export type PermissionHeld = (extensionId: string, permission: string) => boolean

/** Chrome unlocks `chrome.declarativeNetRequest` for either
 * `declarativeNetRequest` or `declarativeNetRequestWithHostAccess`, so the
 * plain name is read as "either"; `declarativeNetRequestFeedback` never
 * stands in for it. */
export function createPermissionHeld (deps: PermissionCheckDeps): PermissionHeld {
  return (extensionId, permission) => {
    if (permission === DNR_PERMISSION) {
      const stripped = deps.stripped(extensionId)
      return stripped.includes(DNR_PERMISSION) || stripped.includes(DNR_HOST_ACCESS_PERMISSION)
    }
    if (isStrippedPermissionName(permission)) return deps.stripped(extensionId).includes(permission)
    if (deps.manifestPermissions(extensionId)?.includes(permission) === true) return true
    return deps.prefs.get(extensionId).granted.permissions.includes(permission)
  }
}

let installed: PermissionHeld | undefined

/** Builds the check, registers it with `register` (the router's
 * `setPermissionCheck`) and returns it; `permissionHeld` answers from it
 * afterwards. */
export function installPermissionCheck (deps: PermissionCheckDeps, register: (check: PermissionHeld) => void): PermissionHeld {
  const held = createPermissionHeld(deps)
  installed = held
  register(held)
  return held
}

/** False until `installPermissionCheck` ran. */
export function permissionHeld (extensionId: string, permission: string): boolean {
  return installed?.(extensionId, permission) ?? false
}
