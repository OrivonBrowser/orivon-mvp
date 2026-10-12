// The resolver for `bzz://` addresses. The address already names the content,
// so resolving one is parsing it: nothing is looked up, and the gatherer
// follows a feed from there.

import { ResolutionError } from '../resolution/records.js'
import type { NameRecord } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { MAX_ADDRESS_NAME } from '../address.js'
import { isEncryptedReference, parseReference, referenceCid } from './reference.js'

function canonical (name: string): string {
  if (isEncryptedReference(name)) throw new ResolutionError('unsupported', `bzz://${name.slice(0, 16)}... is an encrypted reference, which this version of Orivon does not read`)
  // CID parsing is quadratic in the length of what it is given.
  const reference = name.includes('/') || name.length > MAX_ADDRESS_NAME ? undefined : parseReference(name)
  if (reference === undefined) throw new ResolutionError('invalid-name', `bzz://${name} is not a Swarm reference this build can load`)
  return referenceCid(reference)
}

export function createSwarmAddressResolvers (): NameResolver[] {
  return [{
    id: 'bzz-address',
    namespaces: ['bzz:'],
    canonicalName: canonical,
    async resolve (name): Promise<NameRecord[]> {
      const cid = canonical(name)
      // One site, one origin: a reference reached through a second spelling would be a second origin with its own grants.
      if (cid !== name) throw new ResolutionError('invalid-name', `bzz://${name} is not in canonical form (${cid})`)
      return [{ type: 'contenthash', pointer: { kind: 'swarm', cid }, provenance: { via: 'address' } }]
    }
  }]
}
