import { describe, expect, it } from 'vitest'
import { GATEWAY_CORS_HEADERS, MAX_MAPPED_REQUESTS, MappedRequests, mapsResourceType, withGatewayCors } from '../eth-gateway-embedded.js'

describe('mapsResourceType', () => {
  it('maps a page and everything a page loads, but no socket, ping or report', () => {
    for (const type of ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'media', 'other']) expect(mapsResourceType(type), type).toBe(true)
    for (const type of ['webSocket', 'ping', 'cspReport', 'unheard-of']) expect(mapsResourceType(type), type).toBe(false)
  })
})

describe('withGatewayCors', () => {
  it('gives a response the headers the gateway gives every response', () => {
    const out = withGatewayCors({ 'content-type': ['text/plain'] })
    expect(out['content-type']).toEqual(['text/plain'])
    expect(out['access-control-allow-origin']).toEqual(['*'])
    expect(out['access-control-allow-methods']).toEqual(['GET, HEAD, OPTIONS, POST'])
    expect(out['access-control-allow-headers']).toEqual(['Content-Type,Range,User-Agent,X-Requested-With'])
    expect(out['access-control-expose-headers']).toEqual(['Content-Length,Content-Range,X-Chunked-Output,X-Ipfs-Path,X-Ipfs-Roots,X-Stream-Output'])
    expect(out['access-control-allow-credentials']).toEqual(['false'])
  })

  it('replaces a header of the same name in any case, and does not change its input', () => {
    const input = { 'Access-Control-Allow-Origin': ['https://other.example'], 'Access-Control-Allow-Credentials': ['true'], etag: ['"a"'] }
    const out = withGatewayCors(input)
    expect(Object.keys(out).filter((name) => name.toLowerCase() === 'access-control-allow-origin')).toEqual(['access-control-allow-origin'])
    expect(out['access-control-allow-origin']).toEqual(['*'])
    expect(out['access-control-allow-credentials']).toEqual(['false'])
    expect(out['etag']).toEqual(['"a"'])
    expect(input['Access-Control-Allow-Origin']).toEqual(['https://other.example'])
  })

  it('lists exactly five headers', () => {
    expect(Object.keys(GATEWAY_CORS_HEADERS)).toHaveLength(5)
  })
})

describe('MappedRequests', () => {
  it('remembers a request id until it is forgotten', () => {
    const mapped = new MappedRequests()
    expect(mapped.has(7)).toBe(false)
    mapped.add(7)
    expect(mapped.has(7)).toBe(true)
    mapped.forget(7)
    expect(mapped.has(7)).toBe(false)
  })

  it('keeps the newest ids when it is full, so a flood of requests cannot grow it', () => {
    const mapped = new MappedRequests()
    for (let id = 1; id <= MAX_MAPPED_REQUESTS + 5; id += 1) mapped.add(id)
    expect(mapped.has(1)).toBe(false)
    expect(mapped.has(5)).toBe(false)
    expect(mapped.has(6)).toBe(true)
    expect(mapped.has(MAX_MAPPED_REQUESTS + 5)).toBe(true)
    expect(mapped.size).toBe(MAX_MAPPED_REQUESTS)
  })

  it('counts an id added twice once', () => {
    const mapped = new MappedRequests()
    mapped.add(3)
    mapped.add(3)
    expect(mapped.size).toBe(1)
  })
})
