import { describe, expect, it } from 'vitest'
import { widensAuthority } from '../update.js'
import type { PatternSet } from '../update.js'

// A REAL BUG, caught and fixed while building ADR-0019: `covers()` (this
// file's own private pattern-subset check, update.ts) was built for two
// shapes only -- `host:port` and a bare port range -- and parses a
// `web.context` origin string through that SAME grammar rather than
// recognising it as a third, unrelated shape. Confirmed by direct trace: an
// origin at the default port (`https://example.com`, the common case, since
// the canonical origin form omits a default port) fails to parse at all and
// `covers()` fails closed (never covered, so `widensAuthority` always
// reports widening) -- while an origin naming a NON-default port
// (`https://example.com:8443`) happens to parse as a nonsensical host:port
// pattern via the grammar's own last-colon split, so whether two identical
// web.context patterns are recognised as equal would have silently depended
// on whether the origin's port happened to be the default one. This file
// pins the fix -- exact string equality, checked first and only for this
// one recognisable shape -- against both cases.
//
// THE BLAST RADIUS THIS BUG HAD, named because it explains why this file
// exists: `widensAuthority` backs BOTH `decideUpdate` (an app update
// declaring a changed `web.contexts` list would always have been read as
// widening, forcing a spurious capability-prompt even for an unchanged
// declaration) AND `../request-grant.js`'s `decideGrantRequest` (a
// persisted web.context grant would never have survived
// `grant-persistence.ts`'s own hydration, and main/grant-changed-
// capabilities.ts's install-consent grant call -- the ONLY door web.context
// is meant to have -- would never have actually granted one at all).

function setFor (origins: readonly string[]): PatternSet {
  return { 'web.context': origins }
}

describe('widensAuthority -- web.context origin patterns (ADR-0019)', () => {
  it('an unchanged single origin at the DEFAULT port is not widening', () => {
    expect(widensAuthority(setFor(['https://example.com']), setFor(['https://example.com']))).toBe(false)
  })

  it('an unchanged single origin at a NON-default port is not widening either', () => {
    expect(widensAuthority(setFor(['https://example.com:8443']), setFor(['https://example.com:8443']))).toBe(false)
  })

  it('a genuinely different origin at the default port IS widening', () => {
    expect(widensAuthority(setFor(['https://example.com']), setFor(['https://evil.example']))).toBe(true)
  })

  it('a genuinely different origin at a non-default port IS widening', () => {
    expect(widensAuthority(setFor(['https://example.com:8443']), setFor(['https://evil.example:8443']))).toBe(true)
  })

  it('a requested origin not present in a wider declared set is widening -- no partial-match grammar applies here', () => {
    expect(widensAuthority(setFor(['https://a.example', 'https://b.example']), setFor(['https://c.example']))).toBe(true)
  })

  it('a requested origin that IS present in the declared set is not widening', () => {
    expect(widensAuthority(setFor(['https://a.example', 'https://b.example']), setFor(['https://b.example']))).toBe(false)
  })

  it('a kind never granted at all is widening, same as every other capability kind', () => {
    expect(widensAuthority({}, setFor(['https://example.com']))).toBe(true)
  })
})
