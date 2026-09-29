// Backs three things `permission-gate.ts` and the vendored `chrome.tabCapture`
// handler need: whether a 'media' request naming `chromeMediaSource: 'tab'`
// should be allowed, whether a minted capture was ever actually redeemed,
// and -- per capture, not per extension -- releasing one tab's mute never
// touches another the same extension also captures.
//
// `webContents.getMediaSourceId()`'s own token already scopes WHO can
// consume a specific capture and for how long (electron.d.ts: "restricted
// to the web contents it is registered to... valid for 10 seconds"); this
// ledger exists only because the session-level permission handlers never see
// that token -- they see a permission NAME, an origin, and (for the request
// handler) the CAPTURED TAB's own webContents, not the requester's (measured
// directly: docs/planning's tabCapture/offscreen probe). All this can answer
// is "did this extension mint a still-valid tabCapture token for THIS tab
// recently, and has a real getUserMedia('tab') call for it already
// happened", which is what it does.
//
// Keyed by (extensionId, targetTabId), never extension alone: an extension
// capturing two tabs at once must mint, consume and release each
// independently -- a shared, extension-wide grant let one tab's own
// redemption mark a DIFFERENT tab's still-unredeemed mint as consumed
// (measured against a fixture minting two ids in a row).
interface Grant {
  expiresAt: number
  /** True once a 'media' REQUEST (never a check -- see
   * `permission-gate.ts`'s own doc) for this exact (extension, tab) pair
   * was actually allowed. Once true, this grant's own expiry never again
   * means "unused" -- `tab-capture.ts`'s safety net reads this bit, not the
   * expiry alone, to decide whether a still-ongoing capture may ever be
   * time-released. */
  consumed: boolean
}

const grants = new Map<string, Grant>()

function key (extensionId: string, targetTabId: number): string {
  return `${extensionId}\u0000${String(targetTabId)}`
}

/** How long `webContents.getMediaSourceId()` keeps its own id valid --
 * electron.d.ts's own doc, duplicated here as a constant because this
 * ledger's whole reason to exist is to not outlive it. */
export const TAB_CAPTURE_GRANT_MS = 10_000

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/([^/]+)/

export function extensionIdFromChromeExtensionOrigin (origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  return CHROME_EXTENSION_ORIGIN.exec(origin)?.[1]
}

/** Called once `webContents.getMediaSourceId()` returns -- see
 * `../extensions/README.md`-style wiring in `../extensions/extension-host.ts`
 * for where the vendored `chrome.tabCapture` handler reaches this. Always
 * starts a fresh, unconsumed grant for this exact tab: a new mint means a
 * new `getMediaStreamId()` call for it, which only happens for a new
 * capture attempt. */
export function mintTabCaptureGrant (extensionId: string, targetTabId: number, now: number): void {
  grants.set(key(extensionId, targetTabId), { expiresAt: now + TAB_CAPTURE_GRANT_MS, consumed: false })
}

export function hasLiveTabCaptureGrant (extensionId: string, targetTabId: number, now: number): boolean {
  const grant = grants.get(key(extensionId, targetTabId))
  return grant !== undefined && now < grant.expiresAt
}

/** `permission-gate.ts` calls this whenever it actually ALLOWS a 'media'
 * request for `(extensionId, targetTabId)` -- the real signal that a
 * getUserMedia call for this grant is genuinely in flight, not merely
 * minted. A no-op once the grant has already expired: nothing to mark, and
 * a later, unrelated mint must start unconsumed again. */
export function markTabCaptureGrantConsumed (extensionId: string, targetTabId: number, now: number): void {
  const grant = grants.get(key(extensionId, targetTabId))
  if (grant !== undefined && now < grant.expiresAt) grant.consumed = true
}

/** True once `markTabCaptureGrantConsumed` has run for this exact
 * (extension, tab) pair -- deliberately not re-checked against expiry: a
 * consumed grant's own capture can legitimately outlive the 10-second
 * minting window by hours, and this bit is what tells `tab-capture.ts`
 * never to time-release it. */
export function wasTabCaptureGrantConsumed (extensionId: string, targetTabId: number): boolean {
  return grants.get(key(extensionId, targetTabId))?.consumed === true
}

/**
 * The policy `permission-gate.ts`'s `denyByDefault` calls for a `'media'`
 * REQUEST (never the check -- its own doc says why). Allowed only when
 * ALL of:
 *  - `securityOrigin` names a `chrome-extension://` id,
 *  - that extension minted a still-live grant for EXACTLY `capturedTabId`
 *    (the request handler's own `contents.id` -- Electron hands the
 *    CAPTURED TAB there for this call shape, never the requester's),
 *  - `mediaTypes` is empty.
 *
 * The last point is load-bearing: measured
 * directly, a real tab-capture `getUserMedia({ audio: { mandatory: {
 * chromeMediaSource: 'tab', ... } } })` request carries `mediaTypes: []`,
 * while an ordinary device request -- `getUserMedia({ audio: true })` or
 * `{ video: true }` -- carries the kinds actually asked for, `['audio']`
 * or `['audio','video']`. Without this, an extension holding a live
 * tabCapture grant (minted once, for the tab it was invoked on) could call
 * `getUserMedia({ audio: true, video: true })` on its OWN page and
 * silently receive the real microphone and camera: `contents` for THAT
 * call is the extension's own page, not the captured tab, so the
 * tab-identity check alone already refuses it, and the shape check refuses
 * it a second, independent way.
 */
export function isTabCaptureMediaRequestAllowed (
  securityOrigin: string | undefined,
  capturedTabId: number,
  mediaTypes: readonly string[] | undefined,
  now: number,
): boolean {
  const extensionId = extensionIdFromChromeExtensionOrigin(securityOrigin)
  if (extensionId === undefined) return false
  if (mediaTypes === undefined || mediaTypes.length > 0) return false
  return hasLiveTabCaptureGrant(extensionId, capturedTabId, now)
}
