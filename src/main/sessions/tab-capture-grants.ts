// Backs two things `permission-gate.ts` and the vendored `chrome.tabCapture`
// handler need: whether a 'media' request naming `chromeMediaSource: 'tab'`
// should be allowed, and whether a minted capture was ever actually redeemed
// -- the fact `tab-capture.ts`'s own safety net releases an unconsumed mute
// on, and never releases a consumed one on a timer (this file's own doc
// below explains why a timer cannot be trusted for that second case).
//
// `webContents.getMediaSourceId()`'s own token already scopes WHO can
// consume a specific capture and for how long (electron.d.ts: "restricted
// to the web contents it is registered to... valid for 10 seconds"); this
// ledger exists only because the session-level permission handlers never see
// that token -- they see a permission NAME, an origin, and (for the request
// handler) the CAPTURED TAB's own webContents, not the requester's (measured
// directly: docs/planning's tabCapture/offscreen probe). All this can answer
// is "did this extension mint a still-valid tabCapture token recently, and
// has a real getUserMedia('tab') call for it already happened", which is
// what it does.
//
// One grant per extension id, not per streamId: the policy question is "is
// this extension currently in a legitimate capture flow", never "is THIS
// EXACT token the one being redeemed" -- the id's own scoping already makes
// that second question Electron's, not this file's, to answer.
interface Grant {
  expiresAt: number
  /** True once a 'media' request/check for this extension's own
   * `chrome-extension://` origin was actually allowed -- the moment
   * Electron invoked the session's permission handler at all, which only
   * happens because the offscreen document's own `getUserMedia({ audio: {
   * mandatory: { chromeMediaSource: 'tab', ... } } })` call is in flight.
   * Once true, this grant's own expiry never again means "unused" --
   * `tab-capture.ts`'s safety net reads this bit, not the expiry alone, to
   * decide whether a still-ongoing capture may ever be time-released. */
  consumed: boolean
}

const grants = new Map<string, Grant>()

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
 * starts a fresh, unconsumed grant: a new mint means a new
 * `getMediaStreamId()` call, which only happens for a new capture attempt. */
export function mintTabCaptureGrant (extensionId: string, now: number): void {
  grants.set(extensionId, { expiresAt: now + TAB_CAPTURE_GRANT_MS, consumed: false })
}

export function hasLiveTabCaptureGrant (extensionId: string, now: number): boolean {
  const grant = grants.get(extensionId)
  return grant !== undefined && now < grant.expiresAt
}

/** `permission-gate.ts` calls this whenever it actually ALLOWS a 'media'
 * request/check for `extensionId` -- the real signal that a getUserMedia
 * call for this grant is genuinely in flight, not merely minted. A no-op
 * once the grant has already expired: nothing to mark, and a later, unrelated
 * mint must start unconsumed again. */
export function markTabCaptureGrantConsumed (extensionId: string, now: number): void {
  const grant = grants.get(extensionId)
  if (grant !== undefined && now < grant.expiresAt) grant.consumed = true
}

/** True once `markTabCaptureGrantConsumed` has run for this extension's
 * CURRENT (or any past) grant -- deliberately not re-checked against
 * expiry: a consumed grant's own capture can legitimately outlive the
 * 10-second minting window by hours, and this bit is what tells
 * `tab-capture.ts` never to time-release it. */
export function wasTabCaptureGrantConsumed (extensionId: string): boolean {
  return grants.get(extensionId)?.consumed === true
}

/** The policy `permission-gate.ts`'s `denyByDefault` calls for `'media'`:
 * allowed only for a `chrome-extension://` origin that minted a still-live
 * grant, denied for everything else -- including every other reason a page
 * might ask for `'media'` (camera, microphone), which this ledger never
 * grants because nothing here ever mints for a plain web origin. Pure: it
 * does not itself call `markTabCaptureGrantConsumed` -- `permission-gate.ts`
 * does that explicitly once it decides to allow, keeping "is this allowed"
 * and "record that it happened" as two separately testable steps. */
export function isTabCaptureMediaAllowed (securityOrigin: string | undefined, now: number): boolean {
  const extensionId = extensionIdFromChromeExtensionOrigin(securityOrigin)
  return extensionId !== undefined && hasLiveTabCaptureGrant(extensionId, now)
}
