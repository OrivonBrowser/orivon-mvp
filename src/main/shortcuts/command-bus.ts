// Runs a command on a window from anywhere that can name one: the keys, the
// main menu popover. The runner's dependencies (opening a window, quitting)
// exist only once the process has started, so they are bound after the
// services are built.
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
}
