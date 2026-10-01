// `chrome.commands.getAll`: the commands an extension declares with the key each
// holds now. The library answers with an empty shortcut for every command, so
// this registers over its handler on the same router. `onCommand` is fired by
// the shortcut dispatcher, not from here.
import type { ExtensionApiModule } from './api-types.js'

/** What this module reads of the command keys (`../extension-commands-runner.ts`). */
export interface CommandKeysReader {
  whenReady: () => Promise<void>
  getAll: (extensionId: string) => Array<{ name: string, description: string, shortcut: string }>
}

let provide: (keys: CommandKeysReader) => void = () => {}
let source = new Promise<CommandKeysReader>((resolve) => { provide = resolve })

/** The keys exist only after the subsystem has built them, which can be after an extension's worker has started and asked: it waits here. */
export function provideCommandKeys (keys: CommandKeysReader): void {
  provide(keys)
}

/** For a test: forgets the keys given so far. */
export function resetCommandKeys (): void {
  source = new Promise<CommandKeysReader>((resolve) => { provide = resolve })
}

export const commandsApi: ExtensionApiModule = {
  name: 'commands',
  install: (ctx) => {
    ctx.handle('commands.getAll', async ({ extension }) => {
      const keys = await source
      // The saved shortcuts decide which suggested key is free, so a worker that starts early waits for them.
      await keys.whenReady()
      return keys.getAll(extension.id)
    })
  }
}
