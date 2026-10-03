// Wires the network privacy controls once the settings are loaded: the header
// signals, third-party cookie blocking and HTTPS-only as handlers on the
// default session's one web-request owner (never on `session.webRequest`,
// which a second registration would silently replace), the warning sheet's
// wiring, the storage-access answer and secure DNS. A handler is on the owner only
// while a setting needs it, and still reads its setting per request: a change in
// Settings registers or removes it before the next request.
import { session } from 'electron'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { handlerWhileNeeded } from '../sessions/handler-while-needed.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { siteAsks } from '../sessions/site-asks.js'
import { upgradeTracker } from './https-fallback.js'
import { createFallbackSheets } from './https-fallback-runner.js'
import { httpsState } from './https-state.js'
import { createNetHandlers } from './net-handlers.js'
import { applySecureDns, needsResolverCall } from './secure-dns.js'
import type { SecureDnsValue } from './secure-dns.js'
import { createStorageAccessAsker } from './storage-access.js'

/** After the sign-in identity headers (order 0), before anything that must run last (RUN_LAST). */
const PRIVACY_ORDER = 20
const HTTPS_ORDER = 10

// WebSocket handshakes are included: they carry the cookies of their own host, so a third-party one is stripped like any request.
const WEB = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
const WEB_ADDRESS = (url: string): boolean => /^(https?|wss?):\/\//.test(url)
const PLAIN_ADDRESS = (url: string): boolean => url.startsWith('http://')

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

    const owner = webRequestOwnerFor(session.defaultSession)
    const { settings } = services
    const blockingCookies = (): boolean => settings.get('privacy.cookies') === 'blockThirdParty'
    const wanted = [
      handlerWhileNeeded(
        () => settings.get('privacy.httpsOnly') === true,
        () => owner.onBeforeRequest(HTTPS_ORDER, { urls: ['http://*/*'], types: ['mainFrame'] }, PLAIN_ADDRESS, handlers.beforeRequest)
      ),
      handlerWhileNeeded(
        () => settings.get('privacy.globalPrivacyControl') === true || settings.get('privacy.doNotTrack') === true || blockingCookies(),
        () => owner.onBeforeSendHeaders(PRIVACY_ORDER, WEB, WEB_ADDRESS, handlers.beforeSendHeaders)
      ),
      handlerWhileNeeded(blockingCookies, () => owner.onHeadersReceived(PRIVACY_ORDER, WEB, WEB_ADDRESS, handlers.headersReceived))
    ]
    const syncHandlers = (): void => { for (const handler of wanted) handler.sync() }
    syncHandlers()
    settings.onChange(syncHandlers)

    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { sheets.watch(contents) },
      viewReplaced: (_old, contents) => { sheets.watch(contents) }
    })

    siteAsks.add(createStorageAccessAsker({
      blocking: () => services.settings.get('privacy.cookies') === 'blockThirdParty',
      isTab: (contents) => services.windows.findTab(contents) !== null
    }))

    const dns = (): SecureDnsValue => services.settings.get('privacy.secureDns')
    if (needsResolverCall(dns())) applySecureDns(app, dns())
    services.settings.onChange(({ key }) => { if (key === 'privacy.secureDns') applySecureDns(app, dns()) })
  }
}
