// DOM construction, kept to builders rather than HTML strings. Every string
// rendered here is a title, channel name or description that came from
// YouTube, so it is attacker-influenced text: `textContent` and `append`
// never interpret it, and there is no innerHTML path in this app for one to
// travel down.

export function el (tag, attributes = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of [children].flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child)
  }
  return node
}

export function clear (node) {
  while (node.firstChild !== null) node.firstChild.remove()
  return node
}

/**
 * A thumbnail whose host the grant does not name will be refused by CSP and
 * fire `error`; swapping in a placeholder there keeps a results grid from
 * showing a row of broken-image glyphs with no explanation.
 */
function thumbnail (url, alt) {
  const image = el('img', { class: 'thumb', alt, loading: 'lazy' })
  image.addEventListener('error', () => { image.classList.add('thumb-missing') })
  if (typeof url === 'string') image.src = url
  else image.classList.add('thumb-missing')
  return image
}

function videoCard (video, onOpen) {
  return el('article', { class: 'card', onclick: () => onOpen(video) }, [
    el('div', { class: 'card-media' }, [
      thumbnail(video.thumbnail, video.title ?? 'video thumbnail'),
      video.lengthText !== undefined && el('span', { class: 'badge', text: video.lengthText }),
      video.live === true && video.lengthText === undefined && el('span', { class: 'badge badge-live', text: 'LIVE' })
    ]),
    el('div', { class: 'card-body' }, [
      el('h3', { class: 'card-title', text: video.title ?? 'Untitled', title: video.title ?? '' }),
      el('p', { class: 'card-meta', text: video.author ?? 'Unknown channel' }),
      el('p', {
        class: 'card-meta card-meta-dim',
        text: [video.viewCountText, video.publishedText].filter(Boolean).join(' · ')
      })
    ])
  ])
}

function channelCard (channel, onOpen) {
  return el('article', { class: 'card card-channel', onclick: () => onOpen(channel) }, [
    el('div', { class: 'card-media card-media-round' }, [thumbnail(channel.thumbnail, channel.author ?? 'channel')]),
    el('div', { class: 'card-body' }, [
      el('h3', { class: 'card-title', text: channel.author ?? 'Unknown channel' }),
      el('p', { class: 'card-meta', text: channel.subscriberText ?? '' }),
      el('p', { class: 'card-meta card-meta-dim', text: channel.descriptionText ?? '' })
    ])
  ])
}

function playlistCard (playlist, onOpen) {
  return el('article', { class: 'card', onclick: () => onOpen(playlist) }, [
    el('div', { class: 'card-media' }, [
      thumbnail(playlist.thumbnail, playlist.title ?? 'playlist'),
      el('span', { class: 'badge', text: playlist.videoCountText ?? 'Playlist' })
    ]),
    el('div', { class: 'card-body' }, [
      el('h3', { class: 'card-title', text: playlist.title ?? 'Untitled playlist' }),
      el('p', { class: 'card-meta', text: playlist.author ?? '' })
    ])
  ])
}

export function resultCard (item, onOpen) {
  if (item.kind === 'channel') return channelCard(item, onOpen)
  if (item.kind === 'playlist') return playlistCard(item, onOpen)
  return videoCard(item, onOpen)
}

export function resultGrid (items, onOpen) {
  if (items.length === 0) return el('p', { class: 'empty', text: 'Nothing to show here.' })
  return el('div', { class: 'grid' }, items.map((item) => resultCard(item, onOpen)))
}

export function spinner (label) {
  return el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), el('span', { text: label })])
}

export function notice (kind, title, body) {
  return el('div', { class: `notice notice-${kind}` }, [
    el('strong', { text: title }),
    body === undefined ? undefined : el('p', { text: body })
  ])
}

/**
 * The startup banner. It reports the three platform facts separately
 * because they fail separately: an ungranted app in a real Orivon tab is a
 * different situation from an ordinary browser tab, and a person who is
 * told only "not working" cannot tell which they are in.
 */
export function platformBanner (platform) {
  if (platform.runtime !== 'orivon') {
    return notice(
      'warn',
      'No Orivon runtime detected',
      'This page is running as an ordinary web page, so it cannot reach YouTube: a browser refuses the cross-origin request and strips the headers YouTube requires. Open it inside Orivon to use it.'
    )
  }
  if (!platform.routedFetch) {
    return notice(
      'warn',
      'Orivon is present, but this tab is not a registered app tab',
      'No permission prompt appeared because nothing asked for one: consent happens when an app is INSTALLED, and an app is installed from a public https origin, never from a URL merely opened in a tab. A loopback address such as 127.0.0.1 is refused outright as an install origin, so this app cannot be installed from a dev server at all.'
    )
  }
  if (!platform.canReachYouTube) {
    return notice(
      'warn',
      'Network permission was not granted',
      'This app declared per-capability consent, so it runs without it -- but every YouTube request will be denied until the https permission is granted.'
    )
  }
  if (!platform.canPersist) {
    return notice(
      'info',
      'Running without storage permission',
      'Search history, settings and subscriptions will be kept in memory only and lost when this tab closes.'
    )
  }
  return undefined
}
