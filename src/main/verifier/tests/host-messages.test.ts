import { describe, expect, it } from 'vitest'
import { isFromHost, isHostReplyValue } from '../host-messages.js'

describe('isFromHost name-scheme', () => {
  it.each([
    ['swarm.eth', 'bzz'],
    ['sub.name.eth', 'ipfs']
  ])('accepts %s under %s', (host, scheme) => {
    expect(isFromHost({ type: 'name-scheme', host, scheme })).toBe(true)
  })

  it.each([
    ['not a .eth name', { host: 'example.com', scheme: 'bzz' }],
    ['an address host', { host: 'bafy.bzz.orivon', scheme: 'bzz' }],
    ['a name spelled in capitals', { host: 'Swarm.eth', scheme: 'bzz' }],
    ['a trailing dot', { host: 'swarm.eth.', scheme: 'bzz' }],
    ['a scheme no protocol serves', { host: 'swarm.eth', scheme: 'gopher' }],
    ['a scheme with its separator', { host: 'swarm.eth', scheme: 'bzz://' }],
    ['no scheme', { host: 'swarm.eth' }],
    ['a host that is not a string', { host: 5, scheme: 'bzz' }]
  ])('refuses %s', (_what, fields) => {
    expect(isFromHost({ type: 'name-scheme', ...fields })).toBe(false)
  })
})

describe('isHostReplyValue, for where a site was served from', () => {
  const provenance = { host: 'a.eth', resolver: 'ens', root: { kind: 'ipfs', cid: 'bafy' }, pointers: [], ddoc: { status: 'met', refusals: [] }, mountedAt: 1 }

  it.each([undefined, { kind: 'node' }, { kind: 'gateways' }, { kind: 'gateways', reason: 'a proxy is configured' }])('accepts %j', (servedFrom) => {
    expect(isHostReplyValue('mount', { ...provenance, ...(servedFrom === undefined ? {} : { servedFrom }) })).toBe(true)
  })

  it.each([{ kind: 'elsewhere' }, { kind: 'node', reason: 5 }, 'node', null])('refuses %j', (servedFrom) => {
    expect(isHostReplyValue('mount', { ...provenance, servedFrom })).toBe(false)
  })
})

describe('isFromHost status, for how far the computer\'s clock is behind', () => {
  const synced = { state: 'synced', block: 1, at: 2 }

  it.each([undefined, 0, 90_000])('accepts a lead of %j', (clockLeadMs) => {
    expect(isFromHost({ type: 'status', status: { ...synced, ...(clockLeadMs === undefined ? {} : { clockLeadMs }) } })).toBe(true)
  })

  it.each(['x', -1, Number.NaN, Number.POSITIVE_INFINITY, null])('refuses a lead of %j', (clockLeadMs) => {
    expect(isFromHost({ type: 'status', status: { ...synced, clockLeadMs } })).toBe(false)
  })
})

describe('isFromHost status, for a failure caused by a missing bootstrap', () => {
  const failed = { state: 'failed', reason: 'x', retryAt: 1 }

  it.each([undefined, true])('accepts bootstrapMissing %j', (bootstrapMissing) => {
    expect(isFromHost({ type: 'status', status: { ...failed, ...(bootstrapMissing === undefined ? {} : { bootstrapMissing }) } })).toBe(true)
  })

  it.each([false, 'yes', 1, null])('refuses bootstrapMissing %j', (bootstrapMissing) => {
    expect(isFromHost({ type: 'status', status: { ...failed, bootstrapMissing } })).toBe(false)
  })
})
