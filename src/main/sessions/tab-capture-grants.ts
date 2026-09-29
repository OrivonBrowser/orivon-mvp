// Backs the one `permission-gate.ts` addition chrome.tabCapture needs:
// deciding whether a 'media' request naming `chromeMediaSource: 'tab'`
// should be allowed. `webContents.getMediaSourceId()`'s own token already
// scopes WHO can consume a specific capture and for how long (electron.d.ts:
// "restricted to the web contents it is registered to... valid for 10
// seconds"); this ledger exists only because the session-level permission
// handlers never see that token -- they see a permission NAME, an origin,
// and (for the request handler) the CAPTURED TAB's own webContents, not the
// requester's (measured directly: docs/planning's tabCapture/offscreen
// probe). All this can answer is "did this extension mint a still-valid
// tabCapture token recently", which is what it does.
//
// One expiry per extension id, not per streamId: the policy question is
// "is this extension currently in a legitimate capture flow", never "is
// THIS EXACT token the one being redeemed" -- the id's own scoping already
// makes that second question Electron's, not this file's, to answer.
const grantExpiresAt = new Map<string, number>()

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
 * for where the vendored `chrome.tabCapture` handler reaches this. */
export function mintTabCaptureGrant (extensionId: string, now: number): void {
  grantExpiresAt.set(extensionId, now + TAB_CAPTURE_GRANT_MS)
}

export function hasLiveTabCaptureGrant (extensionId: string, now: number): boolean {
  const expiresAt = grantExpiresAt.get(extensionId)
  return expiresAt !== undefined && now < expiresAt
}

/** The policy `permission-gate.ts`'s `denyByDefault` calls for `'media'`:
 * allowed only for a `chrome-extension://` origin that minted a still-live
 * grant, denied for everything else -- including every other reason a page
 * might ask for `'media'` (camera, microphone), which this ledger never
 * grants because nothing here ever mints for a plain web origin. */
export function isTabCaptureMediaAllowed (securityOrigin: string | undefined, now: number): boolean {
  const extensionId = extensionIdFromChromeExtensionOrigin(securityOrigin)
  return extensionId !== undefined && hasLiveTabCaptureGrant(extensionId, now)
}
