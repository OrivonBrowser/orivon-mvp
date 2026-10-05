// Which addresses open as a `.eth` name, and which `.eth` address: the rule
// the web-request handler (./eth-gateway-redirect.ts) and every tab hook share.
// Durable: no `electron`, so session restore may use it.
import { ethGatewayTarget } from '../browsing/eth-gateway.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { verifierServesName } from '../verifier/verifier-access.js'

/** The setting that turns the redirect on. */
export const ETH_GATEWAY_SETTING = 'web3.ethGatewayRedirect'

export interface GatewaySettings {
  get: (key: typeof ETH_GATEWAY_SETTING) => boolean
}

/** The `.eth` address `url` opens as, or undefined when it opens as it is: no settings yet, the setting off, not a gateway name, or a name the verifier cannot load now. */
export function gatewayRedirectFor (settings: GatewaySettings | undefined, url: string, serves: (name: string) => boolean = verifierServesName): string | undefined {
  if (settings?.get(ETH_GATEWAY_SETTING) !== true) return undefined
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
