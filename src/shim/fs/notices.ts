// What fs.watch hears. Every mutating call in this package announces the
// confined path it changed: to the watchers of this context directly, and to
// every other context of the same app on one BroadcastChannel (a channel is
// scoped to its origin, so an app's notices never reach another app). Only a
// write made through the shim is announced; README.md's Design notes say why.
//
// Contexts also tell each other how many watchers they hold. That lets a
// creating write pay for one existence check, to tell 'rename' (created) from
// 'change' (rewritten), only when someone is watching.

export type WatchKind = 'rename' | 'change'
export type NoticeListener = (path: string, kind: WatchKind) => void

type Message =
  | { readonly t: 'fs', readonly path: string, readonly kind: WatchKind }
  | { readonly t: 'hello' }
  | { readonly t: 'watching', readonly from: string, readonly count: number }

const CHANNEL_NAME = 'orivon.fs.watch'
const contextId = Math.random().toString(36).slice(2)
const local = new Set<NoticeListener>()
const remote = new Map<string, number>()
let channel: BroadcastChannel | undefined
let attempted = false

/** A path in the form every announcement and watcher shares: no leading `./` or `/`, no trailing `/`, `''` for the app's root. */
export function normalizeNoticePath (path: string): string {
  return path.split('/').filter((part) => part !== '' && part !== '.').join('/')
}

function dispatch (path: string, kind: WatchKind): void {
  for (const listener of [...local]) queueMicrotask(() => { if (local.has(listener)) listener(path, kind) })
}

function tellCount (): void {
  channel?.postMessage({ t: 'watching', from: contextId, count: local.size } satisfies Message)
}

function open (): BroadcastChannel | undefined {
  if (attempted) return channel
  attempted = true
  if (typeof BroadcastChannel === 'undefined') return undefined
  const opened = new BroadcastChannel(CHANNEL_NAME)
  // Node's channel keeps its process alive; a page's has no such method.
  ;(opened as { unref?: () => void }).unref?.()
  opened.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data
    if (message.t === 'fs') dispatch(message.path, message.kind)
    else if (message.t === 'hello') { if (local.size > 0) tellCount() }
    else if (message.count === 0) remote.delete(message.from)
    else remote.set(message.from, message.count)
  }
  channel = opened
  opened.postMessage({ t: 'hello' } satisfies Message)
  return opened
}

/** Registers `listener` for every announcement, this context's and others'. Returns the function that removes it. */
export function subscribe (listener: NoticeListener): () => void {
  open()
  local.add(listener)
  tellCount()
  return () => {
    local.delete(listener)
    tellCount()
  }
}

/** True when some context is known to be watching, so a creating write is worth an existence check. */
export function watchersExist (): boolean {
  if (!attempted) open()
  if (local.size > 0) return true
  for (const count of remote.values()) if (count > 0) return true
  return false
}

export function announce (path: string, kind: WatchKind): void {
  const normalized = normalizeNoticePath(path)
  dispatch(normalized, kind)
  open()?.postMessage({ t: 'fs', path: normalized, kind } satisfies Message)
}

/** A write that created its file reads 'rename' then 'change', as inotify's create and modify do; a rewrite is 'change' alone. `existed` is unknown-true when nobody watched at the time. */
export function announceWrite (path: string, existed: boolean): void {
  if (!existed) announce(path, 'rename')
  announce(path, 'change')
}

/** Whether a write opened with `flags` can create its file. */
export function canCreate (flags: string): boolean {
  return /^[wa]/.test(flags)
}
