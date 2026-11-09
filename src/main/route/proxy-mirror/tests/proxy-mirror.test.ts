// The mirror reads the settings, checks the copy against Chromium's own answer on a session of its own, and applies it only when
// they agree; whatever it cannot read, carry or check leaves the sessions on `{ mode: 'system' }`, except that a copy already applied
// is kept through a read that failed or a check that got no answer. Driven on a fake clock over a model of the two sessions' answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemProxyConfig } from '../../system-follow.js'
import { ANSWER_EVERY_MS, createProxyMirror, READ_EVERY_MS, START_BOUND_MS } from '../proxy-mirror.js'
import type { ProxyMirror, ProxyMirrorDeps } from '../proxy-mirror.js'
import type { SystemSettings } from '../settings-source.js'

const MANUAL: SystemSettings = { kind: 'manual', proxyRules: 'http=proxy.test:3128;https=proxy.test:3128', exceptions: ['localhost', '*.corp.test'] }
const MOVED: SystemSettings = { kind: 'manual', proxyRules: 'http=proxy.test:3129;https=proxy.test:3129', exceptions: ['localhost', '*.corp.test'] }
const EDITED: SystemSettings = { ...MANUAL, exceptions: ['localhost', '*.corp.test', '*.lan'] }
/** Past the longest a question to a session may take (5 seconds). */
const PAST_A_CALL_MS = 6_000

/** Chromium's answer for `url` under rules like `http=h:p;https=h:p` and bypass rules like `*.suffix`: what the two sessions are modelled to say. */
function answer (rules: string, bypass: readonly string[], url: string): string {
  const { protocol, hostname } = new URL(url)
  const skipped = bypass.some((rule) => rule === hostname || (rule.startsWith('*.') && hostname.endsWith(rule.slice(1))))
  if (skipped) return 'DIRECT'
  const scheme = protocol.slice(0, -1)
  const server = rules.split(';').find((rule) => rule.startsWith(`${scheme}=`))?.slice(scheme.length + 1)
  return server === undefined ? 'DIRECT' : `PROXY ${server}`
}

interface World {
  settings: SystemSettings
  /** What the settings window currently holds; Chromium's own answer follows it at once, a read follows `settings`. */
  truth: SystemSettings
  /** What the copy answers instead of the right answer, for the addresses it names. */
  corrupt: (url: string) => string | undefined
  /** Settings the next reads return, before `settings` is returned again. */
  nextReads: SystemSettings[]
  reads: number
  sets: SystemProxyConfig[]
  applied: number
  /** What `apply` says: whether every session took the config. */
  applyClean: boolean
  /** What the mirror did to a session other than Chromium's own, in order. */
  order: string[]
  checkConfig: SystemProxyConfig | undefined
  hang: boolean
  /** The check session's answers never come. */
  hangCheck: boolean
  /** A read, or a set of the check session, that waits for this before it ends. */
  gates: { read?: Promise<void>, set?: Promise<void> }
}

