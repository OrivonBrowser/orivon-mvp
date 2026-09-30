import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest } from '../grant-prompt-render.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// ADR-0039: web.embed's own consent copy, in its own sibling file for the
// same reason grant-prompt-render-web-context.test.ts is.

const ORIGIN = 'https://app.example'

describe('describeCapabilityGrant -- web.embed (ADR-0039)', () => {
  it('is at the warning level, whatever the origins', () => {
    expect(describeCapabilityGrant('web.embed', ['*']).warning).toBe(true)
    expect(describeCapabilityGrant('web.embed', ['https://example.com']).warning).toBe(true)
  })

  it('says "any website" for "*", and that the app reads and changes those pages', () => {
    const row = describeCapabilityGrant('web.embed', ['*'])
    expect(row.message).toContain('Show any website inside itself')
    expect(row.message).toContain('read and change what those pages show')
    expect(row.explanation).toContain('see and change everything you do')
    expect(row.explanation).toContain('kept apart from your ordinary browsing')
  })

  it('names the hosts for exact origins, without their scheme, keeping a non-default port', () => {
    const row = describeCapabilityGrant('web.embed', ['https://example.com', 'http://other.example:8080'])
    expect(row.message).toContain('example.com, other.example:8080')
    expect(row.message).not.toContain('https://')
    expect(row.message).toContain('read and change what they show')
  })

  // Dozens of embed origins are capped the same way every other per-item row
  // list in this file is (decision 10), folding the rest into a trailing
  // "and N more" count rather than joining onto one unbounded line.
  it('caps a long list of embed hosts, folding the rest into a count', () => {
    const origins = Array.from({ length: 60 }, (_, i) => `https://site-${String(i)}.example`)
    const row = describeCapabilityGrant('web.embed', origins)
    expect(row.message).toContain('site-0.example')
    expect(row.message).toMatch(/and 40 more/)
  })

  it('describeGrantRequest renders web.embed the same way, through the same function', () => {
    const manifest = manifestWith({ web: { embed: { origins: ['*'] } } })
    const content = describeGrantRequest(ORIGIN, manifest, 'web.embed', ['*'])
    expect(content.warning).toBe(true)
    expect(content.message).toContain('Show any website inside itself')
    expect(content.detail).toContain('see and change everything you do')
  })
})

// ADR-0047: the local pattern and "*" listed beside other entries. The prompt
// names each kind of reach the list holds: "*" beside an exact origin or a
// local pattern is shown with those entries, never as "*" alone.
describe('describeCapabilityGrant -- web.embed with a local pattern (ADR-0047)', () => {
  it('says the app shows pages it serves itself from this computer, with the port', () => {
    const row = describeCapabilityGrant('web.embed', ['http://*.localhost:8123'])
    expect(row.message).toContain('Show pages it serves itself from this computer (port 8123) inside itself')
    expect(row.message).toContain('read and change what those pages show')
    expect(row.warning).toBe(true)
  })

  it('names the port of the named form too, and says the pages come from a server the app itself runs', () => {
    const row = describeCapabilityGrant('web.embed', ['http://*.gateway.localhost:8124'])
    expect(row.message).toContain('(port 8124)')
    expect(row.explanation).toContain('server the app itself runs on this computer')
  })

  it('lists every distinct port once, in order', () => {
    const row = describeCapabilityGrant('web.embed', ['http://*.localhost:8123', 'http://*.a.localhost:8124', 'http://*.b.localhost:8123'])
    expect(row.message).toContain('(ports 8123, 8124)')
  })

  it('says both things for "*" beside a local pattern, and keeps the ordinary explanation', () => {
    const row = describeCapabilityGrant('web.embed', ['*', 'http://*.localhost:8123'])
    expect(row.message).toContain('any website')
    expect(row.message).toContain('pages it serves itself from this computer (port 8123)')
    expect(row.message).toContain('read and change what those pages show')
    expect(row.explanation).toContain('kept apart from your ordinary browsing')
    expect(row.warning).toBe(true)
  })

  it('names the exact hosts too for "*" beside an exact origin, rather than saying only "any website"', () => {
    const row = describeCapabilityGrant('web.embed', ['*', 'http://192.168.1.5:8080'])
    expect(row.message).toContain('any website')
    expect(row.message).toContain('pages from 192.168.1.5:8080')
  })

  it('says all three for a list holding every kind', () => {
    const row = describeCapabilityGrant('web.embed', ['*', 'http://192.168.1.5:8080', 'http://*.localhost:8123'])
    expect(row.message).toContain('any website')
    expect(row.message).toContain('pages from 192.168.1.5:8080')
    expect(row.message).toContain('pages it serves itself from this computer (port 8123)')
  })

  it('leaves the pure "*" and pure exact wording as they were', () => {
    expect(describeCapabilityGrant('web.embed', ['*']).message).toContain('Show any website inside itself, and read and change what those pages show')
    expect(describeCapabilityGrant('web.embed', ['https://example.com']).message).toContain('read and change what they show')
  })
})

