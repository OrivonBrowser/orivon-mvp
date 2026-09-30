// Runs a command on a window from anywhere that can name one: the keys, the
// main menu popover. The runner's dependencies (opening a window, quitting)
// exist only once the process has started, so they are bound after the
// services are built.
import type { ClosedEntry } from '../session-restore/closed-stack.js'
import { reopenEntry } from '../session-restore/reopen.js'
import type { ReopenResult } from '../session-restore/reopen.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { CommandId } from './commands.js'
import { runCommand } from './run-command.js'
import type { CommandDeps } from './run-command.js'

export class CommandBus {
  private deps: CommandDeps | null = null

  bind (deps: CommandDeps): void {
    this.deps = deps
  }

  run (id: CommandId, target: ShellWindow): void {
    if (this.deps !== null) runCommand(id, target, this.deps)
  }

  /** Brings back one chosen entry of the closed stack, as the reopen key does the newest. */
  reopen (entry: ClosedEntry, target: ShellWindow): ReopenResult | undefined {
    return this.deps === null ? undefined : reopenEntry(entry, target, this.deps)
  }
}
