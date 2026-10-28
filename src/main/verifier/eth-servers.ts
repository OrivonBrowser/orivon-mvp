// Which Ethereum servers the light client asks: Orivon's, or the ones the person named in Settings. Their servers replace
// Orivon's for the field they fill and are never added to them (ADR-0099). Pure: the values come in, the servers go out.

import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { displayEndpoint, isLocalLiteral, MASK, secretParts } from '../../protocols/verifier-host/light-client/endpoint-mask.js'

/** The three settings, as the store holds them. The store has checked each, so a line is an address. */
export interface EthServerValues {
  readonly choice: 'orivon' | 'custom'
  /** `web3.ethRpcs`: one address a line. */
  readonly rpcs: string
  /** `web3.ethBeacon`: empty, or one address. */
  readonly beacon: string
}

export interface EthServers {
  readonly executionRpcs: readonly string[]
  readonly consensusRpc: string
  /** Of the two above, the ones on this computer or a home network: reached directly, never through a proxy or a tunnel. */
  readonly localEndpoints: readonly string[]
  /** Which field is the person's. A field they left empty stays Orivon's. */
  readonly own: { readonly execution: boolean, readonly consensus: boolean }
}

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '')

export function effectiveEthServers (values: EthServerValues): EthServers {
  const rpcs = values.choice === 'custom' ? lines(values.rpcs) : []
  // The light client and the checkpoint check append their paths to this address, so a trailing slash would double.
  const beacon = values.choice === 'custom' ? values.beacon.trim().replace(/\/+$/, '') : ''
  const executionRpcs = rpcs.length > 0 ? rpcs : DEFAULT_ENDPOINTS.executionRpcs
  const consensusRpc = beacon !== '' ? beacon : DEFAULT_ENDPOINTS.consensusRpc
  const localEndpoints = [...new Set([...executionRpcs, consensusRpc].filter((url) => isLocalLiteral(new URL(url).hostname)))]
  return { executionRpcs, consensusRpc, localEndpoints, own: { execution: rpcs.length > 0, consensus: beacon !== '' } }
}

/** Whether a request would go to the same servers, in the same order: what decides that the host must start again. */
export function sameEthServers (a: EthServers, b: EthServers): boolean {
  return a.consensusRpc === b.consensusRpc && a.executionRpcs.length === b.executionRpcs.length && a.executionRpcs.every((url, index) => url === b.executionRpcs[index])
}

/**
 * Tells `note` every string that would give away a key in the person's addresses, and what shows in its place: the address
 * itself becomes its masked form, any other part becomes `••••`. Orivon's own servers hold none.
 */
export function noteEthSecrets (servers: EthServers, note: (secret: string, shown: string) => void): void {
  const urls = [...(servers.own.execution ? servers.executionRpcs : []), ...(servers.own.consensus ? [servers.consensusRpc] : [])]
  for (const url of urls) {
    for (const part of secretParts(url)) note(part, part === url || part === `${url}/` ? displayEndpoint(url) : MASK)
  }
}

/** The one line the main log gets each time the host starts with the person's servers; undefined while Orivon's are asked. */
export function ethServersLine (servers: EthServers): string | undefined {
  const { own } = servers
  if (!own.execution && !own.consensus) return undefined
  const yours = [
    ...(own.execution ? [servers.executionRpcs.map(displayEndpoint).join(', ')] : []),
    ...(own.consensus ? [`beacon ${displayEndpoint(servers.consensusRpc)}`] : [])
  ].join('; ')
  const orivons = !own.execution ? "; Orivon's Ethereum servers" : !own.consensus ? "; Orivon's beacon server" : ''
  return `light client asks your own servers: ${yours}${orivons}`
}
