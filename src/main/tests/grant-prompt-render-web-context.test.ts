import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest } from '../grant-prompt-render.js'
import { manifestWith } from '../../broker/tests/index.test-helpers.js'

// ADR-0019, spec item 6: web.context's own consent copy, split into its own
// sibling file rather than grown onto ./grant-prompt-render.test.ts
// (694/800 lines already) -- the same reason several *-web.test.ts siblings
// exist elsewhere in this stream.

const ORIGIN = 'https://app.example'

describe('describeCapabilityGrant -- web.context (ADR-0019)', () => {
  it('is at the warning level of tcp.listen -- warning: true unconditionally', () => {
    const row = describeCapabilityGrant('web.context', ['https://www.youtube.com'])
    expect(row.warning).toBe(true)
  })

  it('says plainly what the capability does and does not give, per the ADR\'s own wording', () => {
    const row = describeCapabilityGrant('web.context', ['https://www.youtube.com'])
    expect(row.message).toContain('Run code as www.youtube.com')
    expect(row.message).toContain('private, empty session')
    expect(row.explanation).toBe('It cannot see your account or anything you keep there.')
  })

  it('names the bare host, not the full origin string with its scheme', () => {
    const row = describeCapabilityGrant('web.context', ['https://accounts.google.com'])
    expect(row.message).toContain('accounts.google.com')
    expect(row.message).not.toContain('https://')
  })

  it('preserves a non-default port in the displayed host', () => {
    const row = describeCapabilityGrant('web.context', ['https://example.com:8443'])
    expect(row.message).toContain('example.com:8443')
  })

  // NEVER FOLDED INTO A COUNT (spec item 6) -- every origin gets its own
  // line, literally, unlike an ordinary https.connect host list which folds
  // into "first host and N others" past a handful (grant-prompt-connect.ts's
  // own namedHostsSummary).
  it('renders one line per origin, never a count, for more than one granted context origin', () => {
    const row = describeCapabilityGrant('web.context', ['https://a.example', 'https://b.example', 'https://c.example'])
    const lines = row.message.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('a.example')
    expect(lines[1]).toContain('b.example')
    expect(lines[2]).toContain('c.example')
    expect(row.message).not.toMatch(/other/i)
  })

  it('describeGrantRequest -- the one-capability prompt renders web.context the same way, through the same function', () => {
    const manifest = manifestWith({ web: { contexts: ['https://www.youtube.com'] } })
    const content = describeGrantRequest(ORIGIN, manifest, 'web.context', ['https://www.youtube.com'])
    expect(content.warning).toBe(true)
    expect(content.message).toContain('Run code as www.youtube.com')
    expect(content.detail).toContain('It cannot see your account or anything you keep there.')
  })
})
