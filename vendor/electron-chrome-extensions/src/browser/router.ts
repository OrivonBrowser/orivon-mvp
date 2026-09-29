import { app, ipcMain } from 'electron'
import type { Session } from 'electron'
import debug from 'debug'

import { resolvePartition } from './partition'

// Shorten base64 encoded icons
const shortenValues = (k: string, v: any) =>
  typeof v === 'string' && v.length > 128 ? v.substr(0, 128) + '...' : v

debug.formatters.r = (value: any) => {
  return value ? JSON.stringify(value, shortenValues, '  ') : value
}

export type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainServiceWorkerEvent
export type IpcInvokeEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainServiceWorkerInvokeEvent
export type IpcAnyEvent = IpcEvent | IpcInvokeEvent

// Orivon patch (UPSTREAM.md patch 36): see waitForRegisteredExtension below.
const EXTENSION_REGISTRATION_WAIT_MS = 2000

/**
 * A genuine page of an already-loading extension can call a crx-msg
 * handler in the same tick its own webContents is created -- before
 * `session.extensions.getExtension(id)` reflects the load already in
 * flight (a real extension's popup script that calls a chrome.* API as its
 * first statement wins this race every time; a fixture popup whose calls
 * wait for a button click never does). `extensionId` is only ever set here
 * from `onRouterMessage`, which already refused the call if
 * `gMessageSenderIdCheck` was set and did not confirm `extensionId` names
 * THIS sender's own origin -- so waiting instead of refusing outright adds
 * no way for an unrelated page to spoof another extension's identity, only
 * a bounded grace period for the real owner to finish registering.
 */
interface ExtensionRegistryEvents {
  getExtension: (id: string) => Electron.Extension | null
  on: (event: 'extension-loaded', listener: (event: Electron.Event, extension: Electron.Extension) => void) => unknown
  removeListener: (event: 'extension-loaded', listener: (event: Electron.Event, extension: Electron.Extension) => void) => unknown
}

// Orivon patch (UPSTREAM.md patch 38): one pending wait per (extensions,
// extensionId), shared by every caller -- onRouterMessage's own crx-msg
// path AND onAddListener below both race the same registration, and a
// stale page of a disabled/reloading extension can call either one
// repeatedly; before this, EACH call created its own 'extension-loaded'
// listener and its own EXTENSION_REGISTRATION_WAIT_MS timer, so a page
// that never stops calling never stopped paying the full wait, and never
// stopped accumulating listeners, either. A WeakMap keyed on the real
// `extensions` object (one per session) so two sessions' pending waits
// never collide.
const pendingRegistrations = new WeakMap<ExtensionRegistryEvents, Map<string, Promise<Electron.Extension | undefined>>>()

async function waitForRegisteredExtension (
  extensions: ExtensionRegistryEvents,
  extensionId: string,
): Promise<Electron.Extension | undefined> {
  const already = extensions.getExtension(extensionId)
  if (already) return already

  let pending = pendingRegistrations.get(extensions)
  if (pending === undefined) {
    pending = new Map()
    pendingRegistrations.set(extensions, pending)
  }

  const existing = pending.get(extensionId)
  if (existing !== undefined) return existing

  const table = pending
  const promise = new Promise<Electron.Extension | undefined>((resolve) => {
    let settled = false
    const onLoaded = (_event: Electron.Event, extension: Electron.Extension): void => {
      if (settled || extension.id !== extensionId) return
      settled = true
      clearTimeout(timer)
      extensions.removeListener('extension-loaded', onLoaded)
      resolve(extension)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      extensions.removeListener('extension-loaded', onLoaded)
      resolve(extensions.getExtension(extensionId) ?? undefined)
    }, EXTENSION_REGISTRATION_WAIT_MS)
    extensions.on('extension-loaded', onLoaded)
  })
  void promise.finally(() => { table.delete(extensionId) })

  pending.set(extensionId, promise)
  return await promise
}

