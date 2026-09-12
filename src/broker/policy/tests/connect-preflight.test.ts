// Owner decision d-I (docs/open-questions.md A130): the two authorisation
// pipelines were unified, and the condition was proving every denial reason
// still fires on BOTH paths.
//
// That is what this file is. Every shared reason is asserted through
// checkConnect AND checkConnectSecure from one table, so a reason that stops
// firing on one path fails here rather than being noticed after a CRITICAL --
// which is exactly how A82 was found: the reserved-port carve-out was fixed on
// the plain path and the TLS path kept the hole while the fix looked complete.
import { describe, expect, it } from 'vitest'
import { checkConnect } from '../connect.js'
import { checkConnectSecure } from '../connect-secure.js'
import { MAX_PATTERNS, preflightConnect } from '../connect-preflight.js'
import type { Pattern } from '../../../contracts/index.js'

/** Never reached by any case below: every one is refused before resolution. A resolver that throws proves that rather than assuming it. */
const noResolve = async (): Promise<readonly string[]> => {
  throw new Error('the preflight let a denied request reach the resolver')
}

interface Case {
  readonly reason: string
  readonly patterns: readonly Pattern[]
  readonly host: string
  readonly port: number
}

const SHARED: readonly Case[] = [
  { reason: 'not-declared', patterns: [], host: 'a.example', port: 443 },
  { reason: 'too-many-patterns', patterns: Array.from({ length: MAX_PATTERNS + 1 }, () => 'a.example:443' as Pattern), host: 'a.example', port: 443 },
  { reason: 'bad-port', patterns: ['a.example:443'], host: 'a.example', port: 0 },
  { reason: 'bad-host', patterns: ['a.example:443'], host: '', port: 443 },
  { reason: 'non-canonical-host', patterns: ['*:443'], host: '2130706433', port: 443 },
  { reason: 'reserved-port', patterns: ['*:*'], host: 'mail.example', port: 25 }
]

describe('every shared denial reason fires on BOTH pipelines (A130, owner decision d-I)', () => {
  for (const c of SHARED) {
    it(`${c.reason} -- plain connect`, async () => {
      const decision = await checkConnect(c.patterns, c.host, c.port, noResolve)
      expect(decision.allowed).toBe(false)
      expect(decision.allowed === false && decision.reason).toBe(c.reason)
    })

    it(`${c.reason} -- TLS connect`, () => {
      const decision = checkConnectSecure(c.patterns, c.host, c.port)
      expect(decision.allowed).toBe(false)
      expect(decision.allowed === false && decision.reason).toBe(c.reason)
    })

    it(`${c.reason} -- and the shared preflight agrees, so neither path is deciding it alone`, () => {
      const pre = preflightConnect(c.patterns, c.host, c.port)
      expect(pre.ok).toBe(false)
      expect(pre.ok === false && pre.reason).toBe(c.reason)
    })
  }
})

describe('A82 regression: the reserved-port carve-out cannot be crossed on EITHER path', () => {
  // The measured CRITICAL: a grant naming a reserved port for ONE host, paired
  // with a broad pattern, reached an UNRELATED host on that port -- because
  // "some pattern named the port" and "some pattern authorises this host" were
  // answered against different patterns.
  const CROSS: readonly Pattern[] = ['mail.example.com:25', '*:*']
  // A genuinely PUBLIC address. 203.0.113.0/24 (TEST-NET-3) is the
  // documentation range and address.ts denies it outright -- using it here
  // would have made the refusal below pass for the wrong reason, proving
  // nothing about the reserved-port logic. Caught by the positive case failing.
  const PUBLIC = '93.184.216.34'

  it('plain connect refuses the unrelated host on the named reserved port', async () => {
    const decision = await checkConnect(CROSS, 'attacker.example.net', 25, async () => [PUBLIC])
    expect(decision.allowed).toBe(false)
  })

  it('TLS connect refuses it too -- the path that kept the hole after the first fix', () => {
    expect(checkConnectSecure(CROSS, 'attacker.example.net', 25).allowed).toBe(false)
  })

  it('and the host that WAS named still works on both, so the fix is not just a blanket refusal', async () => {
    const plain = await checkConnect(CROSS, 'mail.example.com', 25, async () => [PUBLIC])
    expect(plain.allowed).toBe(true)
    expect(checkConnectSecure(CROSS, 'mail.example.com', 25).allowed).toBe(true)
  })
})

describe('the ordering contract the unification had to settle', () => {
  // The two pipelines disagreed: checkConnect reported reserved-port for an
  // input that tripped BOTH, checkConnectSecure reported non-canonical-host.
  // One order now -- request validation before anything grant-dependent, so a
  // caller learns nothing about a grant from a request that was never valid.
  it('a non-canonical literal on a reserved port reports the INPUT problem, identically on both', async () => {
    const patterns: readonly Pattern[] = ['*:*']
    const plain = await checkConnect(patterns, '2130706433', 25, noResolve)
    const tls = checkConnectSecure(patterns, '2130706433', 25)
    expect(plain.allowed === false && plain.reason).toBe('non-canonical-host')
    expect(tls.allowed === false && tls.reason).toBe('non-canonical-host')
  })
})
