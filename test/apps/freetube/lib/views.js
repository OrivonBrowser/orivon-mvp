// One function per screen. Each renders into a container it is given and
// owns nothing outside it, so a route change can replace the container
// wholesale without leaving a listener behind.
//
// Every view takes the same `app` context (backend, bridge, platform) rather
// than reaching for module-level state: the settings screen can swap the
// backend under a live app, and a view holding its own copy would keep
// talking to the old one.

import { el, clear, notice, resultGrid, spinner } from './ui.js'
import { Router } from './router.js'
import { explain, play } from './playback.js'
import { KNOWN_INSTANCES } from './invidious.js'

function openItem (item) {
  if (item.kind === 'channel') Router.go('channel', item.authorId)
  else if (item.kind === 'video') Router.go('watch', item.videoId)
}

/**
 * Why a cross-origin request from this tab cannot succeed, or undefined when
 * it can. Checked BEFORE the request rather than after: a doomed fetch
 * reports `TypeError: Failed to fetch`, which names neither the cause nor
 * the fix, and buries both under a message that reads like a network blip.
 */
function networkBlocker (platform) {
  if (platform.runtime !== 'orivon') {
    return notice(
      'warn',
      'This page is not running inside Orivon',
      'Reaching YouTube needs headers a browser forbids a page to set, on an origin CORS refuses. An ordinary browser tab cannot make this request at all, so it is not attempted.'
    )
  }
  if (!platform.routedFetch) {
    return notice(
      'warn',
      'This tab is not a registered app tab',
      'Orivon is here, but this origin has not been granted anything yet. Answer the permission prompt Orivon shows for it, and the tab reloads as the app. See this app\'s README, "Running it".'
    )
  }
  if (!platform.canReachYouTube) {
    return notice(
      'warn',
      'The network permission was not granted',
      'This app asked for per-capability consent and is running without its https permission, so every request would be denied.'
    )
  }
  return undefined
}

/**
 * Runs `work` behind a spinner. `needsNetwork` views short-circuit to the
 * blocker above instead, so an unreachable tab explains itself once rather
 * than failing differently on every screen.
 */
async function withLoading (root, label, work, { app, needsNetwork = false } = {}) {
  const blocked = needsNetwork ? networkBlocker(app.platform) : undefined
  if (blocked !== undefined) {
    clear(root).append(blocked)
    return
  }
  clear(root).append(spinner(label))
  try {
    const rendered = await work()
    clear(root).append(rendered)
  } catch (error) {
    clear(root).append(notice('error', 'That request failed', error.message))
  }
}

export function renderHome (app, root) {
  return withLoading(root, 'Loading...', async () => {
    const history = (await app.bridge.db.history.find()).sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))
    return el('section', {}, [
      el('h2', { text: 'Recently watched' }),
      history.length === 0
        ? notice('info', 'Nothing watched yet', 'Search for something above to get started.')
        : resultGrid(history.slice(0, 24).map((entry) => entry.video), openItem)
    ])
  })
}

export function renderSearch (app, root, query) {
  return withLoading(root, `Searching for "${query}"...`, async () => {
    const found = await app.backend.search(query)
    await app.bridge.db.searchHistory.upsert({ _id: query, query, at: Date.now() })
    return el('section', {}, [
      el('h2', { text: `Results for "${query}"` }),
      resultGrid(found.results, openItem)
    ])
  }, { app, needsNetwork: true })
}

function watchMetaPanel (meta, videoId) {
  return el('div', { class: 'watch-meta' }, [
    el('h1', { class: 'watch-title', text: meta.title ?? videoId }),
    el('p', { class: 'watch-sub', text: [meta.viewCountText, meta.publishedText].filter(Boolean).join(' · ') }),
    el('div', { class: 'watch-channel' }, [
      meta.authorThumbnail !== undefined && el('img', { class: 'avatar', src: meta.authorThumbnail, alt: '' }),
      el('div', {}, [
        el('button', {
          class: 'link-button',
          text: meta.author ?? 'Unknown channel',
          onclick: () => { if (meta.authorId !== undefined) Router.go('channel', meta.authorId) }
        }),
        el('p', { class: 'card-meta card-meta-dim', text: meta.subscriberText ?? '' })
      ])
    ]),
    el('details', { class: 'description' }, [
      el('summary', { text: 'Description' }),
      el('pre', { class: 'description-body', text: meta.description ?? 'No description.' })
    ])
  ])
}

/**
 * The player. `sources` is ordered most-likely-to-work first, and the result
 * of the cascade is rendered as text under the element: a blocked stream is
 * the most common outcome on this platform today, and it must say which of
 * the three routes failed and why.
 */
