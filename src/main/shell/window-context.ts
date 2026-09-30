import type { ShellServices } from './shell-services.js'
import type { ShellWindow } from './window-registry.js'

/** What a per-window hook receives: the window and the services shared by every window. */
export interface WindowContext {
  readonly window: ShellWindow
  readonly services: ShellServices
}
