// When the name relay runs: the switch is on, the window is not held to Nym, and a proxy may apply. The table is read per mirror
// mode, with the environment and Chromium's own base answers beside it; an answer that did not come changes nothing.

import { describe, expect, it } from 'vitest'
import type { MirrorStatus } from '../../proxy-mirror/mirror-status.js'
import { activation, environmentNamesProxy } from '../relay-switch.js'
import type { ActivationFacts } from '../relay-switch.js'

const status = (over: Partial<MirrorStatus> = {}): MirrorStatus => ({ source: 'gnome', mode: 'none', state: 'system', reason: 'no-proxy', ...over })
const facts = (over: Partial<ActivationFacts> = {}): ActivationFacts => ({ enabled: true, heldToNym: false, mirror: status(), answers: ['DIRECT', 'DIRECT'], environment: {}, ...over })

describe('a switch that is off, or a window held to Nym', () => {
  it.each(['manual', 'script', 'detect', 'unsupported', 'unreadable'] as const)('never runs the relay, whatever the system says (%s)', (mode) => {
    expect(activation(facts({ enabled: false, mirror: status({ mode }) }))).toBe('off')
    expect(activation(facts({ heldToNym: true, mirror: status({ mode }) }))).toBe('off')
  })
})

describe('a proxy the mirror read', () => {
  it.each([
    ['a manual proxy', 'manual', 'copied', 'mirrored'],
    ['a script', 'script', 'copied', 'mirrored'],
    ['a script that could not be fetched', 'script', 'unfetched', 'system'],
    ['a copy that does not answer as Chromium does', 'manual', 'disagrees', 'system'],
    ['automatic detection', 'detect', 'detect', 'system'],
    ['settings a copy cannot carry', 'unsupported', 'unsupported', 'system'],
    ['settings that could not be read', 'unreadable', 'unreadable', 'system']
  ] as const)('runs the relay for %s, even before the copy is applied and whatever Chromium says', (_name, mode, reason, state) => {
    expect(activation(facts({ mirror: status({ mode, reason, state }), answers: ['DIRECT', 'DIRECT'] }))).toBe('on')
    expect(activation(facts({ mirror: status({ mode, reason, state }), answers: undefined }))).toBe('on')
  })
})

describe('no proxy in the settings', () => {
  it('leaves the relay off while both of Chromium\'s base answers are DIRECT', () => {
    expect(activation(facts())).toBe('off')
  })

  it('runs it when a base answer names a proxy, which is how a proxy the settings did not show is found', () => {
    expect(activation(facts({ answers: ['PROXY 10.0.0.1:3128', 'DIRECT'] }))).toBe('on')
    expect(activation(facts({ answers: ['DIRECT', 'SOCKS5 10.0.0.1:1080'] }))).toBe('on')
  })

  it('keeps what it is doing when an answer did not come and no other says a proxy applies', () => {
    expect(activation(facts({ answers: ['DIRECT', 'unanswered'] }))).toBe('keep')
    expect(activation(facts({ answers: undefined }))).toBe('keep')
  })

  it('runs it when an answer names a proxy beside one that did not come', () => {
    expect(activation(facts({ answers: ['PROXY a:1', 'unanswered'] }))).toBe('on')
  })

  it('keeps what it is doing before the first read, where a reader will come', () => {
    expect(activation(facts({ mirror: status({ mode: 'unknown', reason: 'starting' }), answers: undefined }))).toBe('keep')
  })

  it('is off for a computer whose settings were never read and whose environment names nothing', () => {
    expect(activation(facts({ mirror: status({ source: 'environment', mode: 'unknown', reason: 'no-reader' }), answers: undefined }))).toBe('off')
  })
})

describe('the environment', () => {
  const unread = status({ source: 'environment', mode: 'unknown', reason: 'no-reader' })

  it.each(['http_proxy', 'https_proxy', 'all_proxy', 'auto_proxy', 'SOCKS_SERVER', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'AUTO_PROXY'])('runs the relay when %s is set, where Chromium reads it', (name) => {
    expect(activation(facts({ mirror: unread, answers: undefined, environment: { [name]: name.startsWith('auto') || name.startsWith('AUTO') ? '' : 'http://10.0.0.1:3128' } }))).toBe('on')
    expect(activation(facts({ mirror: status(), environment: { [name]: name.startsWith('auto') || name.startsWith('AUTO') ? '' : 'http://10.0.0.1:3128' } }))).toBe('on')
  })

  it('does not count a variable that is set and empty, except for auto_proxy, which is detection', () => {
    expect(environmentNamesProxy({ http_proxy: '' }, 'environment')).toBe(false)
    expect(environmentNamesProxy({ HTTPS_PROXY: '  ' }, 'environment')).toBe(false)
    expect(environmentNamesProxy({ auto_proxy: '' }, 'environment')).toBe(true)
  })

  it('does not count the variables that Chromium ignores on Windows and macOS', () => {
    expect(environmentNamesProxy({ http_proxy: 'http://10.0.0.1:3128' }, 'windows')).toBe(false)
    expect(environmentNamesProxy({ http_proxy: 'http://10.0.0.1:3128' }, 'macos')).toBe(false)
    expect(activation(facts({ mirror: status({ source: 'windows' }), environment: { http_proxy: 'http://10.0.0.1:3128' } }))).toBe('off')
  })

  it('reads GNOME and KDE as Linux sources', () => {
    expect(environmentNamesProxy({ all_proxy: 'socks5://10.0.0.1:1080' }, 'gnome')).toBe(true)
    expect(environmentNamesProxy({ all_proxy: 'socks5://10.0.0.1:1080' }, 'kde')).toBe(true)
  })
})
