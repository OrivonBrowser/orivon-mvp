// The mirror reads the settings, checks the copy against Chromium's own answer on a session of its own, and applies it only when
// they agree; whatever it cannot read, carry or check leaves the sessions on `{ mode: 'system' }`. Driven on a fake clock over a
// model of the two sessions' answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemProxyConfig } from '../../system-follow.js'
import { ANSWER_EVERY_MS, createProxyMirror, READ_EVERY_MS, START_BOUND_MS } from '../proxy-mirror.js'
import type { ProxyMirror, ProxyMirrorDeps } from '../proxy-mirror.js'
import type { SystemSettings } from '../settings-source.js'

const MANUAL: SystemSettings = { kind: 'manual', proxyRules: 'http=proxy.test:3128;https=proxy.test:3128', exceptions: ['localhost', '*.corp.test'] }
const MOVED: SystemSettings = { kind: 'manual', proxyRules: 'http=proxy.test:3129;https=proxy.test:3129', exceptions: ['localhost', '*.corp.test'] }

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
  checkConfig: SystemProxyConfig | undefined
  hang: boolean
}

function setup (options: { read?: boolean, held?: boolean, settings?: SystemSettings } = {}): { mirror: ProxyMirror, world: World, lines: string[] } {
  const settings = options.settings ?? MANUAL
  const world: World = { settings, truth: settings, corrupt: () => undefined, nextReads: [], reads: 0, sets: [], applied: 0, checkConfig: undefined, hang: false }
  const lines: string[] = []
  const deps: ProxyMirrorDeps = {
    source: 'gnome',
    read: options.read === false ? undefined : async () => { world.reads += 1; return world.nextReads.shift() ?? world.settings },
    ...(options.held === true ? { held: true } : {}),
    systemAnswer: async (url) => {
      if (world.hang) return await new Promise<string>(() => {})
      return world.truth.kind === 'manual' ? answer(world.truth.proxyRules, world.truth.exceptions, url) : 'DIRECT'
    },
    check: {
      set: async (config) => { world.sets.push(config); world.checkConfig = config },
      answer: async (url) => {
        const config = world.checkConfig
        const wrong = world.corrupt(url)
        if (wrong !== undefined) return wrong
        if (config?.mode !== 'fixed_servers') return 'DIRECT'
        return answer(config.proxyRules ?? '', (config.proxyBypassRules ?? '').split(';'), url)
      }
    },
    apply: async () => { world.applied += 1 },
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
    expect(mirror.config().proxyBypassRules).toContain('*.eth.')
    expect(world.applied).toBe(1)
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('is tried on the check session before it is applied to any other', async () => {
    const { mirror, world } = setup()
    const order: string[] = []
    world.sets.push = ((config: SystemProxyConfig) => { order.push(`set:${config.mode ?? ''}`); return world.sets.length + 1 }) as typeof world.sets.push
    await mirror.start()
    expect(order[0]).toBe('set:fixed_servers')
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
  it('ends the timers', async () => {
    const { mirror } = setup()
    await mirror.start()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    mirror.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