function setup (options: { read?: boolean, held?: boolean, settings?: SystemSettings } = {}): { mirror: ProxyMirror, world: World, lines: string[] } {
  const settings = options.settings ?? MANUAL
  const world: World = { settings, truth: settings, corrupt: () => undefined, nextReads: [], reads: 0, sets: [], applied: 0, applyClean: true, order: [], checkConfig: undefined, hang: false, hangCheck: false, gates: {} }
  const lines: string[] = []
  const deps: ProxyMirrorDeps = {
    source: 'gnome',
    read: options.read === false ? undefined : async () => {
      world.reads += 1
      if (world.gates.read !== undefined) await world.gates.read
      return world.nextReads.shift() ?? world.settings
    },
    ...(options.held === true ? { held: true } : {}),
    systemAnswer: async (url) => {
      if (world.hang) return await new Promise<string>(() => {})
      return world.truth.kind === 'manual' ? answer(world.truth.proxyRules, world.truth.exceptions, url) : 'DIRECT'
    },
    check: {
      set: async (config) => {
        world.order.push(`set:${config.mode ?? ''}`)
        world.sets.push(config)
        world.checkConfig = config
        if (world.gates.set !== undefined) await world.gates.set
      },
      answer: async (url) => {
        if (world.hangCheck) return await new Promise<string>(() => {})
        const config = world.checkConfig
        const wrong = world.corrupt(url)
        if (wrong !== undefined) return wrong
        if (config?.mode !== 'fixed_servers') return 'DIRECT'
        return answer(config.proxyRules ?? '', (config.proxyBypassRules ?? '').split(';'), url)
      }
    },
    apply: async () => {
      world.order.push('apply')
      world.applied += 1
      return world.applyClean
    },
    log: (line) => { lines.push(line) }
  }
  return { mirror: createProxyMirror(deps), world, lines }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a computer whose settings cannot be read yet, or a window held to a tunnel', () => {
  it('does nothing at all: no read, no timer, no change of config', async () => {
    for (const options of [{ read: false }, { held: true }]) {
      const { mirror, world } = setup(options)
      await mirror.start()
      await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3)
      expect(vi.getTimerCount()).toBe(0)
      expect(world.reads).toBe(0)
      expect(world.applied).toBe(0)
      expect(mirror.config()).toEqual({ mode: 'system' })
      expect(mirror.status()).toMatchObject({ state: 'system', reason: options.read === false ? 'no-reader' : 'held' })
    }
  })
})

describe('a manual proxy', () => {
  it('is copied, with the exceptions and the routed names, once the copy answers as Chromium does', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    expect(mirror.config()).toMatchObject({ mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128;https=proxy.test:3128' })
    expect(mirror.config().proxyBypassRules).toContain('*.corp.test')
    expect(mirror.config().proxyBypassRules).toContain('*.eth')
    expect(mirror.config().proxyBypassRules).not.toContain('*.eth.')
    expect(world.applied).toBe(1)
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('is tried on the check session before it is applied to any other', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    expect(world.order).toEqual(['set:fixed_servers', 'apply'])
    mirror.stop()
  })

  it('is not applied when the copy answers otherwise, even after a fresh read, and the sessions stay on the system\'s own', async () => {
    const { mirror, world, lines } = setup()
    world.corrupt = (url) => url === 'https://example.com/' ? 'DIRECT' : undefined
    await mirror.start()
    expect(world.reads).toBe(2)
    expect(world.applied).toBe(0)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'manual', state: 'system', reason: 'disagrees' })
    expect(lines).toEqual(['[route] system proxy: left to the system (gnome, manual, disagrees)'])
    mirror.stop()
  })

  it('is applied when the second read, taken at once, is the one the copy answers like', async () => {
    const { mirror, world } = setup()
    world.truth = MOVED
    world.nextReads = [MANUAL, MOVED]
    await mirror.start()
    expect(world.reads).toBe(2)
    expect(mirror.config()).toMatchObject({ proxyRules: 'http=proxy.test:3129;https=proxy.test:3129' })
    expect(mirror.status().reason).toBe('copied')
    mirror.stop()
  })

  it('is not applied when the copy sends an address the system\'s exceptions cover to the proxy', async () => {
    const { mirror, world } = setup()
    world.corrupt = (url) => url === 'https://probe.corp.test/' ? 'PROXY proxy.test:3128' : undefined
    await mirror.start()
    expect(mirror.status().reason).toBe('disagrees')
    expect(mirror.config()).toEqual({ mode: 'system' })
    mirror.stop()
  })

  it('is tried again at the next read after a disagreement, and applied once the copy agrees', async () => {
    const { mirror, world } = setup()
    world.corrupt = () => 'DIRECT'
    await mirror.start()
    expect(mirror.status().reason).toBe('disagrees')
    world.corrupt = () => undefined
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(world.applied).toBe(1)
    mirror.stop()
  })

  it('moves to the sessions when the system\'s proxy moves, within a tick and without waiting for the next read', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    const readsBefore = world.reads
    world.settings = MOVED
    world.truth = MOVED
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.reads).toBeGreaterThan(readsBefore)
    expect(mirror.config()).toMatchObject({ proxyRules: 'http=proxy.test:3129;https=proxy.test:3129' })
    expect(world.applied).toBe(2)
    mirror.stop()
  })

  it('does nothing when a read and Chromium\'s answers are what they were', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    const setsBefore = world.sets.length
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3)
    expect(world.sets.length).toBe(setsBefore)
    expect(world.applied).toBe(1)
    mirror.stop()
  })

  it('follows an edit of the exceptions alone at the next read, when Chromium\'s two base answers did not change', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = { ...MANUAL, exceptions: ['localhost', '*.corp.test', '*.lan'] }
    world.truth = world.settings
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config().proxyBypassRules).toContain('*.lan')
    expect(world.applied).toBe(2)
    mirror.stop()
  })
})

