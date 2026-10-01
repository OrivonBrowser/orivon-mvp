// Wires the content settings once the settings are loaded: pop-ups blocked
// unless the person's own input opened them, JavaScript and images switched
// off per site, sound silenced per site, and downloads a page starts on its
// own asked about. Every request-level rule is a handler on the default
// session's one web-request owner (never `session.webRequest`, which a second
// registration would silently replace) that reads its setting per request, so
// a change takes effect on the next request without re-registering anything.
import { session } from 'electron'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { applyMuted } from '../shell/signals/audio.js'
import { askSite } from './ask-site.js'
import { createAutoDownloads } from './auto-downloads.js'
import { createContentRules, isPdf, requestPage, withScriptBlock } from './content-rules.js'
import type { ContentKind } from './content-rules.js'
import { pageAccess } from './page-access.js'
import { createPopupBlocker } from './popup-blocker.js'
import { siteContentBlocks } from './site-content-blocks.js'
import { popupBlocks, sitePopups, tabInteraction } from './site-popups.js'
import { siteSound } from './site-sound.js'

/** After the privacy controls (order 20): whatever they did to a response, the script block is added to the result. */
const CONTENT_ORDER = 30
const WEB = ['http://*/*', 'https://*/*']
const WEB_ADDRESS = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

export const installContentSettings: ShellInstaller = {
  name: 'content-settings',
  install: (_app, services, ctx) => {
    const { settings, siteSettings } = services
    const rules = createContentRules({
      store: siteSettings,
      defaultFor: (kind: ContentKind) => settings.get(`sites.${kind}`) === 'block' ? 'block' : 'allow',
      // The same test the permission gate makes: an app holding grants, or one served from the cache.
      isApp: (origin) => ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin)
    })

    sitePopups.bind(createPopupBlocker({ rules, interaction: tabInteraction, blocks: popupBlocks }))
    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { sitePopups.watch(contents) },
      viewReplaced: (_old, contents) => { sitePopups.watch(contents) }
    })

    const owner = webRequestOwnerFor(session.defaultSession)
    // The owner matches a handler by address alone, so each one checks the kind of request it is about.
    owner.onHeadersReceived(CONTENT_ORDER, { urls: WEB, types: ['mainFrame', 'subFrame'] }, WEB_ADDRESS, (details, current) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return current
      // A main frame's own address is the page; a frame's page is the top document it sits in.
      const page = details.resourceType === 'mainFrame' ? details.url : requestPage(details)
      if (!rules.scriptsBlocked(page) || isPdf(current.responseHeaders)) return current
      return { ...current, responseHeaders: withScriptBlock(current.responseHeaders) }
    })
    owner.onBeforeRequest(CONTENT_ORDER, { urls: WEB, types: ['image'] }, WEB_ADDRESS, (details, current) => {
      return details.resourceType === 'image' && rules.imagesBlocked(requestPage(details)) ? { cancel: true } : current
    })

    siteSound.bind((pageUrl) => rules.soundBlocked(pageUrl))
    const applySound = (): void => {
      for (const window of services.windows.all()) {
        for (const id of window.tabs.ids()) {
          const record = window.tabs.record(id)
          if (record !== undefined) applyMuted(record)
        }
        window.tabs.changed()
      }
    }
    siteSettings.onChange(applySound)
    siteContentBlocks.bind((pageUrl) => rules.scriptsBlocked(pageUrl) || rules.imagesBlocked(pageUrl) || rules.soundBlocked(pageUrl))
    siteSettings.onChange(() => { siteContentBlocks.changed() })
    settings.onChange(({ key }) => {
      if (key === 'sites.sound') applySound()
      if (key === 'sites.javascript' || key === 'sites.images' || key === 'sites.sound') siteContentBlocks.changed()
    })

    services.downloads.onStart(createAutoDownloads({
      store: siteSettings,
      defaultFor: () => settings.get('sites.autoDownloads') === 'block' ? 'block' : 'ask',
      isApp: (origin) => ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin),
      isTab: (contents) => services.windows.findTab(contents) !== null,
      ask: askSite,
      access: pageAccess
    }))
  }
}
