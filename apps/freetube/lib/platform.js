// What this page can actually do, decided once at startup and never guessed
// at again. Three independent facts, deliberately not collapsed into one
// "is Orivon" boolean: `window.orivon` exists on EVERY ordinary tab, a
// routed fetch is installed only on a registered app's tab, and a grant is
// a third thing again -- a person can refuse one and keep the others
// (the manifest asks for per-capability consent). Code that treats them as
// one flag reports "not in Orivon" for a tab that is merely ungranted.

/**
 * The routed fetch is an ordinary JavaScript function; the platform's own
 * reports `[native code]`. That is the only tell before a request is made,
 * and reading it costs no network round trip. It answers "this is not the
 * platform's fetch" and no more -- the routed binding carries the platform's
 * own descriptor, so a page that installed its own fetch reads the same way.
 */
function hasRoutedFetch () {
  return !/\[native code\]/.test(String(globalThis.fetch))
}

function capabilityKinds (grants) {
  const kinds = new Set()
  for (const grant of grants) kinds.add(grant.capability)
  return kinds
}

export async function detectPlatform () {
  const orivon = globalThis.orivon
  if (orivon === undefined) {
    return {
      runtime: 'browser',
      routedFetch: false,
      grants: [],
      canReachYouTube: false,
      canPersist: false,
      reason: 'No Orivon runtime: window.orivon is absent, so this is an ordinary browser tab.'
    }
  }

  let grants = []
  let grantError
  try {
    grants = [...await orivon.app.grants()]
  } catch (error) {
    grantError = error instanceof Error ? error.message : String(error)
  }

  const kinds = capabilityKinds(grants)
  const routedFetch = hasRoutedFetch()
  return {
    runtime: 'orivon',
    routedFetch,
    grants,
    canReachYouTube: kinds.has('https.connect'),
    canPersist: kinds.has('fs'),
    reason: grantError === undefined
      ? undefined
      : `orivon.app.grants() failed: ${grantError}`
  }
}

/** The host:port strings a `https.connect` grant actually authorises, for the settings screen and for the playback cascade's own pre-flight. */
export function grantedHosts (platform) {
  const hosts = []
  for (const grant of platform.grants) {
    if (grant.capability !== 'https.connect') continue
    for (const pattern of grant.patterns) hosts.push(pattern)
  }
  return hosts
}

/**
 * True when `host` is one a granted pattern names literally. `"*:*"` is
 * reported separately by `isUnlimitedHttps` rather than folded in here:
 * the two differ for CSP, which omits a `*` grant entirely, so a caller
 * deciding whether a SUBRESOURCE can load needs the literal answer.
 */
export function grantNamesHost (platform, host) {
  return grantedHosts(platform).some((pattern) => pattern.split(':')[0] === host)
}

export function isUnlimitedHttps (platform) {
  return grantedHosts(platform).includes('*:*')
}