describe('settings that are not copied', () => {
  it.each([
    [{ kind: 'none' }, 'no-proxy'], [{ kind: 'script' }, 'script'], [{ kind: 'detect' }, 'detect'], [{ kind: 'unsupported' }, 'unsupported'], [{ kind: 'unreadable' }, 'unreadable']
  ] as Array<[SystemSettings, string]>)('(%j) leave the sessions on the system\'s own, for the reason %s', async (settings, reason) => {
    const { mirror, world } = setup({ settings })
    await mirror.start()
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(world.applied).toBe(0)
    expect(world.sets).toEqual([])
    expect(mirror.status()).toMatchObject({ state: 'system', reason, mode: settings.kind })
    mirror.stop()
  })

  it('put a copied proxy back on the system\'s own when it is turned off or replaced by a script', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = { kind: 'none' }
    world.truth = { kind: 'none' }
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(world.applied).toBe(2)
    world.settings = MANUAL
    world.truth = MANUAL
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(mirror.status().state).toBe('mirrored')
    world.settings = { kind: 'script' }
    world.truth = { kind: 'script' }
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'script' })
    mirror.stop()
  })

  it('are read again until they can be: an unreadable one does not stick', async () => {
    const { mirror, world } = setup({ settings: { kind: 'unreadable' } })
    world.truth = MANUAL
    await mirror.start()
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'unreadable' })
    world.settings = MANUAL
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })
})

describe('a copy that is applied, and a read or a check that decides nothing', () => {
  it('stays through a read that failed while Chromium\'s answers are what they were, and nothing is set again when the reads are good once more', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    const before = mirror.config()
    world.nextReads = [{ kind: 'unreadable' }, { kind: 'unreadable' }]
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 2)
    expect(mirror.config()).toEqual(before)
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' })
    expect(world.order).toEqual(['set:fixed_servers', 'apply'])
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 2)
    expect(world.order).toEqual(['set:fixed_servers', 'apply'])
    mirror.stop()
  })

  it('stays through a check that got no answer, is tried again at the next read, and an edit made meanwhile is applied then', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = EDITED
    world.truth = EDITED
    world.hangCheck = true
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS + PAST_A_CALL_MS)
    expect(mirror.config().proxyBypassRules).not.toContain('*.lan')
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' })
    expect(world.applied).toBe(1)
    world.hangCheck = false
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config().proxyBypassRules).toContain('*.lan')
    expect(mirror.status().reason).toBe('copied')
    expect(world.applied).toBe(2)
    mirror.stop()
  })

  it('stays through a check whose session could not be set', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = EDITED
    world.truth = EDITED
    world.gates.set = new Promise<void>(() => {})
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS + PAST_A_CALL_MS)
    expect(mirror.status().reason).toBe('copied')
    expect(world.applied).toBe(1)
    mirror.stop()
  })

  it('goes back to the system\'s own when Chromium\'s answers moved, even if the read failed', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = { kind: 'unreadable' }
    world.truth = { kind: 'none' }
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'unreadable' })
    expect(world.applied).toBe(2)
    mirror.stop()
  })

  it('goes back to the system\'s own when a check gets a real different answer', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = EDITED
    world.truth = EDITED
    world.corrupt = (url) => url === 'https://example.com/' ? 'DIRECT' : undefined
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'disagrees' })
    mirror.stop()
  })

  it('goes back to the system\'s own when the read taken again after a real difference fails', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = EDITED
    world.truth = EDITED
    world.corrupt = (url) => url === 'https://probe.lan/' ? 'PROXY proxy.test:3128' : undefined
    world.nextReads = [EDITED, { kind: 'unreadable' }]
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'unreadable' })
    mirror.stop()
  })
})

