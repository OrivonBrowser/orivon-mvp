// Opens an ENS gateway address (`<name>.eth.limo`, `<name>.eth.link`) as the
// `.eth` name it stands for, while the setting is on and the verifier can load
// that name: a tab's own address and everything a page loads. Tied to Electron
// through the web-request owner of each session a website runs in.
// This file is the web-request half; the tab hooks that map an address before
// a tab loads it use the same rule (./eth-gateway-rule.ts).
import type { ShellInstaller } from './shell-installers.js'
import { ETH_GATEWAY_SUFFIXES, isEthGatewayAddress } from '../browsing/eth-gateway.js'
import { handlerWhileNeeded } from '../sessions/handler-while-needed.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession } from '../sessions/website-sessions.js'
import { MappedRequests, mapsResourceType, withGatewayCors } from './eth-gateway-embedded.js'
import { ETH_GATEWAY_SETTING, gatewayRedirectFor } from './eth-gateway-rule.js'

/** Before HTTPS-only (10), content settings (30) and extensions (1000+), so every later handler sees the `.eth` address. */
const GATEWAY_ORDER = 5

const GATEWAY_URLS = ETH_GATEWAY_SUFFIXES.flatMap((suffix) => [`http://*.${suffix}/*`, `https://*.${suffix}/*`])

/** Where a mapped request lands: a `.eth` host, over https or, for a developer-mode name, http. */
const ETH_URLS = ['http://*.eth/*', 'https://*.eth/*']

export const installEthGatewayRedirect: ShellInstaller = {
  name: 'eth-gateway-redirect',
  install: (_app, services) => {
    const { settings } = services
    forEachWebsiteSession((website) => {
      const owner = webRequestOwnerFor(website)
      const moved = new MappedRequests()
      const handler = handlerWhileNeeded(
        () => settings.get(ETH_GATEWAY_SETTING) === true,
        () => {
          // No `types` in the filter: the type list Electron takes has no `other`, and a page loads some files as that.
          const redirect = owner.onBeforeRequest(GATEWAY_ORDER, { urls: GATEWAY_URLS }, isEthGatewayAddress, (details, current) => {
            if (!mapsResourceType(details.resourceType)) return current
            const target = gatewayRedirectFor(settings, details.url)
            if (target === undefined) return current
            if (details.resourceType !== 'mainFrame') moved.add(details.id)
            return { redirectURL: target }
          })
          // The gateway answers every request with CORS headers, so a page reads what it fetched there; the verifier sends none, so the answer to a moved request gets them.
          const cors = owner.onHeadersReceived(GATEWAY_ORDER, { urls: ETH_URLS }, () => true, (details, current) => {
            if (!moved.has(details.id)) return current
            if (details.statusCode < 300 || details.statusCode >= 400) moved.forget(details.id)
            return { ...current, responseHeaders: withGatewayCors(current.responseHeaders) }
          })
          return { remove: () => { redirect.remove(); cors.remove() } }
        }
      )
      handler.sync()
      settings.onChange(() => { handler.sync() })
    })
  }
}
