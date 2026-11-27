import { stringToHex } from 'viem'
import type { Hex } from 'viem'
import { normalize } from 'viem/ens'
import { ResolutionError } from '../resolution/records.js'

export const NAMESPACE = 'og'

/** The longest label: the registry key holds 32 bytes. */
export const MAX_LABEL_BYTES = 32

/** A URL host: already lowercase ASCII, as the URL parser leaves it. */
const ASCII_HOST = /^[\x21-\x7e]+$/

/**
 * The key a label is filed under in the registry, the resolver and the wrapper: its UTF-8 bytes, then zeros.
 * @param label a label that passed `ogLabelFromHost`
 */
export function keyOf (label: string): Hex {
  return `0x${stringToHex(label).slice(2).padEnd(64, '0')}`
}

/**
 * The label of a `.og` host, refused before any request when there is none. A Linagee name is a registry key: the UTF-8 bytes of one
 * label, 32 at most. The registry accepts any bytes, so only a label that ENSIP-15 leaves as it is can be answered: one spelling per
 * name, and none a lookalike can stand in for. The registry has no sub-names, so a host with a label before the name's is refused.
 */
export function ogLabelFromHost (host: string): string {
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (!ASCII_HOST.test(name)) throw new ResolutionError('invalid-name', `${host} is not a URL host`)
  const parts = name.split('.')
  if (parts.pop() !== NAMESPACE) throw new ResolutionError('invalid-name', `${host} is not a .${NAMESPACE} name`)
  const [label, ...deeper] = parts
  if (label === undefined || label === '') throw new ResolutionError('invalid-name', `${host} has no name before .${NAMESPACE}`)
  if (deeper.length > 0) throw new ResolutionError('invalid-name', `${host} is not a .${NAMESPACE} name: Linagee has no sub-names, only ${label}.${NAMESPACE}`)
  if (label.startsWith('xn--')) throw new ResolutionError('invalid-name', `${host} is an internationalised name in punycode form, which this build does not resolve`)
  if (label.length > MAX_LABEL_BYTES) throw new ResolutionError('invalid-name', `${host} is longer than the ${String(MAX_LABEL_BYTES)} bytes a .${NAMESPACE} name holds`)
  let normalised: string
  try {
    normalised = normalize(label)
  } catch (error) {
    throw new ResolutionError('invalid-name', `${host} is not a valid name: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (normalised !== label) throw new ResolutionError('invalid-name', `${host} is not in ENS normal form (${normalised})`)
  return label
}