describe('a session that did not take the config', () => {
  it('is set again at the next pass, and only once it took it is the config left alone', async () => {
    const { mirror, world } = setup()
    world.applyClean = false
    await mirror.start()
    expect(world.applied).toBe(1)
    expect(mirror.status().reason).toBe('copied')
    world.applyClean = true
    const setsBefore = world.sets.length
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(world.applied).toBe(2)
    expect(world.sets.length).toBe(setsBefore)
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3)
    expect(world.applied).toBe(2)
    mirror.stop()
  })

  it('is set again by a pass that decides the config it already holds', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = EDITED
    world.truth = EDITED
    world.corrupt = (url) => url === 'https://example.com/' ? 'DIRECT' : undefined
    world.applyClean = false
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status().reason).toBe('disagrees')
    expect(world.applied).toBe(2)
    world.applyClean = true
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.status().reason).toBe('disagrees')
    expect(world.applied).toBe(3)
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(world.applied).toBe(3)
    mirror.stop()
  })

  it('is set again after a pass that changed nothing else, and after one that moved the config', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.applyClean = false
    world.settings = MOVED
    world.truth = MOVED
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.applied).toBe(2)
    world.applyClean = true
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(world.applied).toBe(3)
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(world.applied).toBe(3)
    mirror.stop()
  })
})

describe('what it says of itself', () => {
  it('holds no address, URL or exception in the status or in a line of the log', async () => {
    const { mirror, world, lines } = setup()
    await mirror.start()
    world.settings = MOVED
    world.truth = MOVED
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    const said = JSON.stringify(mirror.status()) + lines.join('\n')
    expect(said).not.toMatch(/proxy\.test|corp\.test|3128|3129|example\.com/)
    expect(lines.length).toBe(1)
    mirror.stop()
  })
})

describe('a session that does not answer', () => {
  it('does not hold the start of the browser longer than the bound, and the sessions stay on the system\'s own', async () => {
    const { mirror, world } = setup()
    world.hang = true
    const started = mirror.start()
    await vi.advanceTimersByTimeAsync(START_BOUND_MS)
    await started
    expect(mirror.config()).toEqual({ mode: 'system' })
    mirror.stop()
  })

  it('counts as a difference, not as agreement', async () => {
    const { mirror, world } = setup()
    world.hang = true
    const started = mirror.start()
    await vi.advanceTimersByTimeAsync(START_BOUND_MS)
    await started
    expect(world.applied).toBe(0)
    mirror.stop()
  })
})

describe('stopping', () => {
  it.each(['read', 'set'] as const)('leaves a pass that ends later with nothing applied: stopped while the %s was under way', async (where) => {
    const { mirror, world } = setup()
    let release: () => void = () => {}
    world.gates[where] = new Promise<void>((resolve) => { release = resolve })
    const started = mirror.start()
    await vi.advanceTimersByTimeAsync(1)
    mirror.stop()
    release()
    await vi.advanceTimersByTimeAsync(START_BOUND_MS)
    await started
    expect(world.applied).toBe(0)
    expect(world.order).not.toContain('apply')
    if (where === 'read') expect(world.sets).toEqual([])
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends the timers', async () => {
    const { mirror } = setup()
    await mirror.start()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    mirror.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
