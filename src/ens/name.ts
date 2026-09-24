import { normalize } from 'viem/ens'
import { ResolutionError } from '../resolution/records.js'

/** A URL host: already lowercase ASCII, as the URL parser leaves it. */
const ASCII_HOST = /^[\x21-\x7e]+$/

/**
 * The ENS name a `.eth` host stands for, refused before any request when
 * there is none. ENSIP-15 normalisation must leave the host unchanged, so
 * one origin always means one name: a host that normalises to a different
 * name would put two names' content under one origin, or one name's under
 * two.
 */
export function ensNameFromHost (host: string): string {
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (!name.endsWith('.eth') || name === '.eth') throw new ResolutionError('invalid-name', `${host} is not a .eth name`)
  if (!ASCII_HOST.test(name)) throw new ResolutionError('invalid-name', `${host} is not a URL host`)
  // An IDN host reaches here as punycode, and how Chromium's IDNA mapping
  // lines up with ENSIP-15 is not settled, so those names are refused.
  if (name.split('.').some((label) => label.startsWith('xn--'))) {
    throw new ResolutionError('invalid-name', `${host} is an internationalised name, which this build does not resolve`)
  }
  let normalised: string
  try {
    normalised = normalize(name)
  } catch (error) {
    throw new ResolutionError('invalid-name', `${host} is not a valid ENS name: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (normalised !== name) throw new ResolutionError('invalid-name', `${host} is not in ENS normal form (${normalised})`)
  return name
}
