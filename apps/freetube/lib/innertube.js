// YouTube's private InnerTube API, spoken directly. Two client identities,
// because no single one answers everything: WEB is the only one that still
// returns search, channel and watch metadata unauthenticated, and ANDROID_VR
// is the only one observed returning stream URLs that are neither ciphered
// nor gated behind a proof-of-origin token.
//
// EVERY REQUEST HERE SETS HEADERS A BROWSER FORBIDS A PAGE TO SET -- `Origin`,
// `User-Agent`, `Accept-Encoding`. That is the whole reason this app is an
// Orivon app: in Chrome these are dropped and the request is refused by CORS
// besides. Under ADR-0017 a routed fetch carries them verbatim.
//
// `Accept-Encoding` names gzip and deflate but never `br`: a routed fetch
// decompresses through the platform's own DecompressionStream, which has no
// brotli format, and a brotli response fails loudly rather than decoding.

const WEB_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20240304.00.00',
  hl: 'en',
  gl: 'US'
}

const WEB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const VR_CLIENT = {
  clientName: 'ANDROID_VR',
  clientVersion: '1.60.19',
  deviceMake: 'Oculus',
  deviceModel: 'Quest 3',
  osName: 'Android',
  osVersion: '12L',
  androidSdkVersion: 32,
  hl: 'en',
  gl: 'US'
}

const VR_USER_AGENT = 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L) gzip'

const API_ORIGIN = 'https://www.youtube.com'

export class InnerTube {
  constructor (fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.fetch = fetchImpl
    this.visitorData = undefined
  }

  /**
   * YouTube issues a visitor identity to any client that asks. Requests work
   * without one; sending a stable one makes consecutive requests look like
   * one session rather than many first-time visitors, which is what keeps
   * the bot-guard quiet for longer.
   */
  async ensureVisitorData () {
    if (this.visitorData !== undefined) return this.visitorData
    try {
      const response = await this.fetch(`${API_ORIGIN}/sw.js_data`, {
        headers: { 'user-agent': WEB_USER_AGENT, referer: `${API_ORIGIN}/` }
      })
      const body = (await response.text()).replace(/^\)]}'/, '')
      this.visitorData = JSON.parse(body)[0][2][0][0][13]
    } catch {
      this.visitorData = null
    }
    return this.visitorData
  }

  async call (endpoint, payload, { client = WEB_CLIENT, userAgent = WEB_USER_AGENT } = {}) {
    const visitorData = await this.ensureVisitorData()
    const context = { client: { ...client, ...(visitorData ? { visitorData } : {}) } }
    const response = await this.fetch(`${API_ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': userAgent,
        'accept-encoding': 'gzip, deflate',
        origin: API_ORIGIN,
        referer: `${API_ORIGIN}/`,
        ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {})
      },
      body: JSON.stringify({ context, ...payload })
    })
    if (!response.ok) {
      throw new Error(`InnerTube ${endpoint} returned HTTP ${response.status}`)
    }
    return await response.json()
  }

  search (query) {
    return this.call('search', { query })
  }

  browse (browseId, params) {
    return this.call('browse', { browseId, ...(params === undefined ? {} : { params }) })
  }

  next (videoId) {
    return this.call('next', { videoId })
  }

  /** The stream list. The WEB client answers this endpoint with `UNPLAYABLE` for a request carrying no proof-of-origin token, so it is asked as ANDROID_VR instead. */
  player (videoId) {
    return this.call(
      'player',
      { videoId, contentCheckOk: true, racyCheckOk: true },
      { client: VR_CLIENT, userAgent: VR_USER_AGENT }
    )
  }
}

/** itag 18 is the last progressive (audio and video in one file) H.264/AAC format YouTube still returns, and the only one a bare `<video>` can play without Media Source Extensions. */
export const PROGRESSIVE_ITAG = 18

export function pickStreams (playerResponse) {
  const streaming = playerResponse?.streamingData
  const progressive = (streaming?.formats ?? []).filter((format) => typeof format.url === 'string')
  const adaptive = (streaming?.adaptiveFormats ?? []).filter((format) => typeof format.url === 'string')
  return {
    progressive,
    adaptive,
    preferred: progressive.find((format) => format.itag === PROGRESSIVE_ITAG) ?? progressive[0],
    expiresInSeconds: Number(streaming?.expiresInSeconds ?? 0)
  }
}
