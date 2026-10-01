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

/** How long a worker waits for the saved shortcuts before it is answered with what is known (nothing bound yet). */
export const READY_WAIT_MS = 30_000

let warned = false

/** Waits for the saved shortcuts, but never forever: the subsystem may fail after it provided the keys and before it could report them ready. */
async function whenReadyOrLate (keys: CommandKeysReader, waitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      if (!warned) {
        warned = true
        console.error('[extensions] the shortcuts were not ready in time; commands.getAll answers without their keys')
      }
      resolve()
    }, waitMs)
  })
  try {
    await Promise.race([keys.whenReady(), late])
  } finally {
    clearTimeout(timer)
  }
}

export function createCommandsApi (waitMs: number): ExtensionApiModule {
  return {
    name: 'commands',
    install: (ctx) => {
      ctx.handle('commands.getAll', async ({ extension }) => {
        const keys = await source
        // The saved shortcuts decide which suggested key is free, so a worker that starts early waits for them.
        await whenReadyOrLate(keys, waitMs)
        return keys.getAll(extension.id)
      })
    }
  }
}

export const commandsApi: ExtensionApiModule = createCommandsApi(READY_WAIT_MS)
