// InnerTube answers in "renderers": deeply nested, versioned, and replaced
// without notice. Every field read lives in this file so a shape change is
// one file to repair, and every reader is total -- a missing branch yields
// undefined and a partly-parsed card, never a thrown error that empties a
// whole page of results.
//
// Two generations of shape are live at once and both must be read: the older
// `videoRenderer` (search) and the newer `lockupViewModel` (related rails,
// shelves). They are not variants of one shape; they share no field paths.

/** Text arrives as `{runs:[{text}]}`, `{simpleText}` or `{content}` depending on the renderer's generation. */
export function text (node) {
  if (node === undefined || node === null) return undefined
  if (typeof node === 'string') return node
  if (typeof node.simpleText === 'string') return node.simpleText
  if (typeof node.content === 'string') return node.content
  if (Array.isArray(node.runs)) return node.runs.map((run) => run?.text ?? '').join('')
  return undefined
}

function largest (images) {
  if (!Array.isArray(images) || images.length === 0) return undefined
  let best = images[0]
  for (const image of images) {
    if ((image?.width ?? 0) > (best?.width ?? 0)) best = image
  }
  return best?.url
}

export function thumbnailOf (node) {
  return largest(node?.thumbnail?.thumbnails) ?? largest(node?.thumbnails) ?? largest(node?.sources)
}

/** A YouTube duration badge is `h:mm:ss` or `m:ss`; seconds are what a progress bar and a history entry both want. */
export function durationSeconds (label) {
  if (typeof label !== 'string') return undefined
  const parts = label.split(':').map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part))) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function videoFromVideoRenderer (renderer) {
  const owner = renderer.ownerText?.runs?.[0] ?? renderer.longBylineText?.runs?.[0]
  const length = text(renderer.lengthText)
  return {
    kind: 'video',
    videoId: renderer.videoId,
    title: text(renderer.title),
    author: text(renderer.ownerText) ?? text(renderer.longBylineText),
    authorId: owner?.navigationEndpoint?.browseEndpoint?.browseId,
    thumbnail: thumbnailOf(renderer),
    lengthText: length,
    lengthSeconds: durationSeconds(length),
    viewCountText: text(renderer.viewCountText) ?? text(renderer.shortViewCountText),
    publishedText: text(renderer.publishedTimeText),
    live: (renderer.badges ?? []).some((badge) => text(badge?.metadataBadgeRenderer?.label) === 'LIVE')
  }
}

/**
 * `lockupViewModel` carries no labelled fields: author, views and age are
 * positional strings in `metadataRows` -- row 0 is the channel, row 1 is
 * view count and age. Reading them by position is not a shortcut; there is
 * no name in the payload to read instead.
 *
 * `contentType` is the one labelled field, and it is load-bearing: a
 * playlist lockup fills those same rows with its first two ENTRIES, so a
 * parser that skips this check reports a playlist as a video whose author
 * is another video's title.
 */
function lockupRows (lockup) {
  const rows = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ?? []
  return rows.map((row) => (row.metadataParts ?? []).map((part) => text(part?.text)).filter(Boolean))
}

function lockupAuthorId (lockup) {
  const avatar = lockup.metadata?.lockupMetadataViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel
  return avatar?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId
}

function videoFromLockup (lockup) {
  const rows = lockupRows(lockup)
  const badge = lockup.contentImage?.thumbnailViewModel?.overlays
    ?.flatMap((overlay) => overlay?.thumbnailBottomOverlayViewModel?.badges ?? [])
    .map((entry) => entry?.thumbnailBadgeViewModel?.text)
    .find((label) => typeof label === 'string' && label.includes(':'))
  return {
    kind: 'video',
    videoId: lockup.contentId,
    title: text(lockup.metadata?.lockupMetadataViewModel?.title),
    author: rows[0]?.[0],
    authorId: lockupAuthorId(lockup),
    thumbnail: largest(lockup.contentImage?.thumbnailViewModel?.image?.sources),
    lengthText: badge,
    lengthSeconds: durationSeconds(badge),
    viewCountText: rows[1]?.[0],
    publishedText: rows[1]?.[1],
    live: badge === undefined
  }
}

function playlistFromLockup (lockup) {
  const rows = lockupRows(lockup)
  return {
    kind: 'playlist',
    playlistId: lockup.contentId,
    title: text(lockup.metadata?.lockupMetadataViewModel?.title),
    author: rows[0]?.[0],
    authorId: lockupAuthorId(lockup),
    thumbnail: largest(lockup.contentImage?.thumbnailViewModel?.image?.sources),
    videoCountText: rows[0]?.[1]
  }
}

