// FreeTube's second backend, kept here for the same reason FreeTube keeps
// it: an Invidious instance answers with plain, already-parsed JSON and does
// the proof-of-origin work server-side, so it reaches videos the direct
// InnerTube path cannot.
//
// It also solves a problem specific to Orivon. An instance has ONE STABLE
// HOSTNAME, and a manifest can name it; `*.googlevideo.com` rotates its
// subdomain per request and no manifest pattern can. Because the served CSP
// names only hosts a grant names literally, an instance's `?local=true`
// proxy is the only <video> source in this app that CSP can actually admit.
// See README.md's Design notes.

const INSTANCE_TIMEOUT_MS = 12_000

/** The instances this app's manifest declares. A person can only choose among these: a hostname typed at runtime is one no manifest predicted, which is the gap ADR-0017 names and does not close. */
export const KNOWN_INSTANCES = [
  'inv.nadeko.net',
  'invidious.nerdvpn.de',
  'yewtu.be',
  'invidious.jing.rocks'
]

export class Invidious {
  constructor (host, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.host = host
    this.fetch = fetchImpl
  }

  async get (path) {
    const response = await this.fetch(`https://${this.host}/api/v1/${path}`, {
      headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(INSTANCE_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`${this.host} returned HTTP ${response.status}`)
    return await response.json()
  }

  async search (query) {
    const found = await this.get(`search?q=${encodeURIComponent(query)}&type=all`)
    return { results: found.map(fromInvidiousItem).filter(Boolean) }
  }

  async video (videoId) {
    const video = await this.get(`videos/${encodeURIComponent(videoId)}`)
    return {
      title: video.title,
      author: video.author,
      authorId: video.authorId,
      authorThumbnail: video.authorThumbnails?.at(-1)?.url,
      viewCountText: typeof video.viewCount === 'number' ? `${video.viewCount.toLocaleString()} views` : undefined,
      publishedText: video.publishedText,
      subscriberText: typeof video.subCountText === 'string' ? video.subCountText : undefined,
      description: video.description,
      lengthSeconds: video.lengthSeconds,
      related: (video.recommendedVideos ?? []).map(fromInvidiousItem).filter(Boolean),
      streams: video
    }
  }

  channel (authorId) {
    return this.get(`channels/${encodeURIComponent(authorId)}`)
  }

  /**
   * The instance's own proxy for a stream, which is what makes the URL
   * same-host as the instance rather than a rotating googlevideo name.
   * Rebuilt onto `this.host` rather than used as returned: an instance may
   * hand back a direct googlevideo URL, and that one is unreachable here.
   */
  proxiedStreamUrl (format) {
    if (typeof format?.url !== 'string') return undefined
    let source
    try {
      source = new URL(format.url)
    } catch {
      return undefined
    }
    const separator = source.search === '' ? '?' : '&'
    return `https://${this.host}${source.pathname}${source.search}${separator}local=true`
  }
}

function fromInvidiousItem (item) {
  if (item.type === 'channel') {
    return {
      kind: 'channel',
      authorId: item.authorId,
      author: item.author,
      thumbnail: normaliseThumbnail(item.authorThumbnails?.at(-1)?.url),
      subscriberText: typeof item.subCount === 'number' ? `${item.subCount.toLocaleString()} subscribers` : undefined
    }
  }
  if (item.type === 'playlist') {
    return {
      kind: 'playlist',
      playlistId: item.playlistId,
      title: item.title,
      author: item.author,
      thumbnail: normaliseThumbnail(item.playlistThumbnail),
      videoCountText: typeof item.videoCount === 'number' ? `${item.videoCount} videos` : undefined
    }
  }
  if (item.videoId === undefined) return undefined
  return {
    kind: 'video',
    videoId: item.videoId,
    title: item.title,
    author: item.author,
    authorId: item.authorId,
    thumbnail: normaliseThumbnail(item.videoThumbnails?.[0]?.url),
    lengthSeconds: item.lengthSeconds,
    lengthText: formatDuration(item.lengthSeconds),
    viewCountText: typeof item.viewCount === 'number' ? `${item.viewCount.toLocaleString()} views` : undefined,
    publishedText: item.publishedText,
    live: item.liveNow === true
  }
}

/** An instance may return a thumbnail proxied through itself or straight from `i.ytimg.com`; both are hosts the manifest declares, so either is left as it arrived. */
function normaliseThumbnail (url) {
  return typeof url === 'string' && url.length > 0 ? url : undefined
}

export function formatDuration (seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  const whole = Math.floor(seconds)
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60]
  const trimmed = parts[0] === 0 ? parts.slice(1) : parts
  return trimmed.map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0'))).join(':')
}
