// What a page's `navigator.permissions.query` reads for a permission it would still be asked about. Electron answers
// that query from the session's permission check, which can only say true or false, so a camera nobody decided
// reads `denied` and a page that checks before it asks (an extension's webcam check, a site's) stops there. The
// top frame's preload (src/preload/permission-query.ts) asks here only when the engine said `denied`; the per-site
// askers answer from the decision a request from the same page would take (`SiteAsker.query`). Read strictly: the
// origin is the sender frame's own, and a message holds one name and nothing else.
import type { IpcMainInvokeEvent } from 'electron'
import { PERMISSION_QUERY_CHANNEL } from '../channels.js'
import type { QueryState, SiteAsks } from './site-asks.js'

/** Longer than any permission name; a longer string is not one. */
const NAME_MAX = 64

const STATES: readonly string[] = ['granted', 'denied', 'prompt']

/** `{ name }` and nothing else, or undefined. */
export function readQuery (raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const { name } = record
  if (Object.keys(record).length !== 1 || typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) return undefined
  return name
}

export interface PermissionQueryIpcDeps {
  ipc: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => unknown) => void }
  asks: Pick<SiteAsks, 'query'>
}

export function registerPermissionQueryIpc (deps: PermissionQueryIpcDeps): void {
  deps.ipc.handle(PERMISSION_QUERY_CHANNEL, (event, raw): QueryState | null => {
    const name = readQuery(raw)
    const contents = event.sender
    const frame = event.senderFrame
    if (name === undefined || contents.isDestroyed() || frame === null || frame !== contents.mainFrame) return null
    try {
      // The committed origin of the frame that called, which the page cannot set; a frame destroyed under the call throws.
      const origin: unknown = frame.origin
      if (typeof origin !== 'string') return null
      const state = deps.asks.query(contents, name, origin)
      return state !== undefined && STATES.includes(state) ? state : null
    } catch {
      return null
    }
  })
}
