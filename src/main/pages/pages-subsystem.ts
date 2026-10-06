// Registers the internal pages' scheme and the shell's own `orivon-shell` one -- and, at ADR-0041's one call site,
// the extensions library's 'crx' scheme too -- before the app is ready, and
// the internal pages' own session and the shell scheme's handlers after it. Reads neither ctx.broker nor
// ctx.loader, so it has no ordering constraint from the list.
import type { Subsystem } from '../registry.js'
import { installInternalSession, registerInternalScheme } from './internal-session.js'
import { installShellScheme } from './shell-scheme.js'

export const pagesSubsystem: Subsystem = {
  name: 'pages',
  beforeReady: registerInternalScheme,
  afterReady: () => {
    installInternalSession(import.meta.dirname)
    installShellScheme(import.meta.dirname)
  }
}