/**
 * Linear-time match of one Chrome-style glob (`*` = any run of characters,
 * everything else literal -- the only operator `sandbox.pages` grammar
 * has) against `text`. Orivon patch (UPSTREAM.md patch 39): replaces a
 * regex built from `pattern.split('*').map(escapeRegExp).join('.*')` --
 * correct, but a pattern with several `*`s is a backtracking regex built
 * from the extension's OWN manifest and run on every page load and every
 * crx-msg, on the main thread: a pathological pattern
 * (`'a*a*a*a*a*a*a*a*a*a*a*a*a*a*!'`) against a long, almost-matching
 * string is the textbook catastrophic-backtracking shape. This never
 * builds a regex at all: split on `*`, then `indexOf` each literal piece
 * in order, anchoring the first piece to the start and the last to the
 * end -- O(pattern length + text length) however many stars the pattern
 * has.
 */
function matchesGlob (pattern: string, text: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === text

  const first = parts[0] ?? ''
  if (!text.startsWith(first)) return false
  const last = parts[parts.length - 1] ?? ''
  if (!text.endsWith(last)) return false

  let pos = first.length
  const end = text.length - last.length
  if (pos > end) return false // not even room for the two anchors, let alone anything between

  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i] ?? ''
    if (piece.length === 0) continue // adjacent '**', or a '*' beside another
    const found = text.indexOf(piece, pos)
    if (found === -1 || found > end) return false
    pos = found + piece.length
  }
  return pos <= end
}

/**
 * Orivon patch (UPSTREAM.md patch 37, normalisation added by patch 39,
 * corrected by patch 41): true if `url`'s own path matches one of `pages`
 * (an extension's manifest `sandbox.pages`). Exported through
 * `orivon:crx-extensions-router` (electron-chrome-extensions-lib.d.ts) so
 * extension-host.ts's own preload-time query (the vendored preload decides
 * whether to inject any chrome.* at all) answers the identical question
 * onExtensionMessage below asks on every message -- one matcher, not two
 * that could drift apart. `pages` is never capped or truncated here:
 * `src/broker/policy/extension-manifest.ts`'s own `MAX_SANDBOX_PAGES`
 * refuses to load a manifest with too many entries instead, so every
 * `pages` array this ever sees in a real session already fits -- silently
 * skipping some of a declared list here, as an earlier version of this
 * function did, would leave a page past the cut still declared sandboxed
 * by the manifest and still served by Electron, unrecognised by this
 * matcher: no CSP, chrome.* injected, no router refusal, a silent bypass.
 * Normalises both sides the way Chromium's own
 * `ExtensionURLToRelativeFilePath` does before it turns this URL into the
 * on-disk file it actually serves: ALL of a manifest entry's own leading
 * `/` and `\` are stripped (not only the first, which let
 * `chrome-extension://<id>//sandbox.html` or a leading `\` serve the real
 * sandboxed file while comparing against a pathname this function still
 * saw as un-stripped, missing it entirely), and the URL's pathname is
 * percent-decoded (`%2E` and `.` name the same file) before having the
 * same leading separators stripped. A pathname that fails to decode (a
 * malformed percent-sequence) matches nothing, rather than being compared
 * encoded -- silently accepting the wrong string here would be worse than
 * refusing. `platform` defaults to `process.platform`, overridable for
 * tests: on win32 and darwin, whose filesystems resolve "SANDBOX.html" and
 * "sandbox.html" to the same file, Chromium serves the real sandboxed page
 * for either spelling, so the match is case-insensitive there too; Linux's
 * filesystem is case-sensitive (a differently-cased request 404s instead
 * of reaching the real file), and this stays case-sensitive there to
 * match.
 */
