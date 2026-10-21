// A private runtime keeps nothing after it ends and installs nothing: it runs only the extensions
// the person allowed in private windows, copied in when the session began, so every route that
// would install one refuses first. The check sits at the head of each entry point (before any
// manifest is read or download started), not only in `finishInstall`, so no side effect of the
// attempt survives either.
import type { InstallContext, InstallOutcome } from './install-runner.js'

export const PRIVATE_INSTALL_REASON = 'Extensions cannot be added in a private window. Add them in a normal window.'

/** Why an extension cannot be removed, turned off or allowed in private windows from a private window. */
export const PRIVATE_CHANGE_REASON = 'Extensions are changed in a normal window.'

/** The refusal to return from an install entry point, or undefined when the
 * runtime may install. */
export function refusePrivateInstall (ctx: Pick<InstallContext, 'privateSession'>): InstallOutcome | undefined {
  return ctx.privateSession === true ? { installed: false, reason: PRIVATE_INSTALL_REASON } : undefined
}
