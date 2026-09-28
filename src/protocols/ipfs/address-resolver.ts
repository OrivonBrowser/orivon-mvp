// The resolvers for `ipfs://` and `ipns://` addresses. The address already
// names the content, so resolving one is parsing it: nothing is looked up,
// and the gatherer follows an IPNS key or DNSLink name from there.

import { ResolutionError } from '../resolution/records.js'
import type { ContentPointer, NameRecord } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { parseContentPath } from './names.js'
import type { PathTarget } from './names.js'

type AddressScheme = 'ipfs' | 'ipns'

function targetOf (scheme: AddressScheme, name: string): PathTarget {
  const target = name.includes('/') ? undefined : parseContentPath(`/${scheme}/${name}`)
  if (target === undefined) throw new ResolutionError('invalid-name', `${scheme}://${name} is not ${scheme === 'ipfs' ? 'a CID' : 'an IPNS key or DNSLink name'} this build can load`)
  return target
}

function spelling (target: PathTarget): string {
  switch (target.kind) {
    case 'ipfs': return target.cid.toString()
    case 'ipns-key': return target.key
    case 'dnslink': return target.domain
  }
}

function pointerOf (target: PathTarget): ContentPointer {
  switch (target.kind) {
    case 'ipfs': return { kind: 'ipfs', cid: target.cid.toString() }
    case 'ipns-key': return { kind: 'ipns-key', key: target.key }
    case 'dnslink': return { kind: 'dnslink', domain: target.domain }
  }
}

function addressResolver (scheme: AddressScheme): NameResolver {
  return {
    id: `${scheme}-address`,
    namespaces: [`${scheme}:`],
    canonicalName: (name) => spelling(targetOf(scheme, name)),
    async resolve (name): Promise<NameRecord[]> {
      const target = targetOf(scheme, name)
      // One site, one origin: a CID reached through a second spelling would be a second origin with its own grants.
      if (spelling(target) !== name) throw new ResolutionError('invalid-name', `${scheme}://${name} is not in canonical form (${spelling(target)})`)
      return [{ type: 'contenthash', pointer: pointerOf(target), provenance: { via: 'address' } }]
    }
  }
}

export function createIpfsAddressResolvers (): NameResolver[] {
  return [addressResolver('ipfs'), addressResolver('ipns')]
}
