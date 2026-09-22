// One interface over the two ways this app can reach YouTube, so a view
// never branches on which is selected. FreeTube presents the same choice
// under the same two names ("Local API" and "Invidious"), and it matters
// here for a reason it does not there: only the Invidious route produces a
// media URL whose host a manifest can name.
//
// `streamSources` returns an ORDERED list, not a URL. Playback is a cascade
// on this platform (playback.js), and only the backend knows which route is
// worth trying first for the streams it just resolved.

import { InnerTube, pickStreams } from './innertube.js'
import { Invidious } from './invidious.js'
import { parseChannel, parsePlayability, parseRelated, parseSearch, parseWatchMetadata } from './parse.js'

class LocalBackend {
  constructor (fetchImpl) {
    this.name = 'local'
    this.yt = new InnerTube(fetchImpl)
    this.lastPlayabilityReason = undefined
  }

  async search (query) {
    return parseSearch(await this.yt.search(query))
  }

  async watch (videoId) {
    const response = await this.yt.next(videoId)
    return { meta: parseWatchMetadata(response), related: parseRelated(response) }
  }

  async channel (authorId) {
    return parseChannel(await this.yt.browse(authorId))
  }

  /**
   * The progressive format first because a bare `<video>` can decode it
   * without Media Source Extensions; the same URL is then offered again as
   * a blob, which is the only one of the two routes CSP could conceivably
   * admit, since a routed fetch is not a browser network load.
   */
  async streamSources (videoId) {
    const response = await this.yt.player(videoId)
    const playability = parsePlayability(response)
    if (!playability.ok) {
      this.lastPlayabilityReason = playability.reason === undefined
        ? `YouTube refused this video (${playability.status}).`
        : `YouTube refused this video: ${playability.reason}`
      return []
    }
    this.lastPlayabilityReason = undefined
    const streams = pickStreams(response)
    const chosen = streams.preferred
    if (chosen === undefined) return []
    return [
      { url: chosen.url, via: 'direct' },
      { url: chosen.url, via: 'blob' }
    ]
  }
}

class InvidiousBackend {
  constructor (host, fetchImpl) {
    this.name = 'invidious'
    this.host = host
    this.inv = new Invidious(host, fetchImpl)
    this.lastPlayabilityReason = undefined
  }

  search (query) {
    return this.inv.search(query)
  }

  async watch (videoId) {
    const video = await this.inv.video(videoId)
    return { meta: video, related: video.related }
  }

  async channel (authorId) {
    const channel = await this.inv.channel(authorId)
    return {
      author: channel.author,
      authorId: channel.authorId,
      handle: channel.authorHandle,
      subscriberText: typeof channel.subCount === 'number' ? `${channel.subCount.toLocaleString()} subscribers` : undefined,
      thumbnail: channel.authorThumbnails?.at(-1)?.url,
      items: (channel.latestVideos ?? []).map((video) => ({
        kind: 'video',
        videoId: video.videoId,
        title: video.title,
        author: channel.author,
        authorId: channel.authorId,
        thumbnail: video.videoThumbnails?.[0]?.url,
        viewCountText: typeof video.viewCount === 'number' ? `${video.viewCount.toLocaleString()} views` : undefined,
        publishedText: video.publishedText
      }))
    }
  }

  async streamSources (videoId) {
    const video = await this.inv.video(videoId)
    const progressive = video.streams?.formatStreams ?? []
    if (progressive.length === 0) {
      this.lastPlayabilityReason = `${this.host} returned no progressive stream for this video.`
      return []
    }
    this.lastPlayabilityReason = undefined
    const sources = []
    for (const format of progressive) {
      const proxied = this.inv.proxiedStreamUrl(format)
      if (proxied !== undefined) sources.push({ url: proxied, via: 'invidious' })
    }
    return sources
  }
}

export function createBackend (name, { instance, fetchImpl }) {
  if (name === 'invidious') return new InvidiousBackend(instance, fetchImpl)
  return new LocalBackend(fetchImpl)
}