export function isSandboxPageUrl (
  pages: readonly string[] | undefined,
  url: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (pages === undefined || pages.length === 0) return false
  let rawPathname: string
  try {
    rawPathname = new URL(url).pathname
  } catch {
    return false
  }
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(rawPathname)
  } catch {
    return false
  }
  const pathname = decodedPathname.replace(/^[/\\]+/, '')
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const matchPathname = caseInsensitive ? pathname.toLowerCase() : pathname
  return pages.some((page) => {
    const pattern = page.replace(/^[/\\]+/, '')
    const matchPattern = caseInsensitive ? pattern.toLowerCase() : pattern
    return matchesGlob(matchPattern, matchPathname)
  })
}

const getSessionFromEvent = (event: IpcAnyEvent): Electron.Session => {
  if (event.type === 'service-worker') {
    return event.session
  } else {
    return event.sender.session
  }
}

const getHostFromEvent = (event: IpcAnyEvent) => {
  if (event.type === 'service-worker') {
    return event.serviceWorker
  } else {
    return event.sender
  }
}

const d = debug('electron-chrome-extensions:router')

const DEFAULT_SESSION = '_self'

interface RoutingDelegateObserver {
  session: Electron.Session
  onExtensionMessage(
    event: Electron.IpcMainInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ): Promise<void>
  addListener(listener: EventListener, extensionId: string, eventName: string): void
  removeListener(listener: EventListener, extensionId: string, eventName: string): void
}

let gRoutingDelegate: RoutingDelegate

/**
 * Orivon patch: an optional predicate `crx-msg-remote` is checked against
 * before being routed to another session's observer -- unset, every sender
 * in an observed session may address any other observed session's tabs and
 * windows APIs (browserAction.activate among them). Set once, before the
 * first remote message arrives (extension-host.ts's attachExtensionShell).
 */
type RemoteMessageSenderCheck = (event: IpcAnyEvent) => boolean
let gRemoteMessageSenderCheck: RemoteMessageSenderCheck | undefined

export function setRemoteMessageSenderCheck(check: RemoteMessageSenderCheck): void {
  gRemoteMessageSenderCheck = check
}

/**
 * Orivon patch: an optional predicate checked, on every `crx-msg`, against
 * the `extensionId` the message names -- unset, a page or worker of one
 * loaded extension can name any other loaded extension's id and reach its
 * handlers under that identity (permission checks in onExtensionMessage
 * read `extensionId`, not who actually sent the message). Set once, before
 * the first message arrives (extension-host.ts).
 */
type MessageSenderIdCheck = (event: IpcAnyEvent, claimedExtensionId: string | undefined) => boolean
let gMessageSenderIdCheck: MessageSenderIdCheck | undefined

export function setMessageSenderIdCheck(check: MessageSenderIdCheck): void {
  gMessageSenderIdCheck = check
}

/**
 * Orivon patch: an optional per-LISTENER transform/gate applied to an
 * event's own arguments right before delivery -- unset, sendEvent/
 * broadcastEvent deliver the identical `args` to every listener, regardless
 * of what that particular extension may see (cookies.onChanged carrying
 * every session cookie to every extension watching it; tabs.onCreated/
 * onUpdated carrying a tab's url/title/favIconUrl to an extension with no
 * tabs permission and no matching host permission; a webNavigation.* event
 * reaching an extension with no webNavigation permission at all). Returning
 * `undefined` skips delivery to that one listener entirely; returning a
 * replacement array delivers that instead. Set once, before the first event
 * fires (extension-host.ts).
 */
type EventListenerFilter = (
  extensionId: string,
  eventName: string,
  args: readonly unknown[],
) => readonly unknown[] | undefined
let gEventListenerFilter: EventListenerFilter | undefined

export function setEventListenerFilter(filter: EventListenerFilter | undefined): void {
  gEventListenerFilter = filter
}

/**
 * Handles event routing IPCs and delivers them to the observer with the
 * associated session.
 */
class RoutingDelegate {
  static get() {
    return gRoutingDelegate || (gRoutingDelegate = new RoutingDelegate())
  }

