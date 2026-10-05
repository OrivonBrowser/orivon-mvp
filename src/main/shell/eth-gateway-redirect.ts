// Opens an ENS gateway address (`<name>.eth.limo`, `<name>.eth.link`) as the
// `.eth` name it stands for, while the setting is on and the verifier can load
// that name. Tied to Electron through the default session's web-request owner.
// This file is the web-request half; the tab hooks that map an address before
// a tab loads it call `gatewayRedirectFor` too (see README.md's Design notes).
import { session } from 'electron'
import type { ShellInstaller } from './shell-installers.js'
import { ETH_GATEWAY_SUFFIXES, ethGatewayTarget } from '../browsing/eth-gateway.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { handlerWhileNeeded } from '../sessions/handler-while-needed.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { verifierServesName } from '../verifier/verifier-access.js'

/** Before HTTPS-only (10), content settings (30) and extensions (1000+), so every later handler sees the `.eth` address. */
const GATEWAY_ORDER = 5

const SETTING = 'web3.ethGatewayRedirect'
const GATEWAY_URLS = ETH_GATEWAY_SUFFIXES.flatMap((suffix) => [`http://*.${suffix}/*`, `https://*.${suffix}/*`])

/** The handler's own test, so it runs for gateway hosts alone even once another handler widens the shared URL filter. */
function isGatewayAddress (url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') && ETH_GATEWAY_SUFFIXES.some((suffix) => hostname.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

export interface GatewaySettings {
  get: (key: typeof SETTING) => boolean
}

/** The `.eth` address `url` opens as, or undefined when it opens as it is: no settings yet, the setting off, not a gateway name, or a name the verifier cannot load now. */
export function gatewayRedirectFor (settings: GatewaySettings | undefined, url: string, serves: (name: string) => boolean = verifierServesName): string | undefined {
  if (settings?.get(SETTING) !== true) return undefined
  const target = ethGatewayTarget(url, isDevEthName)
  if (target === undefined) return undefined
  return serves(new URL(target).hostname) ? target : undefined
}

/** `entries` with each gateway address replaced by the `.eth` one it opens as, for a back and forward list given to a tab whose view was built for the mapped address: such a view may sit in a session no web-request handler covers. */
export function gatewayEntries<T extends { readonly url: string }> (settings: GatewaySettings | undefined, entries: ReadonlyArray<T>, serves: (name: string) => boolean = verifierServesName): T[] {
  return entries.map((entry) => {
    const target = gatewayRedirectFor(settings, entry.url, serves)
    return target === undefined ? entry : { ...entry, url: target }
  })
}

export const installEthGatewayRedirect: ShellInstaller = {
  name: 'eth-gateway-redirect',
  install: (_app, services) => {
    const { settings } = services
    const owner = webRequestOwnerFor(session.defaultSession)
    const handler = handlerWhileNeeded(
      () => settings.get(SETTING) === true,
      () => owner.onBeforeRequest(GATEWAY_ORDER, { urls: GATEWAY_URLS, types: ['mainFrame'] }, isGatewayAddress, (details, current) => {
        if (details.resourceType !== 'mainFrame') return current
        const target = gatewayRedirectFor(settings, details.url)
        return target === undefined ? current : { redirectURL: target }
      })
    )
    handler.sync()
    settings.onChange(() => { handler.sync() })
  }
}
