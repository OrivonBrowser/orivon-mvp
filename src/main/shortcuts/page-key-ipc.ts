// The one command a registered app's page may ask of the browser: the find bar, for a Ctrl+F the app left
// unhandled. A browser key reaches an app's tab untouched (`yieldToApp` in commands.ts), so the page's preload
// reports the press nobody took, and main decides here whether it is allowed to open anything.
import type { IpcMainEvent, WebContents } from 'electron'
import { PAGE_KEY_CHANNEL } from '../channels.js'
import type { CommandId } from './commands.js'

/** What a page may ask for. Each entry is a command the browser also binds to a key the app was given first. */
const PAGE_KEY_COMMANDS: ReadonlySet<string> = new Set<CommandId>(['find.open'])

/** Messages a tab may send per second; a page that floods this channel gets the rest dropped. */
export const PAGE_KEYS_PER_SECOND = 5

export interface PageKeyTab {
  /** The tab is the one in front of its window. */
  readonly active: boolean
  /** The tab is a registered app's. */
  readonly isAppTab: boolean
  /** A page in the window holds the screen, so the browser's keys wait. */
  readonly suspended: boolean
  readonly run: (id: CommandId) => void
}

export interface PageKeyHost {
  /** The tab `contents` is in a window of this shell, or null when it is in none. */
  readonly tabOf: (contents: WebContents) => PageKeyTab | null
}

type Listener = (event: IpcMainEvent, payload: unknown) => void

/** At most `limit` messages per second for each sender. */
export function createPerSecondLimiter (limit: number, now: () => number = Date.now): (key: number) => boolean {
  const windows = new Map<number, { start: number, count: number }>()
  return (key) => {
    const at = now()
    const current = windows.get(key)
    if (current === undefined || at - current.start >= 1000) {
      windows.set(key, { start: at, count: 1 })
      return true
    }
    if (current.count >= limit) return false
    current.count += 1
    return true
  }
}

export function createPageKeyListener (host: PageKeyHost, allow: (key: number) => boolean): Listener {
  return (event, payload) => {
    // A subframe has no preload that sends this: a message from one is not from this shell's own script.
    if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return
    if (typeof payload !== 'object' || payload === null) return
    const command = (payload as { command?: unknown }).command
    if (typeof command !== 'string' || !PAGE_KEY_COMMANDS.has(command)) return
    const tab = host.tabOf(event.sender)
    // The command acts on the window's tab in front, so only that tab may ask.
    if (tab === null || !tab.active || !tab.isAppTab || tab.suspended) return
    if (!allow(event.sender.id)) return
    tab.run(command as CommandId)
  }
}

export interface PageKeyIpc {
  on: (channel: string, listener: Listener) => unknown
}

export function installPageKeyIpc (ipc: PageKeyIpc, host: PageKeyHost): void {
  ipc.on(PAGE_KEY_CHANNEL, createPageKeyListener(host, createPerSecondLimiter(PAGE_KEYS_PER_SECOND)))
}