  private sessionMap: WeakMap<Session, RoutingDelegateObserver> = new WeakMap()
  private workers: WeakSet<any> = new WeakSet()
  // Orivon patch (UPSTREAM.md patch 42): onAddListener's own deferred-add
  // token per (extensions, listener key) -- listenerKey's own doc says why
  // this is keyed the same way pendingRegistrations is (never across
  // sessions).
  private pendingListenerAdds: WeakMap<ExtensionRegistryEvents, Map<string, symbol>> = new WeakMap()

  private constructor() {
    ipcMain.handle('crx-msg', this.onRouterMessage)
    ipcMain.handle('crx-msg-remote', this.onRemoteMessage)
    ipcMain.on('crx-add-listener', this.onAddListener)
    ipcMain.on('crx-remove-listener', this.onRemoveListener)
  }

  addObserver(observer: RoutingDelegateObserver) {
    this.sessionMap.set(observer.session, observer)

    const maybeListenForWorkerEvents = ({
      runningStatus,
      versionId,
    }: Electron.Event<Electron.ServiceWorkersRunningStatusChangedEventParams>) => {
      if (runningStatus !== 'starting') return

      const serviceWorker = (observer.session as any).serviceWorkers.getWorkerFromVersionID(
        versionId,
      )
      if (
        serviceWorker?.scope?.startsWith('chrome-extension://') &&
        !this.workers.has(serviceWorker)
      ) {
        d(`listening to service worker [versionId:${versionId}, scope:${serviceWorker.scope}]`)
        this.workers.add(serviceWorker)
        serviceWorker.ipc.handle('crx-msg', this.onRouterMessage)
        serviceWorker.ipc.handle('crx-msg-remote', this.onRemoteMessage)
        serviceWorker.ipc.on('crx-add-listener', this.onAddListener)
        serviceWorker.ipc.on('crx-remove-listener', this.onRemoveListener)
      }
    }
    observer.session.serviceWorkers.on('running-status-changed', maybeListenForWorkerEvents)
  }

  private onRouterMessage = async (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    handlerName: string,
    ...args: any[]
  ) => {
    d(`received '${handlerName}'`, args)

    // Orivon patch: refuses a message whose named extensionId does not
    // match the sender's own, when a check is set.
    if (gMessageSenderIdCheck && !gMessageSenderIdCheck(event as IpcAnyEvent, extensionId)) {
      throw new Error(`${handlerName} refused: sender is not extension ${extensionId}`)
    }

    const observer = this.sessionMap.get(getSessionFromEvent(event))

    return observer?.onExtensionMessage(event, extensionId, handlerName, ...args)
  }

  private onRemoteMessage = async (
    event: Electron.IpcMainInvokeEvent,
    sessionPartition: string,
    handlerName: string,
    ...args: any[]
  ) => {
    d(`received remote '${handlerName}' for '${sessionPartition}'`, args)

    // Orivon patch: refuses a remote call before it reaches any observer,
    // when a sender check is set.
    if (gRemoteMessageSenderCheck && !gRemoteMessageSenderCheck(event)) {
      throw new Error(`${handlerName} refused: sender is not allowed to call a remote session`)
    }

    const ses =
      sessionPartition === DEFAULT_SESSION
        ? getSessionFromEvent(event)
        : resolvePartition(sessionPartition)

    const observer = this.sessionMap.get(ses)

    return observer?.onExtensionMessage(event, undefined, handlerName, ...args)
  }

  private onAddListener = (event: IpcAnyEvent, extensionId: string, eventName: string) => {
    // Orivon patch: same check as onRouterMessage above -- without it, one
    // loaded extension's page or worker could subscribe to any other loaded
    // extension's events by naming its id here instead of its own.
    if (gMessageSenderIdCheck && !gMessageSenderIdCheck(event, extensionId)) {
      d(`crx-add-listener refused: sender is not extension ${extensionId}`)
      return
    }
    const observer = this.sessionMap.get(getSessionFromEvent(event))
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    // Orivon patch: addListener (below) throws synchronously for an
    // extensionId no longer registered in the session -- an options tab
    // left open across a disable/uninstall, or a page whose extension is
    // mid-reload (extension-sw-preload-recovery.ts). This runs inside a
    // plain ipcMain.on listener, never awaited by anything: an uncaught
    // throw here becomes an uncaughtException in main/index.ts, which exits
    // the whole process for one page's stale subscription.
    //
    // Orivon patch (UPSTREAM.md patch 38): the SAME registration race
    // onRouterMessage's own crx-msg path already waits out (patch 36) --
    // a popup's own top-level chrome.runtime.onMessage.addListener() call
    // can reach here before session.extensions reflects the load already
    // in flight, and without this the listener is refused outright and
    // lost for good, not merely delayed. Resolved synchronously, in the
    // same tick, when the extension is already registered (the common
    // case): only an actual race defers to the shared wait.
    const eventSession = getSessionFromEvent(event)
    const eventSessionExtensions = eventSession.extensions || eventSession
    // Orivon patch (UPSTREAM.md patch 42): a crx-remove-listener for this
    // SAME subscription can arrive while the wait below is still running
    // -- onRemoveListener cancels this token by deleting it, so the
    // deferred add below is skipped instead of re-adding a subscription
    // the caller already asked removed (`listenerKey`'s own doc).
    let pending = this.pendingListenerAdds.get(eventSessionExtensions)
    if (pending === undefined) {
      pending = new Map()
      this.pendingListenerAdds.set(eventSessionExtensions, pending)
    }
    const key = listenerKey(eventName, extensionId, listener)
    const token = Symbol('crx-add-listener')
    pending.set(key, token)
    const pendingTable = pending
    void (async () => {
      if (eventSessionExtensions.getExtension(extensionId) == null) {
        await waitForRegisteredExtension(eventSessionExtensions, extensionId)
      }
      if (pendingTable.get(key) !== token) return // cancelled by a same-subscription crx-remove-listener
      pendingTable.delete(key)
      try {
        observer?.addListener(listener, extensionId, eventName)
      } catch (error) {
        d(`crx-add-listener failed for ${extensionId}: %s`, error)
      }
    })()
  }

  private onRemoveListener = (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    eventName: string,
  ) => {
    // Orivon patch: same check as onAddListener above.
    if (gMessageSenderIdCheck && !gMessageSenderIdCheck(event as IpcAnyEvent, extensionId)) {
      d(`crx-remove-listener refused: sender is not extension ${extensionId}`)
      return
    }
    const eventSession = getSessionFromEvent(event)
    const observer = this.sessionMap.get(eventSession)
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    // Orivon patch (UPSTREAM.md patch 42): if a crx-add-listener for this
    // exact subscription is still deferred (waiting out the registration
    // race, patch 38), cancel it instead of falling through to
    // removeListener below -- nothing was ever actually added yet, so
    // there is nothing to remove, and letting the deferred add run anyway
    // once it resolves would re-add the subscription this call asked
    // removed.
    const eventSessionExtensions = eventSession.extensions || eventSession
    const key = listenerKey(eventName, extensionId, listener)
    const pending = this.pendingListenerAdds.get(eventSessionExtensions)
    if (pending?.delete(key) === true) return
    // Orivon patch: same reason as onAddListener above -- removeListener
    // itself never throws today, but this is the same untrusted, unawaited
    // call site, so it is guarded the same way rather than relying on that
    // staying true.
    try {
      return observer?.removeListener(listener, extensionId, eventName)
    } catch (error) {
      d(`crx-remove-listener failed for ${extensionId}: %s`, error)
    }
  }
}

export type ExtensionSender = Electron.WebContents | Electron.ServiceWorkerMain
// export interface ExtensionSender {
//   id?: number
//   ipc: Electron.IpcMain | Electron.IpcMainServiceWorker
//   send: Electron.WebFrameMain['send']
// }

type ExtendedExtension = Omit<Electron.Extension, 'manifest'> & {
  manifest: chrome.runtime.Manifest
}

export type ExtensionEvent =
  | { type: 'frame'; sender: Electron.WebContents; extension: ExtendedExtension }
  | { type: 'service-worker'; sender: Electron.ServiceWorkerMain; extension: ExtendedExtension }

export type HandlerCallback = (event: ExtensionEvent, ...args: any[]) => any

export interface HandlerOptions {
  /** Whether the handler can be invoked on behalf of a different session. */
  allowRemote?: boolean
  /** Whether an extension context is required to invoke the handler. */
  extensionContext: boolean
  /** Required extension permission to run the handler. */
  permission?: chrome.runtime.ManifestPermissions | undefined
}

interface Handler extends HandlerOptions {
  callback: HandlerCallback
}

/** e.g. 'tabs.query' */
type EventName = string

type HandlerMap = Map<EventName, Handler>

type FrameEventListener = { type: 'frame'; host: Electron.WebContents; extensionId: string }
type SWEventListener = { type: 'service-worker'; extensionId: string }
type EventListener = FrameEventListener | SWEventListener

const getHostId = (host: FrameEventListener['host']) => host.id
const getHostUrl = (host: FrameEventListener['host']) => host.getURL?.()

const eventListenerEquals = (a: EventListener) => (b: EventListener) => {
  if (a === b) return true
  if (a.extensionId !== b.extensionId) return false
  if (a.type !== b.type) return false
  if (a.type === 'frame' && b.type === 'frame') {
    return a.host === b.host
  }
  return true
}

/**
 * Orivon patch (UPSTREAM.md patch 42): a string key for
 * `RoutingDelegate.pendingListenerAdds`, identifying a subscription the
 * SAME way `eventListenerEquals` above already does (extensionId + type +
 * host, scoped to one `eventName`) -- so a `crx-remove-listener` call can
 * find and cancel a still-deferred `crx-add-listener` call for the exact
 * subscription it names, never a different one that happens to share an
 * extensionId or eventName.
 */
function listenerKey (eventName: string, extensionId: string, listener: EventListener): string {
  const hostPart = listener.type === 'frame' ? String(getHostId(listener.host)) : ''
  return `${eventName}\u0000${extensionId}\u0000${listener.type}\u0000${hostPart}`
}

export class ExtensionRouter {
  private handlers: HandlerMap = new Map()
  private listeners: Map<EventName, EventListener[]> = new Map()

  /**
   * Collection of all extension hosts in the session.
   *
   * Currently the router has no ability to wake up non-persistent background
   * scripts to deliver events. For now we just hold a reference to them to
   * prevent them from being terminated.
   */
  private extensionHosts: Set<Electron.WebContents> = new Set()

  private extensionWorkers: Set<any> = new Set()

  constructor(
    public session: Electron.Session,
    private delegate: RoutingDelegate = RoutingDelegate.get(),
  ) {
    this.delegate.addObserver(this)

    const sessionExtensions = session.extensions || session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.filterListeners((listener) => listener.extensionId !== extension.id)
    })

    app.on('web-contents-created', (event, webContents) => {
      if (webContents.session === this.session && webContents.getType() === 'backgroundPage') {
        d(`storing reference to background host [url:'${webContents.getURL()}']`)
        this.extensionHosts.add(webContents)
      }
    })

    session.serviceWorkers.on(
      'running-status-changed' as any,
      ({ runningStatus, versionId }: any) => {
        if (runningStatus !== 'starting') return

        const serviceWorker = (session as any).serviceWorkers.getWorkerFromVersionID(versionId)
        if (!serviceWorker) return

        const { scope } = serviceWorker
        if (!scope.startsWith('chrome-extension:')) return

        if (this.extensionHosts.has(serviceWorker)) {
          d('%s running status changed to %s', scope, runningStatus)
        } else {
          d(`storing reference to background service worker [url:'${scope}']`)
          this.extensionWorkers.add(serviceWorker)
        }
      },
    )
  }

  private filterListeners(predicate: (listener: EventListener) => boolean) {
    for (const [eventName, listeners] of this.listeners) {
      const filteredListeners = listeners.filter(predicate)
      const delta = listeners.length - filteredListeners.length

      if (filteredListeners.length > 0) {
        this.listeners.set(eventName, filteredListeners)
      } else {
        this.listeners.delete(eventName)
      }

      if (delta > 0) {
        d(`removed ${delta} listener(s) for '${eventName}'`)
      }
    }
  }

  private observeListenerHost(host: FrameEventListener['host']) {
    const hostId = getHostId(host)
    d(`observing listener [id:${hostId}, url:'${getHostUrl(host)}']`)
    host.once('destroyed', () => {
      d(`extension host destroyed [id:${hostId}]`)
      this.filterListeners((listener) => listener.type !== 'frame' || listener.host !== host)
    })
  }

  addListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners, session } = this

    const sessionExtensions = session.extensions || session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) {
      throw new Error(`extension not registered in session [extensionId:${extensionId}]`)
    }

    if (!listeners.has(eventName)) {
      listeners.set(eventName, [])
    }

    const eventListeners = listeners.get(eventName)!
    const existingEventListener = eventListeners.find(eventListenerEquals(listener))

    if (existingEventListener) {
      d(`ignoring existing '${eventName}' event listener for ${extensionId}`)
    } else {
      d(`adding '${eventName}' event listener for ${extensionId}`)
      eventListeners.push(listener)
      if (listener.type === 'frame' && listener.host) {
        this.observeListenerHost(listener.host)
      }
    }
  }

  removeListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners } = this

    const eventListeners = listeners.get(eventName)
    if (!eventListeners) {
      console.error(`event listener not registered for '${eventName}'`)
      return
    }

    const index = eventListeners.findIndex(eventListenerEquals(listener))

    if (index >= 0) {
      d(`removing '${eventName}' event listener for ${extensionId}`)
      eventListeners.splice(index, 1)
    }

    if (eventListeners.length === 0) {
      listeners.delete(eventName)
    }
  }

  private getHandler(handlerName: string) {
    const handler = this.handlers.get(handlerName)
    if (!handler) {
      throw new Error(`${handlerName} is not a registered handler`)
    }

    return handler
  }

  async onExtensionMessage(
    event: IpcInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ) {
    const { session } = this
    const eventSession = getSessionFromEvent(event)
    const eventSessionExtensions = eventSession.extensions || eventSession
    const handler = this.getHandler(handlerName)

    if (eventSession !== session && !handler.allowRemote) {
      throw new Error(`${handlerName} does not support calling from a remote session`)
    }

    // Orivon patch (UPSTREAM.md patch 37, live since patch 40): a frame
    // whose own real origin is opaque ("null", WebFrameMain.origin's own
    // doc) never gets to call anything here, whatever it claims -- checked
    // before extension resolution below, on the raw frame alone.
    // extension-sandbox-csp.ts (src/main/extensions/) is what actually
    // makes this true for a manifest sandbox.pages page: it serves those
    // responses with Chrome's own CSP `sandbox` directive, which does give
    // Electron's WebFrameMain.origin the literal string "null" here --
    // measured directly. Before that patch this never fired for a
    // sandbox.pages page on this Electron build (unlike real Chrome), so
    // the second check below (the manifest's own sandbox.pages list) was
    // the only one that caught it; both apply now, independently.
    if (event.type === 'frame' && event.senderFrame?.origin === 'null') {
      throw new Error(`${handlerName} refused: sender frame has an opaque origin`)
    }

    // Orivon patch (UPSTREAM.md patch 36): was a single unconditional
    // `getExtension` read; see waitForRegisteredExtension's own doc.
    let extension = extensionId ? eventSessionExtensions.getExtension(extensionId) : undefined
    if (!extension && handler.extensionContext && extensionId !== undefined) {
      extension = await waitForRegisteredExtension(eventSessionExtensions, extensionId)
    }
    if (!extension && handler.extensionContext) {
      throw new Error(`${handlerName} was sent from an unknown extension context`)
    }

    // Orivon patch (UPSTREAM.md patch 37): a page the extension's OWN
    // manifest declares under sandbox.pages gets no chrome.* API at all in
    // real Chrome, precisely because extensions put untrusted code
    // (templates, eval) there -- refused here from the extension's own
    // loaded manifest, never from anything the sender claims, and
    // regardless of handler.extensionContext, so a handler that does not
    // otherwise require a resolved extension cannot be used to dodge it.
    if (event.type === 'frame' && event.senderFrame != null && extension != null) {
      const sandboxManifest: chrome.runtime.Manifest = extension.manifest
      if (isSandboxPageUrl(sandboxManifest.sandbox?.pages, event.senderFrame.url)) {
        throw new Error(`${handlerName} refused: sender frame is a declared sandbox page`)
      }
    }

    if (handler.permission) {
      const manifest: chrome.runtime.Manifest = extension?.manifest
      if (!extension || !manifest.permissions?.includes(handler.permission)) {
        throw new Error(
          `${handlerName} requires an extension with ${handler.permission} permissions`,
        )
      }
    }

    const extEvent: ExtensionEvent =
      event.type === 'frame'
        ? { type: event.type, sender: event.sender, extension: extension! }
        : { type: event.type, sender: event.serviceWorker, extension: extension! }

    const result = await handler.callback(extEvent, ...args)

    d(`${handlerName} result: %r`, result)

    return result
  }

  private handle(name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>): void {
    this.handlers.set(name, {
      callback,
      extensionContext: typeof opts?.extensionContext === 'boolean' ? opts.extensionContext : true,
      allowRemote: typeof opts?.allowRemote === 'boolean' ? opts.allowRemote : false,
      permission: typeof opts?.permission === 'string' ? opts.permission : undefined,
    })
  }

  /** Returns a callback to register API handlers for the given context. */
  apiHandler() {
    return (name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>) => {
      this.handle(name, callback, opts)
    }
  }

  /**
   * Sends extension event to the host for the given extension ID if it
   * registered a listener for it.
   */
  sendEvent(targetExtensionId: string | undefined, eventName: string, ...args: any[]) {
    const { listeners } = this
    let eventListeners = listeners.get(eventName)
    const ipcName = `crx-${eventName}`

    if (!eventListeners || eventListeners.length === 0) {
      // Ignore events with no listeners
      return
    }

    let sentCount = 0
    for (const listener of eventListeners) {
      const { type, extensionId } = listener

      if (targetExtensionId && targetExtensionId !== extensionId) {
        continue
      }

      // Orivon patch: per-listener filter/gate -- see setEventListenerFilter.
      let deliverArgs: readonly unknown[] = args
      if (gEventListenerFilter) {
        const filtered = gEventListenerFilter(extensionId, eventName, args)
        if (filtered === undefined) continue
        deliverArgs = filtered
      }

      if (type === 'service-worker') {
        const scope = `chrome-extension://${extensionId}/`
        this.session.serviceWorkers
          .startWorkerForScope(scope)
          .then((serviceWorker) => {
            serviceWorker.send(ipcName, ...deliverArgs)
          })
          .catch((error) => {
            d('failed to send %s to %s', eventName, extensionId)
            console.error(error)
          })
      } else {
        if (listener.host.isDestroyed()) {
          console.error(`Unable to send '${eventName}' to extension host for ${extensionId}`)
          return
        }
        listener.host.send(ipcName, ...deliverArgs)
      }

      sentCount++
    }

    d(`sent '${eventName}' event to ${sentCount} listeners`)
  }

  /** Broadcasts extension event to all extension hosts listening for it. */
  broadcastEvent(eventName: string, ...args: any[]) {
    this.sendEvent(undefined, eventName, ...args)
  }
}
