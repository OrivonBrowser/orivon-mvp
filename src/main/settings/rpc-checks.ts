// What the settings that name the person's own Ethereum servers must hold: a list of execution servers, one address a line, and
// one beacon server. What an address may be is `server-address.ts`'s, which the Settings page asks too, so the reason it gives
// for a refusal is the store's.
import { serverAddressProblem } from '../../protocols/verifier-host/light-client/server-address.js'

/** Most execution servers the person may list; each is asked in turn when the one before it fails. */
export const MAX_RPCS = 4

/** The address as the network reads it: a spelling, a letter's case or a trailing slash is not another server. */
function sameServer (address: string): string {
  return new URL(address).href
}

/** Empty, or at most `MAX_RPCS` execution server addresses, one a line, none blank and none twice. */
export function isRpcList (value: string): boolean {
  if (value === '') return true
  const lines = value.split('\n')
  if (lines.length > MAX_RPCS || lines.some((line) => serverAddressProblem(line, 'execution') !== undefined)) return false
  return new Set(lines.map(sameServer)).size === lines.length
}

/** Empty, or one beacon server address with no query. */
export function isEmptyOrBeaconUrl (value: string): boolean {
  return value === '' || serverAddressProblem(value, 'beacon') === undefined
}
