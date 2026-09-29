// Runtime shape checks for everything the verifier host posts to main over
// the utility process's parent port. The host runs every untrusted parser
// this app has (the light client's WebAssembly, CCIP-Read answers, IPNS
// protobuf, dag-pb, DNS-over-HTTPS JSON), so a bug in one of them must not
// let a malformed or hostile message be treated as a trusted `FromHost` --
// or a 'reply's `value` as the `SiteProvenance`/`LightClientState` its
// request's kind promises -- merely because `protocol.ts` says it is one.

import { BLOCK_ROOT_PATTERN } from '../../protocols/verifier-host/protocol.js'
import type { FromHost, HostReplies, HostRequest, LightClientState, SiteProvenance } from '../../protocols/verifier-host/protocol.js'
import type { ContentPointer, ContentRoot, PointerStep, Provenance } from '../../protocols/resolution/records.js'
import type { DdocReport, Refusal } from '../../protocols/resolution/providers.js'
import { DECIMAL } from './verifier-store.js'

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDecimal (value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value)
}

function isReadonlyArray<T> (value: unknown, item: (v: unknown) => v is T): value is readonly T[] {
  return Array.isArray(value) && value.every(item)
}

function isContentPointer (value: unknown): value is ContentPointer {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'ipfs': return typeof value['cid'] === 'string'
    case 'ipns-key': return typeof value['key'] === 'string'
    case 'dnslink': return typeof value['domain'] === 'string'
    case 'unsupported': return typeof value['protocol'] === 'string'
    default: return false
  }
}

function isProvenance (value: unknown): value is Provenance {
  if (!isRecord(value)) return false
  switch (value.via) {
    case 'chain': return typeof value['block'] === 'number' && typeof value['offchain'] === 'boolean'
    case 'dns': return typeof value['domain'] === 'string'
    case 'address': return true
    case 'fixture': return true
    default: return false
  }
}

function isContentRoot (value: unknown): value is ContentRoot {
  return isRecord(value) && value.kind === 'ipfs' && typeof value['cid'] === 'string'
}

function isPointerStep (value: unknown): value is PointerStep {
  if (!isRecord(value)) return false
  switch (value.step) {
    case 'contenthash': return typeof value['name'] === 'string' && isContentPointer(value['pointer']) && isProvenance(value['provenance'])
    case 'ipns-record': return typeof value['key'] === 'string' && typeof value['sequence'] === 'bigint' && typeof value['target'] === 'string'
    case 'dnslink': return typeof value['domain'] === 'string' && typeof value['target'] === 'string'
    default: return false
  }
}

function isRefusal (value: unknown): value is Refusal {
  return isRecord(value) && typeof value['source'] === 'string' && typeof value['resource'] === 'string'
}

function isDdocReport (value: unknown): value is DdocReport {
  if (!isRecord(value) || !isReadonlyArray(value['refusals'], isRefusal)) return false
  if (value.status === 'met') return true
  if (value.status === 'failed') return typeof value['resource'] === 'string'
  return false
}

function isSiteProvenance (value: unknown): value is SiteProvenance {
  return isRecord(value) &&
    typeof value['host'] === 'string' &&
    typeof value['resolver'] === 'string' &&
    isContentRoot(value['root']) &&
    isReadonlyArray(value['pointers'], isPointerStep) &&
    isDdocReport(value['ddoc']) &&
    typeof value['mountedAt'] === 'number'
}

function isLightClientState (value: unknown): value is LightClientState {
  if (!isRecord(value)) return false
  switch (value.state) {
    case 'off': return true
    case 'starting': return true
    case 'syncing': return typeof value['since'] === 'number'
    case 'synced': return typeof value['block'] === 'number' && typeof value['at'] === 'number'
    case 'failed': return typeof value['reason'] === 'string' && (value['retryAt'] === undefined || typeof value['retryAt'] === 'number')
    default: return false
  }
}

/**
 * Whether `value` is the reply shape `kind`'s own request promises --
 * checked against the SAME kind the pending request was actually made
 * with, never merely "some known reply shape a different request expects".
 */
export function isHostReplyValue<K extends HostRequest['kind']> (kind: K, value: unknown): value is HostReplies[K] {
  switch (kind) {
    case 'provenance': return value === null || isSiteProvenance(value)
    case 'mount': return isSiteProvenance(value)
    case 'status': return isLightClientState(value)
    default: return false
  }
}

/**
 * Whether `message` is one of the shapes the verifier host may ever post.
 * A 'reply's own `value` is not this function's job: it is opaque here (the
 * host does not know what kind of request it is answering once the id
 * alone crosses back), and is checked once the supervisor looks up that
 * request's kind (`isHostReplyValue`).
 */
export function isFromHost (message: unknown): message is FromHost {
  if (!isRecord(message)) return false
  switch (message.type) {
    case 'listening': return typeof message['fingerprint'] === 'string'
    case 'failed': return (message['stage'] === 'start' || message['stage'] === 'listen') && typeof message['message'] === 'string'
    case 'status': return isLightClientState(message['status'])
    case 'checkpoint': return typeof message['root'] === 'string' && BLOCK_ROOT_PATTERN.test(message['root']) && typeof message['timestamp'] === 'number'
    case 'ipns-sequence': return typeof message['key'] === 'string' && isDecimal(message['sequence'])
    case 'reply':
      if (typeof message['id'] !== 'number') return false
      if (message['ok'] === true) return 'value' in message
      if (message['ok'] === false) return typeof message['message'] === 'string'
      return false
    default: return false
  }
}
