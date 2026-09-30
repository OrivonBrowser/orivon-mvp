// What a cold start opens. The one place that decides it: a feature that changes the first window
// (a session to restore, a home page, an address on the command line) is a line here, not in index.ts.
import type { ShellServices } from './shell-services.js'
import type { ShellWindowOptions } from './window-options.js'

export interface FirstWindowInput {
  readonly services: ShellServices
  readonly isPrivate: boolean
  /** The process's own command line. */
  readonly argv: readonly string[]
}

export function firstWindowOptions (_input: FirstWindowInput): ShellWindowOptions {
  return {}
}
