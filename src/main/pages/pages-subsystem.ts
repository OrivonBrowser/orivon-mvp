// Registers the internal pages' scheme before the app is ready, and their
// session after it. Reads neither ctx.broker nor ctx.loader, so it has no
// ordering constraint from the list.
import type { Subsystem } from '../registry.js'
import { installInternalSession, registerInternalScheme } from './internal-session.js'

export const pagesSubsystem: Subsystem = {
  name: 'pages',
  beforeReady: registerInternalScheme,
  afterReady: () => { installInternalSession(import.meta.dirname) }
}
