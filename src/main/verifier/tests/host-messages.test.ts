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

describe('isFromHost status, for how far the computer\'s clock is behind or ahead', () => {
  const synced = { state: 'synced', block: 1, at: 2 }

  it.each([undefined, 0, 90_000, -90_000])('accepts a lead of %j', (clockLeadMs) => {
    expect(isFromHost({ type: 'status', status: { ...synced, ...(clockLeadMs === undefined ? {} : { clockLeadMs }) } })).toBe(true)
  })

  it.each(['x', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null])('refuses a lead of %j', (clockLeadMs) => {
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

describe('isFromHost status, for a failure that is the person\'s servers\'', () => {
  const failed = { state: 'failed', reason: 'x', retryAt: 1 }

  it.each([undefined, true])('accepts ownServersFailed %j', (ownServersFailed) => {
    expect(isFromHost({ type: 'status', status: { ...failed, ...(ownServersFailed === undefined ? {} : { ownServersFailed }) } })).toBe(true)
  })

  it.each([false, 'yes', 1, null])('refuses ownServersFailed %j', (ownServersFailed) => {
    expect(isFromHost({ type: 'status', status: { ...failed, ownServersFailed } })).toBe(false)
  })
})

describe('isFromHost, for a request the host hands the shell', () => {
  const request = { type: 'relay-request', id: 3, method: 'GET', url: 'https://kept.example/app.js', headers: [['range', 'bytes=0-1']] }

  it('accepts a request, an abort and an acknowledgement', () => {
    expect(isFromHost(request)).toBe(true)
    expect(isFromHost({ type: 'relay-abort', id: 3 })).toBe(true)
    expect(isFromHost({ type: 'relay-wrote', id: 3, bytes: 4096 })).toBe(true)
    expect(isFromHost({ type: 'shell-serves-applied', seq: 2 })).toBe(true)
  })

  it.each([
    ['an id that is not a count', { id: -1 }],
    ['an id that is fractional', { id: 1.5 }],
    ['a method that is not text', { method: 5 }],
    ['a method that is far too long', { method: 'G'.repeat(100) }],
    ['an address that is not text', { url: 7 }],
    ['an address far too long', { url: `https://kept.example/${'a'.repeat(20_000)}` }],
    ['headers that are not a list', { headers: 'range: bytes=0-1' }],
    ['a header that is not a pair', { headers: [['range']] }],
    ['a header value that is not text', { headers: [['range', 1]] }],
    ['a header far too long', { headers: [['x-big', 'a'.repeat(20_000)]] }],
    ['far too many headers', { headers: Array.from({ length: 300 }, (_, index) => [`x-${String(index)}`, 'a']) }]
  ])('refuses a request with %s', (_what, fields) => {
    expect(isFromHost({ ...request, ...fields })).toBe(false)
  })

  it('refuses an acknowledgement of bytes that are not a count', () => {
    expect(isFromHost({ type: 'relay-wrote', id: 3, bytes: -1 })).toBe(false)
    expect(isFromHost({ type: 'relay-wrote', id: 3 })).toBe(false)
    expect(isFromHost({ type: 'relay-abort' })).toBe(false)
    expect(isFromHost({ type: 'shell-serves-applied' })).toBe(false)
    expect(isFromHost({ type: 'shell-serves-applied', seq: -1 })).toBe(false)
    expect(isFromHost({ type: 'shell-serves-applied', seq: '2' })).toBe(false)
  })
})

describe('isFromHost, for a question about the addresses of a name', () => {
  it('accepts a name and a number', () => {
    expect(isFromHost({ type: 'address-lookup', id: 3, host: 'gateway.example' })).toBe(true)
  })

  it.each([
    ['an id that is not a count', { id: -1 }],
    ['an id that is missing', { id: undefined }],
    ['a host that is not text', { host: 5 }],
    ['an empty host', { host: '' }],
    ['a host longer than any name', { host: `${'a'.repeat(254)}` }]
  ])('refuses a question with %s', (_what, fields) => {
    expect(isFromHost({ type: 'address-lookup', id: 3, host: 'gateway.example', ...fields })).toBe(false)
  })
})
