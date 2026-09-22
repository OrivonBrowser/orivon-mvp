// Getting bytes into a <video> element, and saying precisely why when that
// fails. Three routes are tried in order, and they fail for three unrelated
// reasons, so a player that just goes blank teaches nothing:
//
//   1. an Invidious instance's own `?local=true` proxy -- a stable hostname
//      the manifest declares, so the served CSP names it;
//   2. the direct googlevideo URL -- rotating subdomain, so no manifest
//      pattern and therefore no CSP source can ever name it;
//   3. routed fetch into a Blob -- CSP does not apply to a routed fetch, but
//      it does apply to the resulting `blob:` URL, and the response body is
//      capped at 16 MiB.
//
// `securitypolicyviolation` is what separates "CSP refused this" from "the
// host refused this", and the two need opposite fixes. Without listening for
// it, both arrive at the <video> element as the same bare `error` event.

/** Matches the routed-fetch response body cap. A progressive stream larger than this cannot complete route 3 even when CSP allows the blob. */
export const ROUTED_FETCH_BODY_CAP = 16 * 1024 * 1024

const LOAD_TIMEOUT_MS = 20_000

export function watchPolicyViolations () {
  const violations = []
  if (typeof document === 'undefined') return violations
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push({
      blockedURI: event.blockedURI,
      directive: event.violatedDirective,
      at: Date.now()
    })
  })
  return violations
}

function violationFor (violations, since) {
  return violations.filter((entry) => entry.at >= since).at(-1)
}

/**
 * Resolves when the element has enough data to start, rejects on the error
 * event or the timeout. `loadedmetadata` rather than `canplay`: a CSP
 * refusal never reaches either, and waiting for the later one only makes
 * the failure take longer to report.
 */
function loadInto (video, url) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoad)
      video.removeEventListener('error', onError)
      fn(value)
    }
    const onLoad = () => { done(resolve, undefined) }
    const onError = () => {
      const code = video.error?.code
      done(reject, new Error(`media element rejected the source (code ${code ?? 'none'})`))
    }
    const timer = setTimeout(() => { done(reject, new Error('timed out waiting for media metadata')) }, LOAD_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', onLoad)
    video.addEventListener('error', onError)
    video.src = url
    video.load()
  })
}

async function tryDirect (video, url, violations, label) {
  const since = Date.now()
  try {
    await loadInto(video, url)
    return { ok: true, strategy: label, url }
  } catch (error) {
    const violation = violationFor(violations, since)
    return {
      ok: false,
      strategy: label,
      blockedBy: violation === undefined ? 'host' : 'csp',
      directive: violation?.directive,
      blockedURI: violation?.blockedURI,
      detail: error.message
    }
  }
}

/**
 * Route 3. The fetch itself is unaffected by CSP (a routed fetch never
 * becomes a browser network load), so a failure here is either the body cap
 * or the `blob:` URL that follows -- distinguished by which step threw.
 */
async function tryBlob (video, url, violations, fetchImpl) {
  let blobUrl
  try {
    const response = await fetchImpl(url, { headers: { 'accept-encoding': 'identity' } })
    if (!response.ok) return { ok: false, strategy: 'blob', blockedBy: 'host', detail: `stream host returned HTTP ${response.status}` }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > ROUTED_FETCH_BODY_CAP) {
      return { ok: false, strategy: 'blob', blockedBy: 'body-cap', detail: `stream is ${Math.round(declared / 1048576)} MiB, over the ${ROUTED_FETCH_BODY_CAP / 1048576} MiB routed-fetch cap` }
    }
    blobUrl = URL.createObjectURL(await response.blob())
  } catch (error) {
    return { ok: false, strategy: 'blob', blockedBy: 'fetch', detail: error.message }
  }
  const attempt = await tryDirect(video, blobUrl, violations, 'blob')
  if (!attempt.ok) URL.revokeObjectURL(blobUrl)
  return attempt
}

/**
 * Runs the cascade and returns the winning route, or every route's own
 * reason for failing. `sources` is ordered; a caller that knows an
 * Invidious instance is configured puts it first.
 */
export async function play (video, sources, { violations = [], fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const attempts = []
  for (const source of sources) {
    if (typeof source?.url !== 'string') continue
    const attempt = source.via === 'blob'
      ? await tryBlob(video, source.url, violations, fetchImpl)
      : await tryDirect(video, source.url, violations, source.via)
    attempts.push(attempt)
    if (attempt.ok) return { ok: true, played: attempt, attempts }
  }
  return { ok: false, played: undefined, attempts }
}

/** One sentence a person can act on, chosen from what the cascade actually observed rather than from a guess about why playback is unavailable. */
export function explain (result) {
  if (result.ok) return `Playing over ${result.played.strategy}.`
  if (result.attempts.length === 0) return 'No playable stream was offered for this video.'
  const csp = result.attempts.find((attempt) => attempt.blockedBy === 'csp')
  if (csp !== undefined) {
    return `Blocked by this app's own Content-Security-Policy (${csp.directive}). The stream host is not one the manifest could name, so the page is not allowed to load it.`
  }
  const cap = result.attempts.find((attempt) => attempt.blockedBy === 'body-cap')
  if (cap !== undefined) return `Cannot buffer this video: ${cap.detail}.`
  return `Every stream source failed: ${result.attempts.map((attempt) => `${attempt.strategy} (${attempt.detail})`).join('; ')}.`
}
