// What a session that follows the system is set to: the system's own config sets nothing, a config supplied later is set once
// per session, a session that may not be touched is left alone (read inside its turn), and a failed set is tried again.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSystemFollow } from '../system-follow.js'
import type { SystemProxyConfig } from '../system-follow.js'

const MIRRORED: SystemProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: '*.eth' }
const OTHER: SystemProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:8080', proxyBypassRules: '*.eth' }

interface Fake { readonly name: string }
const fake = (name: string): Fake => ({ name })

function setup (options: { kept?: (session: Fake) => boolean, failing?: Set<Fake> } = {}) {
  let config: SystemProxyConfig | undefined
  const sets: string[] = []
  const kept = new Set<Fake>()
  const follow = createSystemFollow<Fake>({
    config: () => config ?? { mode: 'system' },
    set: async (session, next) => {
      if (options.failing?.has(session) === true) throw new Error('no')
      sets.push(`${session.name}:${next.mode ?? ''}:${next.proxyRules ?? ''}`)
    },
    kept: (session) => kept.has(session) || options.kept?.(session) === true,
    inTurn: async (_session, work) => { await work() }
  })
  return { follow, sets, kept, change: (next: SystemProxyConfig | undefined): void => { config = next } }
}

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }

afterEach(() => { vi.restoreAllMocks() })

describe('the system\'s own config', () => {
  it('sets nothing for a session that was made, however often the sessions are asked about', async () => {
    const { follow, sets } = setup()
    const one = fake('one')
    follow.adopted(one)
    await flush()
    await follow.changed([one, fake('two')])
    expect(sets).toEqual([])
  })

  it('is what a session leaving a front is put on', async () => {
    const { follow, sets } = setup()
    await follow.put(fake('one'))
    expect(sets).toEqual(['one:system:'])
  })
})

describe('a config supplied after the sessions were made', () => {
  it('is set once per session, and again only when it changes', async () => {
    const { follow, sets, change } = setup()
    const one = fake('one')
    const two = fake('two')
    change(MIRRORED)
    await follow.changed([one, two])
    await follow.changed([one, two])
    expect(sets).toEqual(['one:fixed_servers:http=proxy.test:3128', 'two:fixed_servers:http=proxy.test:3128'])
    change(OTHER)
    await follow.changed([one])
    expect(sets.at(-1)).toBe('one:fixed_servers:http=proxy.test:8080')
    expect(sets).toHaveLength(3)
  })

  it('goes back to the system\'s own config when the config does', async () => {
    const { follow, sets, change } = setup()
    const one = fake('one')
    change(MIRRORED)
    await follow.changed([one])
    change(undefined)
    await follow.changed([one])
    expect(sets.at(-1)).toBe('one:system:')
  })

  it('is set to a session made after it, one microtask on', async () => {
    const { follow, sets, change } = setup()
    change(MIRRORED)
    follow.adopted(fake('late'))
    expect(sets, 'not in the turn it was made in').toEqual([])
    await flush()
    expect(sets).toEqual(['late:fixed_servers:http=proxy.test:3128'])
  })

  it('is not set to a session that was marked as setting a proxy of its own in the turn it was made', async () => {
    const own = new Set<Fake>()
    const { follow, sets, change } = setup({ kept: (session) => own.has(session) })
    change(MIRRORED)
    const web = fake('web-context')
    follow.adopted(web)
    own.add(web)
    await flush()
    await follow.changed([web])
    expect(sets).toEqual([])
  })

  it('is not set to a session that is kept, and is set once it is not', async () => {
    const { follow, sets, change, kept } = setup()
    const front = fake('front')
    kept.add(front)
    change(MIRRORED)
    await follow.changed([front])
    expect(sets).toEqual([])
    kept.delete(front)
    await follow.changed([front])
    expect(sets).toEqual(['front:fixed_servers:http=proxy.test:3128'])
  })

  it('is set to a session that took it and then left it, by the call that put it back', async () => {
    const { follow, sets, change } = setup()
    const one = fake('one')
    change(MIRRORED)
    await follow.changed([one])
    change(OTHER)
    await follow.put(one)
    await follow.changed([one])
    expect(sets).toEqual(['one:fixed_servers:http=proxy.test:3128', 'one:fixed_servers:http=proxy.test:8080'])
  })
})

describe('a mirrored session', () => {
  it('is set at once, even to the system\'s own config, and at every change whether or not it is among the sessions given', async () => {
    const { follow, sets, change } = setup()
    const mirror = fake('mirror')
    await follow.mirror(mirror)
    expect(sets).toEqual(['mirror:system:'])
    change(MIRRORED)
    await follow.changed([])
    expect(sets.at(-1)).toBe('mirror:fixed_servers:http=proxy.test:3128')
  })

  it('is set although it sets a proxy of its own', async () => {
    const own = new Set<Fake>()
    const { follow, sets, change } = setup({ kept: (session) => own.has(session) })
    const mirror = fake('mirror')
    own.add(mirror)
    await follow.mirror(mirror)
    change(MIRRORED)
    await follow.changed([mirror])
    expect(sets).toEqual(['mirror:system:', 'mirror:fixed_servers:http=proxy.test:3128'])
  })

  it('is tried again at the next change when its first set failed', async () => {
    const failing = new Set<Fake>()
    const { follow, sets } = setup({ failing })
    const mirror = fake('mirror')
    failing.add(mirror)
    await expect(follow.mirror(mirror)).rejects.toThrow('no')
    failing.delete(mirror)
    await follow.changed([])
    expect(sets).toEqual(['mirror:system:'])
  })
})

describe('a set that fails', () => {
  it('is logged, leaves the other sessions set, and is tried again by the next change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new Set<Fake>()
    const { follow, sets, change } = setup({ failing })
    const bad = fake('bad')
    const good = fake('good')
    failing.add(bad)
    change(MIRRORED)
    await follow.changed([bad, good])
    expect(sets).toEqual(['good:fixed_servers:http=proxy.test:3128'])
    expect(error).toHaveBeenCalledTimes(1)
    failing.delete(bad)
    await follow.changed([bad, good])
    expect(sets).toEqual(['good:fixed_servers:http=proxy.test:3128', 'bad:fixed_servers:http=proxy.test:3128'])
  })
})
