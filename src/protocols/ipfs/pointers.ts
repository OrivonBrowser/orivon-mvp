// From a contenthash to a root CID, one hop at a time, recording each hop as
// evidence. A signed IPNS record is a verified hop; a DNSLink is not.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { ContentPointer, PointerStep } from '../resolution/records.js'
import { resolveDnslink } from './dnslink.js'
import type { ResolveTxt } from './dnslink.js'
import type { VerifiedIpnsRecord } from './ipns.js'
import { parseContentPath } from './names.js'
import type { PathTarget } from './names.js'
import type { Refusal } from '../resolution/providers.js'

export interface PointerResolvers {
  readonly ipns: (key: string, signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<VerifiedIpnsRecord>
  readonly resolveTxt: ResolveTxt
  readonly maxHops: number
}

function targetOf (pointer: ContentPointer): PathTarget | undefined {
  switch (pointer.kind) {
    case 'ipfs': return parseContentPath(`/ipfs/${pointer.cid}`)
    case 'ipns-key': return parseContentPath(`/ipns/${pointer.key}`)
    case 'dnslink': return parseContentPath(`/ipns/${pointer.domain}`)
    case 'unsupported': return undefined
  }
}

function next (value: string, from: string): PathTarget {
  const target = parseContentPath(value)
  if (target === undefined) throw new ResolutionError('unsupported', `${from} points at ${value}, which this build cannot load`)
  return target
}

/** Throws a ResolutionError. `steps` holds only the hops after the contenthash itself. */
export async function followPointer (pointer: ContentPointer, resolvers: PointerResolvers, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<{ root: CID, steps: PointerStep[] }> {
  let target = targetOf(pointer)
  if (target === undefined) throw new ResolutionError('unsupported', pointer.kind === 'unsupported' ? `${pointer.protocol} content is not supported` : 'malformed contenthash')
  const steps: PointerStep[] = []
  for (let hops = 0; ; hops++) {
    if (target.kind === 'ipfs') return { root: target.cid, steps }
    if (hops >= resolvers.maxHops) throw new ResolutionError('unverifiable', `more than ${String(resolvers.maxHops)} IPNS or DNSLink hops`)
    if (target.kind === 'ipns-key') {
      const record = await resolvers.ipns(target.key, signal, onRefusal)
      steps.push({ step: 'ipns-record', key: record.key, sequence: record.sequence, target: record.value })
      target = next(record.value, `IPNS name ${record.key}`)
    } else {
      const value = await resolveDnslink(target.domain, resolvers.resolveTxt, signal)
      steps.push({ step: 'dnslink', domain: target.domain, target: value })
      target = next(value, `the DNSLink of ${target.domain}`)
    }
  }
}
