// A fake ExtensionApiContext for the library API modules: handlers are recorded and called by name, events
// are collected, and the shell's stores are the real ones where a test builds them.
import type { ApiEvent, ExtensionApiContext } from '../api-types.js'

export const EXT = 'a'.repeat(32)

export type Handler = (event: ApiEvent, ...args: unknown[]) => unknown

export interface SentEvent { readonly name: string, readonly args: unknown[] }

export function fakeContext (shell: Record<string, unknown>, over: Partial<ExtensionApiContext> = {}) {
  const handlers = new Map<string, { run: Handler, opts: unknown }>()
  const events: SentEvent[] = []
  const ctx = {
    handle: (name: string, run: Handler, opts?: unknown) => { handlers.set(name, { run, opts }) },
    sendEvent: (_id: string | undefined, name: string, ...args: unknown[]) => { events.push({ name, args }) },
    shell: () => shell,
    onShell: (run: (shell: never) => void) => { run(shell as never) },
    isAppOrigin: (url: string) => url.startsWith('https://app.example'),
    held: () => true,
    session: { extensions: { getAllExtensions: () => [{ id: EXT }], on: () => {} } },
    tab: () => undefined,
    activeTab: () => undefined,
    ...over
  } as unknown as ExtensionApiContext
  const event = (id = EXT): ApiEvent => ({ type: 'frame', sender: undefined, extension: { id, manifest: {} } })
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const found = handlers.get(name)
    if (found === undefined) throw new Error(`no handler ${name}`)
    return await found.run(event(), ...args)
  }
  return { ctx, handlers, events, call, event }
}

/** Waits for the microtask the bookmark watcher defers a diff to. */
export const settled = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }
