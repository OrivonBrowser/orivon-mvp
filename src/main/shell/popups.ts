// window.open() and target=_blank in a browser whose windows are tabs. A
// popup the page can talk to (window.open returning a real window, with
// `opener` set) is Chromium's own new webContents adopted into a tab; any
// other open is an ordinary new tab. README.md's Design notes say why a
// popup keeps its opener's session.
import { WebContentsView } from 'electron'
import type { HandlerDetails, LoadURLOptions, WebContents, WebPreferences, WindowOpenHandlerResponse } from 'electron'
import { localFileKey, originFromUrl } from '../../broker/policy/origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export type PopupRoute = 'adopt' | 'new-tab'

export interface PopupOpener {
  readonly url: string
  readonly partition: string | undefined
  /** True while any frame of the opener's tab is a web page: a handler cannot tell which frame is opening. */
  readonly hasWebFrame?: boolean
}

/** A window feature that severs the opener, matched as a whole name. */
function seversOpener (features: string): boolean {
  return features.split(',').some((feature) => {
    const name = feature.split('=')[0]?.trim().toLowerCase()
    return name === 'noopener' || name === 'noreferrer'
  })
}

/** Whether `url` is a blob: URL minted by `opener`'s own origin -- the only case one is safe to
 * open at all: its bytes live only in the storage partition that minted it, resolvable there and
 * nowhere else. Exported so `windowOpenHandler`'s no-guest branch can ask the identical question
 * `routePopup` already asked, to route it to `openBlobTab` instead of `sanitizeDirectUrl`'s refusal. */
export function blobMintedByOpener (url: string, opener: PopupOpener): boolean {
  if (!url.startsWith('blob:')) return false
  const minter = originFromUrl(url.slice('blob:'.length))
  return minter !== null && minter === originFromUrl(opener.url)
}

/** `targetPartition` is the session a tab opened at `details.url` would get
 * on its own. A popup Chromium creates always shares its opener's. `isApp`
 * answers whether `details.url`'s origin holds a grant or is cache-served
 * (ADR-0044/ADR-0045's own gap) -- README.md's Design notes. */
export function routePopup (
  details: Pick<HandlerDetails, 'url' | 'features' | 'disposition'>,
  opener: PopupOpener,
  targetPartition: string | undefined,
  isApp: (url: string) => boolean
): PopupRoute {
  // A blob: URL resolves only in the storage partition that minted it, so
  // a fresh tab in any session would load nothing.
  if (details.url.startsWith('blob:')) return blobMintedByOpener(details.url, opener) ? 'adopt' : 'new-tab'
  // Chromium cannot load a protocol's address itself; only a new tab turns it into the URL serving it.
  if (seversOpener(details.features) || BUILTIN_ADDRESSES.servedUrl(details.url) !== undefined) return 'new-tab'
  // A granted or cache-served origin popped open from a DIFFERENT origin
  // keeps no opener link, whatever session the two happen to share --
  // a grant alone puts no app in its own partition (ADR-0044), so
  // `targetPartition === opener.partition` below cannot be trusted to
  // catch this case (both are commonly undefined at
  // once: the app's own default-session partition and an ordinary site's).
  // A same-origin popup (an app opening one to itself) is unaffected.
  const targetOrigin = originFromUrl(details.url)
  if (targetOrigin !== null && targetOrigin !== originFromUrl(opener.url) && isApp(details.url)) return 'new-tab'
  if (targetPartition === opener.partition) return 'adopt'
  // An isolated app's pinned bundle is served only in its own session.
  // Adopted anywhere else, its origin would run whatever the network sends,
  // with its grants.
  if (targetPartition !== undefined) return 'new-tab'
  // Out onto the open web: only a page that asked for a popup window, or a
  // blank one it will fill, is waiting on the opener link. A link or a plain
  // window.open(url) loads in the right session from its first request.
  return details.disposition === 'new-window' || details.url === 'about:blank' ? 'adopt' : 'new-tab'
}

export interface PopupHost {
  atCapacity: () => boolean
  /** `active` false opens the tab behind the current one: a middle click or a plain ctrl+click.
   * `loadOptions` -- see `loadOptionsFor`'s own doc. Returns the tab's webContents -- see
   * `windowOpenHandler`'s no-guest branch, which adopts it rather than building its own
   * unpartitioned, unsanitized view. */
  openTab: (url: string, active: boolean, loadOptions?: LoadURLOptions) => WebContents | undefined
  /** `url` is what the popup was opened at, for anything the tab decides from it.
   * `active` -- see `openTab`'s own doc. */
  adoptPopup: (view: WebContentsView, partition: string | undefined, url: string, active: boolean) => void
  /** `url` (a blob:, `blobMintedByOpener`'s own doc) opened directly in `partition`, the opener's
   * own -- the one case a blob: URL is safe to open at all. `active`/`loadOptions` -- `openTab`'s own doc. */
  openBlobTab: (url: string, partition: string | undefined, active: boolean, loadOptions?: LoadURLOptions) => WebContents | undefined
  /** `url`, a local file, in a new tab of the local-files session. Absent: a local file is never opened from a page. */
  openLocalFile?: (url: string, active: boolean) => WebContents | undefined
  /** `url` in a brand new window, as Chrome opens a shift-click -- undefined when the shell
   * cannot make one, so the caller opens a tab here instead. `loadOptions` -- see
   * `loadOptionsFor`'s own doc. */
  openWindow: (url: string, loadOptions?: LoadURLOptions) => WebContents | undefined
  /** The session a tab opened at `url` would get. */
  partitionFor: (url: string) => string | undefined
  /** The webPreferences a tab opened at `url` would get, without a
   * partition: Chromium puts a popup in its opener's session regardless. */
  webPreferencesFor: (url: string) => WebPreferences
  /** Whether `url`'s origin holds a grant or is cache-served -- `routePopup`'s own `isApp`. */
  isApp: (url: string) => boolean
  /** True when the pop-up blocker refuses this open (site-settings/popup-blocker.ts). Absent in a test with no blocker: nothing is refused. */
  popupBlocked?: (details: HandlerDetails, opener: PopupOpener) => boolean
}

/** The webContents Chromium already built for the open, if any -- present in the `options`
 * `createWindow` receives, though its type omits the field entirely. Measured against Electron
 * 44: a modifier-key open (middle click, ctrl+click, shift+click, ctrl+shift+click, on any link
 * regardless of `target`) never carries one, whatever its disposition; only a renderer-driven
 * open a script holds a `Window` handle to -- window.open(), or a plain click on target=_blank --
 * does. */
function guestOf (options: object): WebContents | undefined {
  return (options as { webContents?: WebContents }).webContents
}

/** What a no-guest open's own `loadURL` needs to reproduce what Electron's DEFAULT (guest-adopting)
 * path would have sent on its own -- measured against Electron 44: `details.postBody`/`referrer`
 * are populated for a modifier-click submit of a `method=post` form exactly as for an ordinary
 * click, but createTab's own `loadURL(target)` call otherwise carries neither, silently turning a
 * POST into a GET with no referrer. `undefined` when there is nothing to carry (an ordinary link,
 * no referrer to report), so a caller can omit the argument entirely rather than pass `{}`. */
function loadOptionsFor (details: HandlerDetails): LoadURLOptions | undefined {
  const { referrer, postBody } = details
  // referrer?. : real Electron always sends one, but a hand-built HandlerDetails (a test, or a
  // caller that only typed the fields it uses) may not -- never worth a throw either way.
  if (postBody === undefined && (referrer?.url ?? '') === '') return undefined
  const options: LoadURLOptions = {}
  if (referrer?.url !== undefined && referrer.url !== '') options.httpReferrer = referrer
  if (postBody !== undefined) {
    options.postData = postBody.data
    options.extraHeaders = `content-type: ${postBody.contentType}${postBody.boundary !== undefined ? `; boundary=${postBody.boundary}` : ''}\n`
  }
  return options
}

/** A `file:` target of any shape: even one `localFileKey` refuses is denied here, never handed to a tab. */
function isFileTarget (url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

const MAX_NEW_WINDOWS_PER_MINUTE_PER_TAB = 5
const NEW_WINDOW_MIN_SPACING_MS = 1_000
/** A page that opens itself grows geometrically under a per-tab budget alone: each window it
 * opens is a brand new opener tab, with its own untouched budget (5, 25, 125, ...). This bounds
 * new-window opens across the whole process instead, whichever tab is asking -- generous enough
 * that ordinary multi-tab browsing never notices it, tight enough that self-replication does. */
export const MAX_NEW_WINDOWS_PER_MINUTE_PROCESS = 20
const MINUTE_MS = 60_000

interface Budget { allow: () => boolean, reset: () => void }

/** A rolling-minute count, capped at `max`, at most one accepted every `minSpacingMs` (0: no
 * spacing floor, only the cap). `reset()` exists for tests: nothing in this file calls it. */
function newBudget (max: number, minSpacingMs = 0): Budget {
  let openedAt: number[] = []
  return {
    allow: () => {
      const now = Date.now()
      openedAt = openedAt.filter((at) => now - at <= MINUTE_MS)
      if (openedAt.length >= max) return false
      if (minSpacingMs > 0 && openedAt.length > 0 && now - (openedAt[openedAt.length - 1] as number) < minSpacingMs) return false
      openedAt.push(now)
      return true
    },
    reset: () => { openedAt = [] }
  }
}

/** Every tab's own `windowOpenHandler` shares this one -- unlike `newWindowLimiter`'s per-opener
 * budget below, it is module-level, so it never resets per tab (closing the geometric-growth hole
 * its own doc describes). Exported only so a test can `reset()` it between cases. */
export const processWindowBudget: Budget = newBudget(MAX_NEW_WINDOWS_PER_MINUTE_PROCESS)

/** One opener tab's own new-window budget: `HandlerDetails` carries no per-open user-gesture
 * flag to check instead (absent from Electron 44's type), and a page's own synthetic, untrusted
 * `dispatchEvent` click still reaches `windowOpenHandler` with a real 'new-window' disposition
 * (measured) -- so nothing here stops a script from firing as many as it likes. `allow()` records
 * an accepted open and refuses one closer than a second to the last, or beyond five within a
 * rolling minute; a caller past either this or `processWindowBudget` falls back to an ordinary tab
 * instead of refusing the link outright. Closed over per `windowOpenHandler` call, so its state is
 * naturally scoped to one opener tab and gone once that tab's own handler is. */
function newWindowLimiter (): Budget {
  return newBudget(MAX_NEW_WINDOWS_PER_MINUTE_PER_TAB, NEW_WINDOW_MIN_SPACING_MS)
}

export function windowOpenHandler (
  host: PopupHost,
  opener: () => PopupOpener
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  const limiter = newWindowLimiter()
  return (details) => {
    if (host.atCapacity()) return { action: 'deny' }
    const from = opener()
    if (host.popupBlocked?.(details, from) === true) return { action: 'deny' }
    // Every browser opens a middle click or a plain ctrl+click behind the current tab.
    const active = details.disposition !== 'background-tab'
    if (isFileTarget(details.url)) {
      // Only a page that is itself a local file, with no web frame that could be the caller, may open
      // another; it never gets a window to script (a sibling is its own origin), so it is never adopted.
      if (localFileKey(details.url) !== null && localFileKey(from.url) !== null && from.hasWebFrame !== true) host.openLocalFile?.(details.url, active)
      return { action: 'deny' }
    }
    const loadOptions = loadOptionsFor(details)
    if (routePopup(details, from, host.partitionFor(details.url), host.isApp) === 'new-tab') {
      // routePopup's 'new-tab' returns before disposition is ever weighed (a builtin address, a
      // cross-origin app target, an opener-severing feature) -- but a shift-click still reaches
      // here with the same 'new-window' disposition it gets everywhere else (measured against
      // Electron 44: a plain click or window.open() with no sizing features never produces it,
      // only a real sized popup or a genuine shift-click do), so it still deserves a window, not a
      // tab, through the same rate-limited path.
      const canOpenWindow = details.disposition === 'new-window' && processWindowBudget.allow() && limiter.allow()
      if (!canOpenWindow || host.openWindow(details.url, loadOptions) === undefined) {
        host.openTab(details.url, active, loadOptions)
      }
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      // A tab outlives the tab that opened it, as it does in every browser.
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: host.webPreferencesFor(details.url) },
      createWindow: (options) => {
        const guest = guestOf(options)
        // No guest (guestOf's own doc): there is nothing of Chromium's to adopt, so `routePopup`'s
        // 'adopt' above means only "this URL's own partition equals the opener's", never "skip the
        // ordinary tab pipeline" -- this always routes through it exactly as any other tab open
        // does, recomputing the correct partition from the URL itself (partitionForTarget) and
        // applying sanitizeDirectUrl. Building a view here directly, with `options.webPreferences`
        // (no partition -- webPreferencesFor's own doc says why: Chromium fixes a REAL guest's
        // partition to its opener's at creation), would land it in session.defaultSession instead,
        // loading the opener's own origin from the network with its app-tab flag still set --
        // network-served code would then run with whatever grants the broker keys to that origin,
        // since it checks only the sender frame's origin (T6/T18/T21). A shift-click's new-window
        // open (disposition 'new-window') already goes through the same safe pipeline via openWindow.
        if (guest === undefined) {
          // A same-origin blob: (blobMintedByOpener's own doc) is the one URL a no-guest open can
          // safely put anywhere at all, and only in the opener's own partition -- checked ahead of
          // the shift-click/new-window branch below, since a blob: URL has no safe "new window" of
          // its own either; it only ever means "a tab in the session that minted it".
          if (blobMintedByOpener(details.url, from)) {
            const opened = host.openBlobTab(details.url, from.partition, active, loadOptions)
            if (opened !== undefined) return opened
          } else if (details.disposition === 'new-window' && processWindowBudget.allow() && limiter.allow()) {
            const opened = host.openWindow(details.url, loadOptions)
            if (opened !== undefined) return opened
          }
          const opened = host.openTab(details.url, active, loadOptions)
          if (opened !== undefined) return opened
          // Never reached in practice (atCapacity() was already false at this handler's own
          // entry, synchronously before Electron ever calls this callback) -- kept because
          // createWindow's contract still requires returning SOME real WebContents. Blank and
          // unpartitioned, but never loaded: it touches no network and holds no grants either way.
          return new WebContentsView({}).webContents
        }
        // webPreferences again, not only webContents: adopting without them
        // drops the preload, measured against Electron 44, and the popup
        // then has no orivon surface at all.
        const webPreferences = options.webPreferences !== undefined ? { webPreferences: options.webPreferences } : {}
        const view = new WebContentsView({ webContents: guest, ...webPreferences })
        host.adoptPopup(view, from.partition, details.url, active)
        return view.webContents
      }
    }
  }
}
