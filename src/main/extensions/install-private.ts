// A private or guest runtime keeps nothing after it ends and never runs an
// extension, so every route that would install one refuses first. The check
// sits at the head of each entry point (before any manifest is read or
// download started), not only in `finishInstall`, so no side effect of the
// attempt survives either.
import type { InstallContext, InstallOutcome } from './install-runner.js'

export const PRIVATE_INSTALL_REASON = 'Extensions are not available in a private or guest window.'

/** The refusal to return from an install entry point, or undefined when the
 * runtime may install. */
export function refusePrivateInstall (ctx: Pick<InstallContext, 'privateSession'>): InstallOutcome | undefined {
  return ctx.privateSession === true ? { installed: false, reason: PRIVATE_INSTALL_REASON } : undefined
}
