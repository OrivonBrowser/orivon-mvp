// The addresses the copy is checked with are ordinary ones: Chromium's own answer comes from a session on the system's config,
// which would hand a name the verifier serves to any script the system names.

import { describe, expect, it } from 'vitest'
import { namesVerifierHost } from '../../verifier-name-guard.js'
import { BASE_CANARIES, exceptionCanaries } from '../canaries.js'

describe('the addresses the copy is checked with', () => {
  it('are two ordinary sites and up to three the exceptions cover', () => {
    expect(BASE_CANARIES).toEqual(['https://example.com/', 'http://example.com/'])
    expect(exceptionCanaries(['localhost', '*.corp.test', '.lan.test', 'intranet.test', '10.1.2.3', '10.4.0.0/16', 'extra.test'])).toEqual(['https://probe.corp.test/', 'https://probe.lan.test/', 'https://intranet.test/'])
  })

  it('never name a host the verifier serves, whatever way an exception covers it, so no routed name is put to Chromium\'s own session', () => {
    const covering = ['*.eth', '.eth', '*.eth.', '*eth', 'name.eth', '*.ipfs.orivon', 'ipfs.orivon', '.orivon', '*.orivon.', 'x.bzz.orivon']
    expect(exceptionCanaries(covering)).toEqual([])
    for (const exception of covering) expect(exceptionCanaries([exception]), exception).toEqual([])
  })

  it('keep an ordinary exception that sits beside one for a routed suffix, and count only the ordinary ones towards the most', () => {
    expect(exceptionCanaries(['*.eth', '*.a.test', '.eth', '*.b.test', 'c.test', 'd.test'])).toEqual(['https://probe.a.test/', 'https://probe.b.test/', 'https://c.test/'])
  })

  it('never hold a name the verifier serves, among any made from exceptions of every shape', () => {
    const shapes = ['*.eth', '.eth.', '*.corp.test', 'eth.example', 'ethereum.test', '*.eth.example.com', 'notorivon', '*.notorivon']
    for (const url of [...BASE_CANARIES, ...exceptionCanaries(shapes)]) expect(namesVerifierHost(url), url).toBe(false)
  })
})
