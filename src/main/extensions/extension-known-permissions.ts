// The single list of manifest permission names this app actually serves --
// through the vendored library (`contextMenus`: api/context-menus.ts;
// `cookies`: api/cookies.ts; `notifications`: api/notifications.ts;
// `webNavigation`: api/web-navigation.ts) or through Orivon's own code.
// Electron's own native manifest parser does not recognise every one of
// these names (it logs `ExtensionLoadWarning: Permission 'X' is unknown`
// regardless), which reads as "this permission does not work here" for a
// permission that, in fact, does -- installExtensionPermissionWarningFilter
// below is what that misleads, by dropping exactly the warning lines that
// name one of these. One array, so a permission this app newly implements
// stops warning the moment its name is added here, in one place.
export const IMPLEMENTED_EXTENSION_PERMISSIONS: readonly string[] = [
  'contextMenus',
  'cookies',
  'notifications',
  'webNavigation',
]

const UNKNOWN_PERMISSION_LINE = /^Permission '([^']+)' is unknown\.$/

/**
 * The decision: an `ExtensionLoadWarning` message with every
 * `Permission 'X' is unknown` line naming a permission in
 * `IMPLEMENTED_EXTENSION_PERMISSIONS` removed, or `undefined` if that
 * removes every line the warning had (nothing left worth printing a header
 * over). A message with no such line at all, or with at least one naming a
 * permission NOT in the list, is returned unchanged -- filtering never
 * silences a genuinely unknown permission because it shares a warning with
 * an implemented one.
 */
export function filterExtensionLoadWarning (message: string): string | undefined {
  const lines = message.split('\n').filter((line) => {
    const match = UNKNOWN_PERMISSION_LINE.exec(line.trim())
    const permissionName = match?.[1]
    return permissionName === undefined || !IMPLEMENTED_EXTENSION_PERMISSIONS.includes(permissionName)
  })
  return lines.length <= 1 ? undefined : lines.join('\n')
}

/**
 * The I/O: installs a `process.on('warning', ...)` filter that rewrites
 * (or, per `filterExtensionLoadWarning`, drops) an `ExtensionLoadWarning`
 * before handing it to whatever was already listening (Node's own default
 * printer, ordinarily) -- every other warning passes through untouched.
 * Call once, before the first `session.extensions.loadExtension()` of the
 * process (`extensions-subsystem.ts`'s own `afterReady`) -- a warning fired
 * before this runs prints as before.
 */
export function installExtensionPermissionWarningFilter (): void {
  const previousListeners = process.listeners('warning') as ReadonlyArray<(warning: Error) => void>
  process.removeAllListeners('warning')
  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExtensionLoadWarning') {
      const filtered = filterExtensionLoadWarning(warning.message)
      if (filtered === undefined) return
      warning.message = filtered
    }
    for (const listener of previousListeners) listener(warning)
  })
}
