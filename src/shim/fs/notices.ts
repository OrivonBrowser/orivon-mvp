// What fs.watch hears. Every mutating call in this package announces the
// confined path it changed: to the watchers of this context directly, and to
// every other context of the same app on one BroadcastChannel (a channel is
// scoped to its origin, so an app's notices never reach another app). Only a
// write made through the shim is announced; README.md's Design notes say why.
//
// Contexts also tell each other how many watchers they hold, and repeat it while
// they hold any. That lets a creating write pay for one existence check, to tell
// 'rename' (created) from 'change' (rewritten), only when someone is watching, and
// lets a context that has had time to hear from every watcher stop posting when
// none is left. A count that is not repeated lapses, so a context that died
// without saying so is forgotten.

import { CREATE_IN_PLACE } from './flags.js'

export type WatchKind = 'rename' | 'change'
export type NoticeListener = (path: string, kind: WatchKind) => void

type Message =
  | { readonly t: 'fs', readonly path: string, readonly kind: WatchKind }
  | { readonly t: 'hello' }
  | { readonly t: 'watching', readonly from: string, readonly count: number }

const CHANNEL_NAME = 'orivon.fs.watch'
const contextId = Math.random().toString(36).slice(2)
/** How often a context holding watchers repeats its count. */
const HEARTBEAT_MS = 10_000
/** A count older than this, unrepeated, no longer counts: two beats may be lost before it lapses. */
const LAPSE_MS = 3 * HEARTBEAT_MS
/** After opening its channel a context posts every notice: a watcher it has not heard of repeats itself within one beat. */
const SETTLE_MS = HEARTBEAT_MS + 1_000

const local = new Set<NoticeListener>()
const remote = new Map<string, { readonly count: number, readonly at: number }>()
let channel: BroadcastChannel | undefined
let attempted = false
let openedAt = 0
let beat: unknown

/** A path in the form every announcement and watcher shares: no leading `./` or `/`, no trailing `/`, `''` for the app's root. */
export function normalizeNoticePath (path: string): string {
  return path.split('/').filter((part) => part !== '' && part !== '.').join('/')
}

function dispatch (path: string, kind: WatchKind): void {
  for (const listener of [...local]) queueMicrotask(() => { if (local.has(listener)) listener(path, kind) })
}

function tellCount (): void {
  channel?.postMessage({ t: 'watching', from: contextId, count: local.size } satisfies Message)
  if (local.size > 0 && beat === undefined) {
    beat = setInterval(tellCount, HEARTBEAT_MS)
    // Node's timer would keep a process alive for a context that only repeats a count.
    ;(beat as { unref?: () => void }).unref?.()
  } else if (local.size === 0 && beat !== undefined) {
    clearInterval(beat as Parameters<typeof clearInterval>[0])
    beat = undefined
  }
}

/** True when a count heard lately says another context is watching; counts that have lapsed are forgotten. */
function remoteWatching (): boolean {
  const now = Date.now()
  let watching = false
  for (const [from, { count, at }] of remote) {
    if (now - at > LAPSE_MS) remote.delete(from)
    else if (count > 0) watching = true
  }
  return watching
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
    else remote.set(message.from, { count: message.count, at: Date.now() })
  }
  channel = opened
  openedAt = Date.now()
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
  return local.size > 0 || remoteWatching()
}

export function announce (path: string, kind: WatchKind): void {
  const normalized = normalizeNoticePath(path)
  dispatch(normalized, kind)
  const opened = open()
  // Another context needs the notice only if it watches, and a context hears of one by its count.
  if (opened !== undefined && (Date.now() - openedAt < SETTLE_MS || remoteWatching())) opened.postMessage({ t: 'fs', path: normalized, kind } satisfies Message)
}

/** A write that created its file reads 'rename' then 'change', as inotify's create and modify do; a rewrite is 'change' alone. `existed` is unknown-true when nobody watched at the time. */
export function announceWrite (path: string, existed: boolean): void {
  if (!existed) announce(path, 'rename')
  announce(path, 'change')
}

/** Whether a write opened with `flags` can create its file. */
export function canCreate (flags: string): boolean {
  return /^[wa]/.test(flags) || flags === CREATE_IN_PLACE
}
