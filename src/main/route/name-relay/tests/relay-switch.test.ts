// What turning the name relay on and off does, and in which order: the listener, the resolver hold, the sessions, the pages' confinement;
// and back. A listener that stops by itself is started again, with the sessions on the dead end meanwhile.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemProxyConfig } from '../../system-follow.js'
import type { MirrorStatus } from '../../proxy-mirror/mirror-status.js'
import type { MirrorPass } from '../../proxy-mirror/proxy-mirror.js'
import { REFUSAL_WORDS } from '../relay-failures.js'
import type { RefusalWord } from '../relay-failures.js'
import { createRelaySwitch } from '../relay-switch.js'
import type { RelayListener, RelaySwitch, RelaySwitchDeps } from '../relay-switch.js'

const NONE = Object.fromEntries(REFUSAL_WORDS.map((word) => [word, 0])) as Record<RefusalWord, number>
const COPIED: MirrorStatus = { source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' }
const PLAIN: MirrorStatus = { source: 'gnome', mode: 'none', state: 'system', reason: 'no-proxy' }
const pass = (status: MirrorStatus, answers: readonly string[] = ['DIRECT', 'DIRECT']): MirrorPass => ({ status, answers })

interface Rig {
  readonly relay: RelaySwitch
  readonly events: string[]
  readonly listeners: Array<RelayListener & { readonly closed: () => void }>
  readonly seenConfig: Array<SystemProxyConfig | undefined>
  readonly lines: string[]
  mirror: MirrorStatus
  mirrorConfig: SystemProxyConfig
  sessionsOk: boolean
  listenFails: number
  readonly finish: Map<number, () => void>
}

function rig (over: Partial<RelaySwitchDeps> = {}): Rig {
  const state: Rig = {
    events: [], listeners: [], seenConfig: [], lines: [], mirror: PLAIN, mirrorConfig: { mode: 'system' }, sessionsOk: true, listenFails: 0, finish: new Map(),
    relay: undefined as never
  }
  const deps: RelaySwitchDeps = {
    environment: {},
    heldToNym: false,
    listen: async (onClosed) => {
      state.events.push('listen')
      if (state.listenFails > 0) { state.listenFails -= 1; throw new Error('EADDRINUSE') }
      const number = state.listeners.length + 1
      const listener = {
        port: 4000 + number,
        username: 'orivon',
        secret: `secret-${String(number)}`,
        // A listener that stops accepting ends when its last connection has, which a test says by `finish`.
        stop: async () => { state.events.push(`stop ${String(4000 + number)}`); await new Promise<void>((resolve) => { state.finish.set(4000 + number, resolve) }) },
        close: async () => { state.events.push(`close ${String(4000 + number)}`) },
        closed: onClosed
      }
      state.listeners.push(listener)
      return listener
    },
    holdResolver: (held) => { state.events.push(held ? 'hold' : 'release') },
    sessionsChanged: async () => { state.events.push('sessions'); state.seenConfig.push(state.relay.link.config()); return state.sessionsOk },
    confine: () => { state.events.push('confine') },
    callers: (on) => { state.events.push(on ? 'callers on' : 'callers off') },
    forgetLookups: async () => { state.events.push('forget') },
    mirrorConfig: () => state.mirrorConfig,
    mirrorStatus: () => state.mirror,
    routedBypass: () => '*.eth;*.orv',
    deadEnd: () => 'http://127.0.0.1:9',
    provider: () => 'quad9',
    refused: () => NONE,
    log: (line) => { state.lines.push(line) },
    restartAfterMs: 1000,
    ...over
  }
  ;(state as { relay: RelaySwitch }).relay = createRelaySwitch(deps)
  return state
}

async function turnOn (r: Rig): Promise<void> {
  r.mirror = COPIED
  r.mirrorConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: 'printer.lan;*.eth;*.orv' }
  r.relay.setEnabled(true)
  r.relay.onPass(pass(COPIED, ['PROXY proxy.test:3128', 'PROXY proxy.test:3128']))
  await r.relay.settled()
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('turning the relay on', () => {
  it('listens, holds Chromium\'s resolver, sets the sessions, then confines their pages, in that order', async () => {
    const r = rig()
    await turnOn(r)
    expect(r.events).toEqual(['listen', 'hold', 'sessions', 'confine', 'callers on'])
  })

  it('has the sessions set to the relay\'s port, with the mirror\'s exceptions while it copied them', async () => {
    const r = rig()
    await turnOn(r)
    expect(r.seenConfig).toEqual([{ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4001', proxyBypassRules: 'printer.lan;*.eth;*.orv' }])
  })

  it('has no exceptions of the system\'s when the mirror holds no copy, and still bypasses the names the verifier serves, with no loopback rule', async () => {
    const r = rig()
    r.mirror = { source: 'gnome', mode: 'script', state: 'system', reason: 'unfetched' }
    r.relay.setEnabled(true)
    r.relay.onPass(pass(r.mirror, ['PROXY a:1', 'DIRECT']))
    await r.relay.settled()
    expect(r.seenConfig).toEqual([{ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4001', proxyBypassRules: '*.eth;*.orv' }])
    expect(JSON.stringify(r.seenConfig)).not.toContain('loopback')
  })

  it('does nothing while the switch is off, whatever the system says', async () => {
    const r = rig()
    r.relay.onPass(pass(COPIED, ['PROXY a:1', 'DIRECT']))
    await r.relay.settled()
    expect(r.events).toEqual([])
    expect(r.relay.link.config()).toBeUndefined()
    expect(r.relay.status().state).toBe('off')
  })

  it('does nothing while no proxy applies, and starts when one does', async () => {
    const r = rig()
    r.relay.setEnabled(true)
    r.relay.onPass(pass(PLAIN))
    await r.relay.settled()
    expect(r.events).toEqual([])
    expect(r.relay.status().state).toBe('idle')
    r.relay.onPass(pass(PLAIN, ['PROXY a:1', 'DIRECT']))
    await r.relay.settled()
    expect(r.events).toEqual(['listen', 'hold', 'sessions', 'confine', 'callers on'])
    expect(r.relay.status().state).toBe('relaying')
  })

  it('starts for a computer whose environment names a proxy and has no reader, with no pass at all', async () => {
    const r = rig({ environment: { https_proxy: 'http://10.0.0.1:3128' } })
    r.mirror = { source: 'environment', mode: 'unknown', state: 'system', reason: 'no-reader' }
    r.relay.setEnabled(true)
    await r.relay.settled()
    expect(r.events).toEqual(['listen', 'hold', 'sessions', 'confine', 'callers on'])
  })

  it('never starts in a window held to Nym', async () => {
    const r = rig({ heldToNym: true })
    r.relay.setEnabled(true)
    r.relay.onPass(pass(COPIED, ['PROXY a:1', 'DIRECT']))
    await r.relay.settled()
    expect(r.events).toEqual([])
    expect(r.relay.status().state).toBe('held')
  })

  it('does not start twice for passes that say the same', async () => {
    const r = rig()
    await turnOn(r)
    r.relay.onPass(pass(COPIED, ['PROXY proxy.test:3128', 'PROXY proxy.test:3128']))
    r.relay.onPass(pass(COPIED, ['PROXY proxy.test:3128', 'PROXY proxy.test:3128']))
    await r.relay.settled()
    expect(r.events.filter((event) => event === 'listen')).toHaveLength(1)
  })

  it('leaves the sessions where they were when the listener cannot start, and tries again', async () => {
    const r = rig()
    r.listenFails = 2
    r.mirror = COPIED
    r.relay.setEnabled(true)
    r.relay.onPass(pass(COPIED))
    await r.relay.settled()
    expect(r.events).toEqual(['listen', 'listen'])
    expect(r.relay.link.config()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    await r.relay.settled()
    expect(r.events).toEqual(['listen', 'listen', 'listen', 'hold', 'sessions', 'confine', 'callers on'])
  })

  it('writes one line for each state it comes to, with words only', async () => {
    const r = rig()
    await turnOn(r)
    expect(r.lines).toEqual(['[route] name relay: relaying (quad9, resolver held)'])
  })
})

describe('turning the relay off', () => {
  it('points the callers that check addresses back at their own lookup, sets the sessions back, then lifts the confinement and the resolver hold, forgets the lookups and stops accepting', async () => {
    const r = rig()
    await turnOn(r)
    r.events.length = 0
    r.seenConfig.length = 0
    r.relay.setEnabled(false)
    await r.relay.settled()
    expect(r.events).toEqual(['callers off', 'sessions', 'confine', 'release', 'forget', 'stop 4001'])
    expect(r.seenConfig).toEqual([undefined])
    expect(r.relay.status().state).toBe('off')
  })

  it('stops when the proxy goes away', async () => {
    const r = rig()
    await turnOn(r)
    r.mirror = PLAIN
    r.relay.onPass(pass(PLAIN))
    await r.relay.settled()
    expect(r.events.slice(-6)).toEqual(['callers off', 'sessions', 'confine', 'release', 'forget', 'stop 4001'])
    expect(r.relay.status().state).toBe('idle')
  })

  it('keeps answering the proxy challenge of the listener that is stopping until it has ended, and never for another port', async () => {
    const r = rig()
    await turnOn(r)
    r.relay.setEnabled(false)
    await r.relay.settled()
    expect(r.relay.link.credentials({ isProxy: true, host: '127.0.0.1', port: 4001 })).toEqual({ username: 'orivon', password: 'secret-1' })
    expect(r.relay.link.credentials({ isProxy: true, host: '127.0.0.1', port: 4002 })).toBeUndefined()
    expect(r.relay.link.config()).toBeUndefined()
    r.finish.get(4001)?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.relay.link.credentials({ isProxy: true, host: '127.0.0.1', port: 4001 })).toBeUndefined()
  })

  it('turns on again after off with a listener of its own', async () => {
    const r = rig()
    await turnOn(r)
    r.relay.setEnabled(false)
    await r.relay.settled()
    r.relay.setEnabled(true)
    await r.relay.settled()
    expect(r.listeners).toHaveLength(2)
    expect(r.relay.link.config()).toMatchObject({ proxyRules: 'http://127.0.0.1:4002' })
  })

  it('sets the sessions again at the next pass when one did not take the change', async () => {
    const r = rig()
    await turnOn(r)
    r.sessionsOk = false
    r.relay.setEnabled(false)
    await r.relay.settled()
    r.events.length = 0
    r.sessionsOk = true
    r.relay.onPass(pass(PLAIN))
    await r.relay.settled()
    expect(r.events).toEqual(['sessions'])
  })
})

describe('a listener that stops by itself', () => {
  it('has the sessions pointed at the dead end, never at the proxy, and answers no challenge, until another listens', async () => {
    const r = rig()
    await turnOn(r)
    r.listenFails = 1
    r.listeners[0]?.closed()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.relay.status().state).toBe('down')
    expect(r.seenConfig.at(-1)).toMatchObject({ proxyRules: 'http://127.0.0.1:9' })
    expect(r.relay.link.credentials({ isProxy: true, host: '127.0.0.1', port: 4001 })).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    await r.relay.settled()
    expect(r.relay.status().state).toBe('relaying')
  })

  it('is started again on a new port and the sessions are set again', async () => {
    const r = rig()
    await turnOn(r)
    r.listeners[0]?.closed()
    await vi.advanceTimersByTimeAsync(0)
    await r.relay.settled()
    expect(r.listeners).toHaveLength(2)
    expect(r.seenConfig.at(-1)).toMatchObject({ proxyRules: 'http://127.0.0.1:4002' })
  })

  it('is tried again after a while when it cannot listen, the sessions staying on the dead end', async () => {
    const r = rig()
    await turnOn(r)
    r.listenFails = 2
    r.listeners[0]?.closed()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.relay.status().state).toBe('down')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.relay.status().state).toBe('down')
    await vi.advanceTimersByTimeAsync(1000)
    await r.relay.settled()
    expect(r.relay.status().state).toBe('relaying')
    expect(r.seenConfig.every((config) => config === undefined || (config.proxyRules ?? '').startsWith('http://127.0.0.1:'))).toBe(true)
  })

  it('is not started again when the relay was turned off meanwhile, nor after dispose', async () => {
    const r = rig()
    await turnOn(r)
    r.relay.setEnabled(false)
    await r.relay.settled()
    r.listeners[0]?.closed()
    await vi.advanceTimersByTimeAsync(5000)
    expect(r.listeners).toHaveLength(1)
  })
})

describe('the proxy challenge', () => {
  it('is answered for the listener\'s port on loopback and nothing else', async () => {
    const r = rig()
    await turnOn(r)
    const { credentials } = r.relay.link
    expect(credentials({ isProxy: true, host: '127.0.0.1', port: 4001 })).toEqual({ username: 'orivon', password: 'secret-1' })
    expect(credentials({ isProxy: false, host: '127.0.0.1', port: 4001 })).toBeUndefined()
    expect(credentials({ isProxy: true, host: 'proxy.test', port: 4001 })).toBeUndefined()
    expect(credentials({ isProxy: true, host: '127.0.0.1', port: 3128 })).toBeUndefined()
  })
})

describe('dispose', () => {
  it('lets the Secure DNS setting apply again and stops every listener', async () => {
    const r = rig()
    await turnOn(r)
    r.events.length = 0
    await r.relay.dispose()
    expect(r.events).toEqual(['callers off', 'release', 'close 4001'])
  })
})