function fromLockup (lockup) {
  switch (lockup.contentType) {
    case 'LOCKUP_CONTENT_TYPE_VIDEO': return videoFromLockup(lockup)
    case 'LOCKUP_CONTENT_TYPE_PLAYLIST': return playlistFromLockup(lockup)
    default: return undefined
  }
}

function channelFromRenderer (renderer) {
  return {
    kind: 'channel',
    authorId: renderer.channelId,
    author: text(renderer.title),
    thumbnail: thumbnailOf(renderer),
    subscriberText: text(renderer.videoCountText) ?? text(renderer.subscriberCountText),
    descriptionText: text(renderer.descriptionSnippet)
  }
}

function playlistFromRenderer (renderer) {
  return {
    kind: 'playlist',
    playlistId: renderer.playlistId,
    title: text(renderer.title),
    author: text(renderer.shortBylineText),
    thumbnail: thumbnailOf(renderer) ?? largest(renderer.thumbnails?.[0]?.thumbnails),
    videoCountText: text(renderer.videoCount) ?? text(renderer.videoCountText)
  }
}

/** One result card, whichever of the five live shapes it arrived as, or undefined for a shape this app does not show (ads, shelves, promos). */
export function parseItem (item) {
  if (item?.videoRenderer) return videoFromVideoRenderer(item.videoRenderer)
  if (item?.lockupViewModel) return fromLockup(item.lockupViewModel)
  if (item?.compactVideoRenderer) return videoFromVideoRenderer(item.compactVideoRenderer)
  if (item?.gridVideoRenderer) return videoFromVideoRenderer(item.gridVideoRenderer)
  if (item?.richItemRenderer) return parseItem(item.richItemRenderer.content)
  if (item?.channelRenderer) return channelFromRenderer(item.channelRenderer)
  if (item?.playlistRenderer) return playlistFromRenderer(item.playlistRenderer)
  return undefined
}

export function parseItems (items) {
  const parsed = []
  for (const item of items ?? []) {
    const one = parseItem(item)
    if (one !== undefined && (one.videoId ?? one.authorId ?? one.playlistId) !== undefined) parsed.push(one)
  }
  return parsed
}

export function parseSearch (response) {
  const sections = response?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? []
  const items = sections.flatMap((section) => section?.itemSectionRenderer?.contents ?? [])
  return { results: parseItems(items) }
}

export function parseRelated (response) {
  const results = response?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results ?? []
  return parseItems(results)
}

export function parseWatchMetadata (response) {
  const contents = response?.contents?.twoColumnWatchNextResults?.results?.results?.contents ?? []
  const primary = contents.find((entry) => entry.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer
  const secondary = contents.find((entry) => entry.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer
  const owner = secondary?.owner?.videoOwnerRenderer
  return {
    title: text(primary?.title),
    viewCountText: text(primary?.viewCount?.videoViewCountRenderer?.viewCount),
    publishedText: text(primary?.relativeDateText) ?? text(primary?.dateText),
    author: text(owner?.title),
    authorId: owner?.navigationEndpoint?.browseEndpoint?.browseId,
    authorThumbnail: thumbnailOf(owner),
    subscriberText: text(owner?.subscriberCountText),
    description: text(secondary?.attributedDescription) ?? text(secondary?.description)
  }
}

export function parseChannel (response) {
  const header = response?.header?.pageHeaderRenderer
  const view = header?.content?.pageHeaderViewModel
  const rows = (view?.metadata?.contentMetadataViewModel?.metadataRows ?? [])
    .map((row) => (row.metadataParts ?? []).map((part) => text(part?.text)).filter(Boolean))
  const tabs = response?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? []
  const selected = tabs.find((tab) => tab.tabRenderer?.selected)?.tabRenderer
  const sections = selected?.content?.sectionListRenderer?.contents
    ?? selected?.content?.richGridRenderer?.contents
    ?? []
  const items = sections.flatMap((section) => section?.itemSectionRenderer?.contents ?? [section])
    .flatMap((section) => section?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items ?? [section])
  return {
    author: header?.pageTitle,
    authorId: response?.metadata?.channelMetadataRenderer?.externalId,
    handle: rows[0]?.[0],
    subscriberText: rows[1]?.[0],
    videoCountText: rows[1]?.[1],
    thumbnail: largest(view?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources)
      ?? largest(response?.metadata?.channelMetadataRenderer?.avatar?.thumbnails),
    tabs: tabs.map((tab) => tab.tabRenderer?.title).filter(Boolean),
    items: parseItems(items)
  }
}

/** `playabilityStatus` is the only field that says whether a stream list is worth reading; `OK` is the sole value that carries one. */
export function parsePlayability (response) {
  const status = response?.playabilityStatus
  return {
    ok: status?.status === 'OK',
    status: status?.status,
    reason: text(status?.reason) ?? text(status?.errorScreen?.playerErrorMessageRenderer?.reason)
  }
}
