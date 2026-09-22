// Bootstrap: detect what this tab can do, build the bridge FreeTube's
// renderer expects, then hand control to the router.
//
// The CSP violation watcher is installed FIRST, before any request is made.
// It is the only way to tell a stream the browser's policy refused from one
// the host refused, and a listener attached after the first load has already
// missed the event it exists to catch.

import { detectPlatform } from './platform.js'
import { installFtElectron } from './ft-electron.js'
import { createBackend } from './backend.js'
import { watchPolicyViolations } from './playback.js'
import { Router } from './router.js'
import { clear, el, platformBanner } from './ui.js'
import { renderChannel, renderHistory, renderHome, renderSearch, renderSettings, renderWatch } from './views.js'
import { KNOWN_INSTANCES } from './invidious.js'

const SETTINGS_ID = 'app'

function header (app) {
  const input = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search YouTube',
    'aria-label': 'Search YouTube'
  })
  const submit = () => {
    const query = input.value.trim()
    if (query.length > 0) Router.go('search', query)
  }
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit() })

  return el('header', { class: 'chrome' }, [
    el('button', { class: 'brand', text: 'FreeTube', onclick: () => Router.go('home') }),
    el('div', { class: 'search' }, [input, el('button', { class: 'button', text: 'Search', onclick: submit })]),
    el('nav', { class: 'nav' }, [
      el('button', { class: 'link-button', text: 'History', onclick: () => Router.go('history') }),
      el('button', { class: 'link-button', text: 'Settings', onclick: () => Router.go('settings') })
    ]),
    el('span', { class: `pill pill-${app.platform.runtime}`, text: app.platform.runtime === 'orivon' ? 'Orivon' : 'no runtime' })
  ])
}

async function loadSettings (bridge) {
  const stored = await bridge.db.settings.findOne({ _id: SETTINGS_ID })
  return {
    backendName: stored?.backendName ?? 'local',
    instance: stored?.instance ?? KNOWN_INSTANCES[0]
  }
}

function route (app, container, current) {
  const [first] = current.args
  switch (current.name) {
    case 'search': return renderSearch(app, container, first)
    case 'watch': return renderWatch(app, container, first)
    case 'channel': return renderChannel(app, container, first)
    case 'history': return renderHistory(app, container)
    case 'settings': return renderSettings(app, container)
    default: return renderHome(app, container)
  }
}

async function start () {
  const violations = watchPolicyViolations()
  const platform = await detectPlatform()
  const { bridge } = installFtElectron(globalThis.orivon, platform)
  const settings = await loadSettings(bridge)

  const app = {
    platform,
    bridge,
    violations,
    fetch: globalThis.fetch.bind(globalThis),
    backendName: settings.backendName,
    instance: settings.instance,
    backend: undefined,
    async persistSettings () {
      await bridge.db.settings.upsert({ _id: SETTINGS_ID, backendName: this.backendName, instance: this.instance })
    },
    rebuildBackend () {
      this.backend = createBackend(this.backendName, { instance: this.instance, fetchImpl: this.fetch })
    },
    async setBackend (name) {
      this.backendName = name
      this.rebuildBackend()
      await this.persistSettings()
    },
    async setInstance (host) {
      this.instance = host
      this.rebuildBackend()
      await this.persistSettings()
    }
  }
  app.rebuildBackend()

  const root = document.querySelector('#app')
  const container = el('main', { class: 'content' })
  clear(root)
  root.append(header(app))
  const banner = platformBanner(platform)
  if (banner !== undefined) root.append(el('div', { class: 'banner' }, [banner]))
  root.append(container)

  new Router((current) => { void route(app, container, current) }).start()
}

void start()
