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

  it('describeGrantRequest renders web.embed the same way, through the same function', () => {
    const manifest = manifestWith({ web: { embed: { origins: ['*'] } } })
    const content = describeGrantRequest(ORIGIN, manifest, 'web.embed', ['*'])
    expect(content.warning).toBe(true)
    expect(content.message).toContain('Show any website inside itself')
    expect(content.detail).toContain('see and change everything you do')
  })
})
