// What `orivon://report` and the log say about the name relay: a few fixed words and counts, never a name, an address or a proxy.

import { describe, expect, it } from 'vitest'
import { createRefusalLog, currentNameRelayStatus, isRefusalWord, nameRelayStatus, providerName, relayReasonFor, setNameRelayStatusSource, setRelayReasonSource, stateLine } from '../relay-status.js'
import type { RelayStatusFacts } from '../relay-status.js'
import { REFUSAL_WORDS } from '../relay-failures.js'
import type { RefusalWord } from '../relay-failures.js'

const NONE = Object.fromEntries(REFUSAL_WORDS.map((word) => [word, 0])) as Record<RefusalWord, number>

const facts = (over: Partial<RelayStatusFacts> = {}): RelayStatusFacts => ({ enabled: true, heldToNym: false, active: true, listening: true, resolverHeld: true, provider: 'quad9', refused: NONE, ...over })

describe('the state', () => {
  it.each<[string, Partial<RelayStatusFacts>, string]>([
    ['off when the switch is off', { enabled: false, active: false, listening: false, resolverHeld: false }, 'off'],
    ['off when the switch is off, even for a window held to Nym', { enabled: false, heldToNym: true, active: false }, 'off'],
    ['held when the switch is on in a window held to Nym', { heldToNym: true, active: false, listening: false }, 'held'],
    ['idle when no proxy applies', { active: false, listening: false, resolverHeld: false }, 'idle'],
    ['relaying when a proxy applies and the listener is up', {}, 'relaying'],
    ['down when a proxy applies and the listener is not up', { listening: false }, 'down']
  ])('is %s', (_name, over, state) => {
    expect(nameRelayStatus(facts(over)).state).toBe(state)
  })
})

describe('the resolver and the provider', () => {
  it('says whether Chromium\'s resolver is held, and which provider the lookups ask', () => {
    expect(nameRelayStatus(facts({ resolverHeld: true, provider: 'cloudflare' }))).toMatchObject({ resolver: 'held', provider: 'cloudflare' })
    expect(nameRelayStatus(facts({ resolverHeld: false, provider: 'quad9' }))).toMatchObject({ resolver: 'setting', provider: 'quad9' })
  })

  it('names the provider in words for a person', () => {
    expect([providerName('quad9'), providerName('cloudflare')]).toEqual(['Quad9', 'Cloudflare'])
  })
})

describe('the counts', () => {
  it('carries each word\'s count, and no other key', () => {
    const status = nameRelayStatus(facts({ refused: { ...NONE, 'not-found': 3, 'sign-in': 1 } }))
    expect(Object.keys(status.refused).sort()).toEqual([...REFUSAL_WORDS].sort())
    expect(status.refused['not-found']).toBe(3)
  })

  it('holds only fixed words and numbers, whatever the facts hold', () => {
    const text = JSON.stringify(nameRelayStatus(facts({ refused: { ...NONE, unreachable: 7 } })))
    expect(text).toBe('{"state":"relaying","provider":"quad9","resolver":"held","refused":{"not-found":0,"no-answer":0,"sign-in":0,"refused":0,"unreachable":7,"inside":0,"anonymity":0,"unsure":0,"unpinned":0}}')
  })
})

describe('the source the report reads', () => {
  it('says the relay is off before anything has started it, and follows the source once one is set', () => {
    setNameRelayStatusSource(undefined)
    expect(currentNameRelayStatus()).toMatchObject({ state: 'off', provider: 'quad9', resolver: 'setting' })
    setNameRelayStatusSource(() => nameRelayStatus(facts()))
    expect(currentNameRelayStatus().state).toBe('relaying')
    setNameRelayStatusSource(undefined)
  })
})

describe('the log', () => {
  it('has one line for a state, with words only', () => {
    expect(stateLine(nameRelayStatus(facts()))).toBe('[route] name relay: relaying (quad9, resolver held)')
    expect(stateLine(nameRelayStatus(facts({ enabled: false, active: false, listening: false, resolverHeld: false })))).toBe('[route] name relay: off')
    expect(stateLine(nameRelayStatus(facts({ listening: false })))).toBe('[route] name relay: down')
  })

  it('has at most one line a minute for each word of a refusal, counting those it left out', () => {
    let now = 0
    const log = createRefusalLog({ now: () => now })
    expect(log('not-found')).toBe('[route] name relay stopped a connection: not-found')
    expect(log('not-found')).toBeUndefined()
    expect(log('not-found')).toBeUndefined()
    expect(log('no-answer')).toBe('[route] name relay stopped a connection: no-answer')
    now += 60_000
    expect(log('not-found')).toBe('[route] name relay stopped a connection: not-found; 2 more since the last line')
  })

  it('never carries more than its words and a count', () => {
    const log = createRefusalLog()
    for (const word of REFUSAL_WORDS) expect(log(word)).toMatch(/^\[route\] name relay stopped a connection: [a-z-]+$/)
  })
})

describe('the reason the sheet reads', () => {
  it('is what the relay noted for the https address\'s host and port, with the default port, a named one and a bracketed address', () => {
    const asked: Array<[string, number]> = []
    setRelayReasonSource((host, port) => { asked.push([host, port]); return 'not-found' })
    expect(relayReasonFor('https://shop.example/a?b=1')).toBe('not-found')
    expect(relayReasonFor('https://shop.example:8443/')).toBe('not-found')
    expect(relayReasonFor('https://[2001:db8::7]/')).toBe('not-found')
    expect(asked).toEqual([['shop.example', 443], ['shop.example', 8443], ['2001:db8::7', 443]])
    setRelayReasonSource(undefined)
  })

  it('is none for an address that is not https, one that does not parse, and a run with no relay', () => {
    setRelayReasonSource(() => 'unreachable')
    expect(relayReasonFor('http://shop.example/')).toBeUndefined()
    expect(relayReasonFor('not an address')).toBeUndefined()
    setRelayReasonSource(undefined)
    expect(relayReasonFor('https://shop.example/')).toBeUndefined()
  })

  it('knows its words', () => {
    for (const word of REFUSAL_WORDS) expect(isRefusalWord(word)).toBe(true)
    expect([isRefusalWord('onion'), isRefusalWord(3), isRefusalWord(undefined)]).toEqual([false, false, false])
  })
})
