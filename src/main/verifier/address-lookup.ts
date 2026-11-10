// Main's answer when the verifier host asks for the addresses of a name as the name relay finds them (to judge a CCIP-Read
// gateway before it reads it): the relay's lookup while the relay runs, and `none` while it does not, so the host looks the name up
// as it always did. A name the relay could not look up is `refused`: nothing here asks this computer. Neither the name nor an
// address is logged.

import { MAX_ANSWERED_ADDRESSES } from '../../protocols/verifier-host/protocol.js'
import type { AddressAnswer } from '../../protocols/verifier-host/protocol.js'
import type { RelayHostLookup } from '../route/name-relay/relay-lookup.js'

/** The answer to `address-lookup` `id` for `host`. A CCIP-Read request is `https:` on port 443 only, so that is the URL the system is asked about. */
export async function answerAddressLookup (lookup: RelayHostLookup | undefined, id: number, host: string): Promise<AddressAnswer> {
  if (lookup === undefined) return { type: 'address-answer', id, kind: 'none' }
  try {
    const addresses = await lookup(host, `https://${host}/`)
    return addresses.length === 0 || addresses.length > MAX_ANSWERED_ADDRESSES ? { type: 'address-answer', id, kind: 'refused' } : { type: 'address-answer', id, kind: 'addresses', addresses: [...addresses] }
  } catch {
    return { type: 'address-answer', id, kind: 'refused' }
  }
}
