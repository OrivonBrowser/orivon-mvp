// Wires the network privacy controls once the settings are loaded: the header
// signals, third-party cookie blocking and HTTPS-only as handlers on the
// web-request owner of each session a website runs in (never on `session.webRequest`,
// which a second registration would silently replace), the warning sheet's
// wiring, the storage-access answer and secure DNS. A handler is on the owner only
// while a setting needs it, and still reads its setting per request: a change in
// Settings registers or removes it before the next request.
import { net } from 'electron'
import type { App } from 'electron'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { handlerWhileNeeded } from '../sessions/handler-while-needed.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession, websiteSessions } from '../sessions/website-sessions.js'
import { siteAsks } from '../sessions/site-asks.js'
import { upgradeTracker } from './https-fallback.js'
import { createFallbackSheets } from './https-fallback-runner.js'
import { httpsState } from './https-state.js'
import { createNetHandlers } from './net-handlers.js'
import { applySecureDns, configureResolver, effectiveSecureDns, needsResolverCall, secureDnsForcedOff } from './secure-dns.js'
import { PROBE_NAME, QUAD9_PROBE_TIMEOUT_MS, createQuad9Fallback, probeWithin } from './secure-dns-fallback.js'
import type { Quad9Fallback } from './secure-dns-fallback.js'
import type { SecureDnsValue } from './secure-dns.js'
import { createStorageAccessAsker } from './storage-access.js'

/** After the sign-in identity headers (order 0), before anything that must run last (RUN_LAST). */
const PRIVACY_ORDER = 20
const HTTPS_ORDER = 10

// WebSocket handshakes are included: they carry the cookies of their own host, so a third-party one is stripped like any request.
const WEB = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
const WEB_ADDRESS = (url: string): boolean => /^(https?|wss?):\/\//.test(url)
const PLAIN_ADDRESS = (url: string): boolean => url.startsWith('http://')

/** The default choice's Quad9-first logic on the real resolver: every session's host cache is dropped when Quad9 takes over again. */
function quad9FallbackFor (app: App): Quad9Fallback {
  return createQuad9Fallback({
    configure: (options) => { configureResolver(app, options) },
    probe: async () => await probeWithin(async (host, options) => await net.resolveHost(host, options), PROBE_NAME, QUAD9_PROBE_TIMEOUT_MS),
    clearCaches: async () => { await Promise.all(websiteSessions().map(async (target) => { await target.clearHostResolverCache() })) },
    online: () => net.online,
    log: (line) => { console.log(line) },
    every: (task, ms) => {
      const timer = setInterval(task, ms)
      timer.unref()
      return () => { clearInterval(timer) }
    }
  })
}

export const installPrivacyNet: ShellInstaller = {
  name: 'privacy-net',
  install: (app, services) => {
    const tracker = upgradeTracker
    const sheets = createFallbackSheets({ tracker, state: httpsState, windows: services.windows, requestSlot })
    const handlers = createNetHandlers({
      settings: services.settings,
      exemptions: httpsState.exemptions,
      tracker,
      isDevHost: isDevEthName,
      loopDetected: (contents, from) => {
        try { sheets.show(contents, { from, host: new URL(from).hostname }) } catch (error) { console.error('[privacy] could not show the secure-connection warning:', error) }
      }
    })

    const { settings } = services
    const blockingCookies = (): boolean => settings.get('privacy.cookies') === 'blockThirdParty'
    // The shared session and each session of its own a website gets: a website that moves into one keeps these.
    forEachWebsiteSession((target) => {
      const owner = webRequestOwnerFor(target)
      const wanted = [
        handlerWhileNeeded(
          () => settings.get('privacy.httpsOnly') === true,
          () => owner.onBeforeRequest(HTTPS_ORDER, { urls: ['http://*/*'], types: ['mainFrame'] }, PLAIN_ADDRESS, handlers.beforeRequest)
        ),
        handlerWhileNeeded(
          () => settings.get('privacy.doNotTrack') === true || blockingCookies(),
          () => owner.onBeforeSendHeaders(PRIVACY_ORDER, WEB, WEB_ADDRESS, handlers.beforeSendHeaders)
        ),
        handlerWhileNeeded(blockingCookies, () => owner.onHeadersReceived(PRIVACY_ORDER, WEB, WEB_ADDRESS, handlers.headersReceived))
      ]
      const syncHandlers = (): void => { for (const handler of wanted) handler.sync() }
      syncHandlers()
      settings.onChange(syncHandlers)
    })

    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { sheets.watch(contents) },
      viewReplaced: (_old, contents) => { sheets.watch(contents) }
    })

    siteAsks.add(createStorageAccessAsker({
      blocking: () => services.settings.get('privacy.cookies') === 'blockThirdParty',
      isTab: (contents) => services.windows.findTab(contents) !== null
    }))

    const dns = (): SecureDnsValue => effectiveSecureDns(services.settings.get('privacy.secureDns'), services.settings.isDefault('privacy.secureDns'), secureDnsForcedOff())
    let quad9First: Quad9Fallback | undefined
    const applyDns = (): void => {
      quad9First?.stop()
      quad9First = undefined
      const value = dns()
      if (value === 'quad9Fallback') {
        quad9First = quad9FallbackFor(app)
        quad9First.start()
      } else {
        applySecureDns(app, value)
      }
    }
    if (needsResolverCall(dns())) applyDns()
    services.settings.onChange(({ key }) => { if (key === 'privacy.secureDns') applyDns() })
  }
}
