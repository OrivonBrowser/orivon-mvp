// Test builds only: `.eth` names mapped to content with no light client, so
// the end-to-end suite loads `fixture.eth` without reaching mainnet. The
// host installs it only when the dev-grant build flag is compiled in.

import { ResolutionError } from '../resolution/records.js'
import type { ContentPointer, NameRecord } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { parseReference, referenceCid } from '../swarm/reference.js'

/** `ipfs://<cid>`, `ipns://<key>`, `dnslink://<domain>` or `bzz://<reference>`. */
export function fixturePointer (value: string): ContentPointer | undefined {
  const match = /^(ipfs|ipns|dnslink|bzz):\/\/([^/?#]+)$/.exec(value)
  if (match === null) return undefined
  const [, kind, name] = match as unknown as [string, 'ipfs' | 'ipns' | 'dnslink' | 'bzz', string]
  if (kind === 'ipfs') return { kind: 'ipfs', cid: name }
  if (kind === 'bzz') {
    const reference = parseReference(name)
    return reference === undefined ? undefined : { kind: 'swarm', cid: referenceCid(reference) }
  }
  if (kind === 'ipns') return { kind: 'ipns-key', key: name }
  return { kind: 'dnslink', domain: name }
}

/** Throws on a malformed map: a test that names content it cannot load should fail loudly, not fall through to real resolution. */
export function createFixtureResolver (names: Readonly<Record<string, string>>): NameResolver {
  const records = new Map<string, NameRecord>()
  for (const [name, value] of Object.entries(names)) {
    const pointer = fixturePointer(value)
    if (!name.endsWith('.eth') || pointer === undefined) throw new Error(`fixture name ${name} -> ${value} is not a .eth name mapped to ipfs://, ipns://, dnslink:// or bzz://`)
    records.set(name.toLowerCase(), { type: 'contenthash', pointer, provenance: { via: 'fixture' } })
  }
  return {
    id: 'fixture',
    namespaces: ['.eth'],
    async resolve (name) {
      const record = records.get(name)
      // Not holding a name proves nothing about it, so this must not outrank another resolver's answer.
      if (record === undefined) throw new ResolutionError('unavailable', `${name} is not a fixture name`)
      return [record]
    }
  }
}
