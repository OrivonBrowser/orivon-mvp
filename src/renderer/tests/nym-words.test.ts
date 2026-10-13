import { describe, expect, it } from 'vitest'
import { nymReason, nymRouteLine, nymStatusWords, nymTestWords } from '../nym-words.js'
import { routeLineWords } from '../site-info/route-line.js'

describe('the words about Nym', () => {
  it('says what Nym is doing in the words the person reads', () => {
    expect(nymStatusWords({ state: 'connecting' })).toBe('Connecting to Nym…')
    expect(nymStatusWords({ state: 'ready' })).toBe('Nym tunnel ready')
    expect(nymStatusWords({ state: 'failed', reason: 'no gateway' })).toBe('Nym is not answering')
    expect(nymStatusWords({ state: 'unavailable', cause: 'not-in-build', reason: 'x' })).toBe('Nym is not in this build')
    expect(nymStatusWords({ state: 'unavailable', cause: 'proxy', reason: 'x' })).toContain('proxy')
    expect(nymStatusWords({ state: 'off' })).toMatch(/starts/i)
  })

  it('gives the reason only for a state that has one', () => {
    expect(nymReason({ state: 'failed', reason: 'no gateway' })).toBe('no gateway')
    expect(nymReason({ state: 'ready' })).toBeUndefined()
  })

  it('says how long a test took, and why one could not run', () => {
    expect(nymTestWords({ ok: true, ms: 4250 })).toContain('4.3 s')
    expect(nymTestWords({ ok: false, reason: 'unavailable', detail: 'not in this build' })).toContain('not in this build')
    expect(nymTestWords({ ok: false, reason: 'silent', detail: '' })).toContain('did not answer')
    expect(nymTestWords({ ok: false, reason: 'failed', detail: '' })).toContain('did not work')
  })

  it('tells the popover where an app on Nym stands', () => {
    expect(nymRouteLine('ok', { state: 'ready' })).toBe('This app\'s traffic goes through Nym. Nym tunnel ready')
    expect(nymRouteLine('idle', { state: 'idle' })).toBe('This app\'s traffic goes through Nym.')
    expect(nymRouteLine('down', { state: 'failed', reason: 'x' })).toBe('Nym is not answering, so this app\'s traffic is stopped.')
    expect(nymRouteLine('ok', { state: 'unavailable', cause: 'not-in-build', reason: 'x' })).toBe('Nym is not in this build, so this app\'s traffic is stopped.')
    expect(routeLineWords('ok', { state: 'connecting' })).toContain('Connecting to Nym…')
    expect(routeLineWords('ok')).toBe('This app\'s traffic goes through your tunnel.')
  })
})
