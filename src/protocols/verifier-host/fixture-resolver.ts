// Test builds only: `.eth` and `.og` names mapped to content with no light
// client, so the end-to-end suite loads `fixture.eth` and `fixture.og`
// without reaching mainnet. The host installs it only when the dev-grant
// build flag is compiled in.

import { ResolutionError } from '../resolution/records.js'
import type { ContentPointer, NameRecord } from '../resolution/records.js'
import type { NameResolver, Namespace } from '../resolution/providers.js'
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

/** The top-level domains a fixture name may be under. */
const FIXTURE_NAMESPACES: readonly Namespace[] = ['.eth', '.og']

/**
 * The fixture names under `namespace`. Throws on a malformed map, whichever namespace it is read for: a test that names content
 * it cannot load should fail loudly, not fall through to real resolution.
 */
export function createFixtureResolver (names: Readonly<Record<string, string>>, namespace: Namespace): NameResolver {
  const records = new Map<string, NameRecord>()
  for (const [name, value] of Object.entries(names)) {
    const pointer = fixturePointer(value)
    const under = FIXTURE_NAMESPACES.find((candidate) => name.endsWith(candidate))
    if (under === undefined || pointer === undefined) throw new Error(`fixture name ${name} -> ${value} is not a .eth or .og name mapped to ipfs://, ipns://, dnslink:// or bzz://`)
    if (under === namespace) records.set(name.toLowerCase(), { type: 'contenthash', pointer, provenance: { via: 'fixture' } })
  }
  return {
    id: 'fixture',
    namespaces: [namespace],
    async resolve (name) {
      const record = records.get(name)
      // Not holding a name proves nothing about it, so this must not outrank another resolver's answer.
      if (record === undefined) throw new ResolutionError('unavailable', `${name} is not a fixture name`)
      return [record]
    }
  }
}
