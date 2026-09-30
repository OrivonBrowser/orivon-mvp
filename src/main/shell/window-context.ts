// What a per-window hook or handler receives for the window it acts on.
import type { ShellServices } from './shell-services.js'
import type { ShellWindow } from './window-registry.js'

export interface WindowContext {
  readonly window: ShellWindow
  readonly services: ShellServices
}
