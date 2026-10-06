// Opens an ENS gateway address (`<name>.eth.limo`, `<name>.eth.link`) as the
// `.eth` name it stands for, while the setting is on and the verifier can load
// that name. Tied to Electron through the default session's web-request owner.
// This file is the web-request half; the tab hooks that map an address before
// a tab loads it use the same rule (./eth-gateway-rule.ts).
import { session } from 'electron'
import type { ShellInstaller } from './shell-installers.js'
import { ETH_GATEWAY_SUFFIXES, isEthGatewayAddress } from '../browsing/eth-gateway.js'
import { handlerWhileNeeded } from '../sessions/handler-while-needed.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { ETH_GATEWAY_SETTING, gatewayRedirectFor } from './eth-gateway-rule.js'

/** Before HTTPS-only (10), content settings (30) and extensions (1000+), so every later handler sees the `.eth` address. */
const GATEWAY_ORDER = 5

const GATEWAY_URLS = ETH_GATEWAY_SUFFIXES.flatMap((suffix) => [`http://*.${suffix}/*`, `https://*.${suffix}/*`])

export const installEthGatewayRedirect: ShellInstaller = {
  name: 'eth-gateway-redirect',
  install: (_app, services) => {
    const { settings } = services
    const owner = webRequestOwnerFor(session.defaultSession)
    const handler = handlerWhileNeeded(
      () => settings.get(ETH_GATEWAY_SETTING) === true,
      () => owner.onBeforeRequest(GATEWAY_ORDER, { urls: GATEWAY_URLS, types: ['mainFrame'] }, isEthGatewayAddress, (details, current) => {
        if (details.resourceType !== 'mainFrame') return current
        const target = gatewayRedirectFor(settings, details.url)
        return target === undefined ? current : { redirectURL: target }
      })
    )
    handler.sync()
    settings.onChange(() => { handler.sync() })
  }
}
