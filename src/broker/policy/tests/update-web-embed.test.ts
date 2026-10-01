import { describe, expect, it } from 'vitest'
import { decideGrantRequest } from '../request-grant.js'
import { covers, widensAuthority } from '../update.js'
import type { Manifest } from '../../../contracts/index.js'

const manifestWith = (origins: readonly string[]): Manifest => ({
  orivonApiVersion: 0, id: 'app.test.embed', name: 'embed', version: '1.0.0', entry: 'index.html',
  capabilities: { web: { embed: { origins } } }
}) as Manifest

describe('web.embed patterns in the subset check', () => {
  it.each([
    ['"*"', ['*']],
    ['a local pattern', ['http://*.localhost:9220']],
    ['a local pattern under a name', ['http://*.ipfs.localhost:9220']],
    ['an exact http origin', ['http://127.0.0.1:8080']],
    ['an exact https origin', ['https://example.com']],
    ['"*" beside local patterns', ['*', 'http://*.localhost:9220', 'http://*.bzz.localhost:9220']]
  ])('a manifest declaring %s is not wider than itself', (_name, origins) => {
    expect(widensAuthority({ 'web.embed': origins }, { 'web.embed': origins })).toBe(false)
    expect(decideGrantRequest(manifestWith(origins), 'web.embed', undefined)).toEqual({ allowed: true, patterns: origins })
  })

  it('does not let one local pattern cover another port, another name or an exact origin', () => {
    expect(covers('http://*.localhost:9220', 'http://*.localhost:9221')).toBe(false)
    expect(covers('http://*.localhost:9220', 'http://*.ipfs.localhost:9220')).toBe(false)
    expect(covers('http://*.localhost:9220', 'http://app.localhost:9220')).toBe(false)
  })

  it('does not let "*" cover a local pattern: it reaches public sites only', () => {
    expect(covers('*', 'http://*.localhost:9220')).toBe(false)
    expect(widensAuthority({ 'web.embed': ['*'] }, { 'web.embed': ['*', 'http://*.localhost:9220'] })).toBe(true)
  })
})