async function mountPlayer (app, container, videoId) {
  const video = el('video', { class: 'player', controls: 'controls', playsinline: 'playsinline', preload: 'metadata' })
  const status = el('p', { class: 'player-status', text: 'Resolving a stream...' })
  container.append(el('div', { class: 'player-wrap' }, [video, status]))

  let sources
  try {
    sources = await app.backend.streamSources(videoId)
  } catch (error) {
    status.textContent = `No stream could be resolved: ${error.message}`
    return
  }
  if (sources.length === 0) {
    status.textContent = app.backend.lastPlayabilityReason ?? 'YouTube did not return a playable stream for this video.'
    status.classList.add('player-status-blocked')
    return
  }

  const result = await play(video, sources, { violations: app.violations, fetchImpl: app.fetch })
  status.textContent = explain(result)
  status.classList.toggle('player-status-blocked', !result.ok)
}

export function renderWatch (app, root, videoId) {
  return withLoading(root, 'Loading video...', async () => {
    const { meta, related } = await app.backend.watch(videoId)
    const section = el('section', { class: 'watch' })
    await mountPlayer(app, section, videoId)
    section.append(watchMetaPanel(meta, videoId))
    section.append(el('h2', { text: 'Related' }))
    section.append(resultGrid(related, openItem))
    await app.bridge.db.history.upsert({
      _id: videoId,
      watchedAt: Date.now(),
      video: { kind: 'video', videoId, title: meta.title, author: meta.author, authorId: meta.authorId, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
    })
    return section
  }, { app, needsNetwork: true })
}

export function renderChannel (app, root, authorId) {
  return withLoading(root, 'Loading channel...', async () => {
    const channel = await app.backend.channel(authorId)
    return el('section', {}, [
      el('div', { class: 'channel-header' }, [
        channel.thumbnail !== undefined && el('img', { class: 'avatar avatar-large', src: channel.thumbnail, alt: '' }),
        el('div', {}, [
          el('h1', { text: channel.author ?? authorId }),
          el('p', { class: 'card-meta', text: [channel.handle, channel.subscriberText, channel.videoCountText].filter(Boolean).join(' · ') })
        ])
      ]),
      resultGrid(channel.items ?? [], openItem)
    ])
  }, { app, needsNetwork: true })
}

export function renderHistory (app, root) {
  return withLoading(root, 'Loading history...', async () => {
    const history = (await app.bridge.db.history.find()).sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))
    return el('section', {}, [
      el('div', { class: 'row-between' }, [
        el('h2', { text: 'Watch history' }),
        el('button', {
          class: 'button',
          text: 'Clear history',
          onclick: async () => {
            await app.bridge.db.history.deleteAll()
            await renderHistory(app, root)
          }
        })
      ]),
      app.bridge.platform.persistent
        ? undefined
        : notice('info', 'This history is in memory only', 'The filesystem permission was not granted, so nothing here survives a reload.'),
      resultGrid(history.map((entry) => entry.video), openItem)
    ])
  })
}

function grantRows (platform) {
  if (platform.grants.length === 0) return [el('p', { class: 'card-meta', text: 'No capabilities are granted to this app.' })]
  return platform.grants.map((grant) => el('li', {
    text: `${grant.capability}${grant.patterns.length === 0 ? '' : ` -> ${grant.patterns.join(', ')}`}`
  }))
}

export function renderSettings (app, root) {
  const backendChoice = el('select', {
    class: 'input',
    onchange: (event) => { void app.setBackend(event.target.value) }
  }, [
    el('option', { value: 'local', text: 'Local API (talk to YouTube directly)', selected: app.backendName === 'local' }),
    el('option', { value: 'invidious', text: 'Invidious (talk to a proxy instance)', selected: app.backendName === 'invidious' })
  ])

  const instanceChoice = el('select', {
    class: 'input',
    onchange: (event) => { void app.setInstance(event.target.value) }
  }, KNOWN_INSTANCES.map((host) => el('option', { value: host, text: host, selected: app.instance === host })))

  return clear(root).append(el('section', {}, [
    el('h2', { text: 'Settings' }),
    el('div', { class: 'setting' }, [
      el('label', { text: 'Backend' }),
      backendChoice,
      el('p', { class: 'card-meta card-meta-dim', text: 'Local reaches YouTube itself. Invidious asks a proxy instance, which is the only route whose video host this app\'s manifest can name.' })
    ]),
    el('div', { class: 'setting' }, [
      el('label', { text: 'Invidious instance' }),
      instanceChoice,
      el('p', { class: 'card-meta card-meta-dim', text: 'Only instances this app\'s manifest declares can be selected: a hostname typed at runtime is one no manifest predicted, so no grant could cover it.' })
    ]),
    el('div', { class: 'setting' }, [
      el('h3', { text: 'What this app was granted' }),
      el('ul', { class: 'grants' }, grantRows(app.platform))
    ]),
    el('div', { class: 'setting' }, [
      el('h3', { text: 'Storage' }),
      el('p', { class: 'card-meta', text: app.bridge.platform.persistent ? 'Persisted to this app\'s own directory.' : 'In memory only: the filesystem permission was not granted.' }),
      el('button', {
        class: 'button',
        text: 'Delete all stored data',
        onclick: async () => {
          for (const name of ['history', 'searchHistory', 'settings', 'subscriptionCache']) await app.bridge.db[name].deleteAll()
          renderSettings(app, root)
        }
      })
    ])
  ]))
}
