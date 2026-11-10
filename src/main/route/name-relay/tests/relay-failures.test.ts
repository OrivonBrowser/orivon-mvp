// Why the relay did not carry a host and port in the last half minute, which the load-error sheet reads, and the refusal the
// listener answers with.

import { describe, expect, it } from 'vitest'
import { FrontRefusal } from '../../front.js'
import { createRelayFailures, FAILURE_MEMORY_MS, MAX_REMEMBERED, RelayRefusal, refusalSentence } from '../relay-failures.js'
import type { RefusalWord } from '../relay-failures.js'

const WORDS: readonly RefusalWord[] = ['not-found', 'no-answer', 'sign-in', 'refused', 'unreachable', 'inside', 'anonymity', 'unsure']

describe('what is remembered of a failure', () => {
  it('is the last word noted for that host and port', () => {
    const failures = createRelayFailures(() => 0)
    failures.note('shop.example', 443, 'not-found')
    expect(failures.reasonFor('shop.example', 443)).toBe('not-found')
    failures.note('shop.example', 443, 'no-answer')
    expect(failures.reasonFor('shop.example', 443)).toBe('no-answer')
  })

  it('is told apart by port, and reads a name in any case and with the root dot', () => {
    const failures = createRelayFailures(() => 0)
    failures.note('Shop.Example.', 443, 'unreachable')
    expect(failures.reasonFor('shop.example', 443)).toBe('unreachable')
    expect(failures.reasonFor('shop.example', 80)).toBeUndefined()
    expect(failures.reasonFor('other.example', 443)).toBeUndefined()
  })

  it('is forgotten after thirty seconds', () => {
    let now = 1_000
    const failures = createRelayFailures(() => now)
    failures.note('shop.example', 443, 'sign-in')
    now += FAILURE_MEMORY_MS - 1
    expect(failures.reasonFor('shop.example', 443)).toBe('sign-in')
    now += 1
    expect(failures.reasonFor('shop.example', 443)).toBeUndefined()
    expect(FAILURE_MEMORY_MS).toBe(30_000)
  })

  it('starts the half minute again when the host fails again', () => {
    let now = 0
    const failures = createRelayFailures(() => now)
    failures.note('shop.example', 443, 'no-answer')
    now = 20_000
    failures.note('shop.example', 443, 'no-answer')
    now = 45_000
    expect(failures.reasonFor('shop.example', 443)).toBe('no-answer')
  })

  it('keeps a bounded number of hosts, dropping the oldest', () => {
    const failures = createRelayFailures(() => 0)
    for (let i = 0; i <= MAX_REMEMBERED; i += 1) failures.note(`host${String(i)}.example`, 443, 'unreachable')
    expect(failures.reasonFor('host0.example', 443)).toBeUndefined()
    expect(failures.reasonFor('host1.example', 443)).toBe('unreachable')
    expect(failures.reasonFor(`host${String(MAX_REMEMBERED)}.example`, 443)).toBe('unreachable')
  })
})

describe('a refusal', () => {
  it('is a front refusal that carries the word and says it in a sentence', () => {
    const refusal = new RelayRefusal('not-found')
    expect(refusal).toBeInstanceOf(FrontRefusal)
    expect(refusal.word).toBe('not-found')
    expect(refusal.status).toBe(502)
    expect(refusal.reason).toBe(refusalSentence('not-found'))
  })

  it('is a 403 when the relay or the proxy will not carry the host at all, and a 502 when it could not', () => {
    expect(new RelayRefusal('refused').status).toBe(403)
    expect(new RelayRefusal('anonymity').status).toBe(403)
    for (const word of ['not-found', 'no-answer', 'sign-in', 'unreachable', 'inside', 'unsure'] as const) expect(new RelayRefusal(word).status).toBe(502)
    expect(new RelayRefusal('refused', 503, 'busy').status).toBe(503)
    expect(new RelayRefusal('refused', 503, 'busy').reason).toBe('busy')
  })

  it('has a sentence for every word, which names the switch where the person can undo it and the provider where it matters', () => {
    for (const word of WORDS) {
      const sentence = refusalSentence(word, 'Quad9')
      expect(sentence.length, word).toBeGreaterThan(20)
    }
    expect(refusalSentence('not-found', 'Cloudflare')).toContain('Cloudflare')
    expect(refusalSentence('no-answer', 'Cloudflare')).toContain('Cloudflare')
    expect(refusalSentence('no-answer')).toContain('Secure DNS provider')
    for (const word of ['not-found', 'no-answer', 'sign-in', 'anonymity'] as const) expect(refusalSentence(word)).toContain('Look up site addresses in Orivon')
  })
})
