// A proxy script the system names is fetched, wrapped and copied once the wrapped copy answers as Chromium's own session does for the
// original. Driven on a fake clock, over a model of the server and of the two sessions, which run the script text in a context of
// their own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemProxyConfig } from '../../system-follow.js'
import { ANSWER_EVERY_MS, createProxyMirror, READ_EVERY_MS, SCRIPT_EVERY_MS, SCRIPT_RECHECK_MS } from '../proxy-mirror.js'
import type { ProxyMirror, ProxyMirrorDeps } from '../proxy-mirror.js'
import type { SystemSettings } from '../settings-source.js'
import { namesVerifierHost } from '../../verifier-name-guard.js'
import type { PacRun } from './pac-vm.test-helpers.js'
import { runPac } from './pac-vm.test-helpers.js'

const ADDRESS = 'http://wpad.test/proxy.pac'
const OTHER = 'http://wpad.test/other.pac'
const sendsAll = (server: string): string => `function FindProxyForURL(url, host) { return "PROXY ${server}" }`
const FIRST = sendsAll('proxy.test:3128')
const SECOND = sendsAll('proxy.test:3129')
/** Answers differently at every question, whichever session asks. */
const VOLATILE = 'function FindProxyForURL(url, host) { return "PROXY p" + tick() + ".test:80" }'
/** Answers by the time of day, which the test moves with `phase`. */
const BY_THE_CLOCK = 'function FindProxyForURL(url, host) { return phase() ? "PROXY day.test:80" : "PROXY night.test:80" }'

interface World {
  settings: SystemSettings
  /** What the server holds, by address; an address that is not there does not arrive. */
  served: Record<string, string | undefined>
  /** The script Chromium's own session runs: it takes the server's only when it notices (an address that changed, a reload, `notice`). */
  chromium: PacRun | undefined
  /** The session of the mirror's own. */
  checking: PacRun | undefined
  counter: number
  /** The answer of a script that goes by the time of day. */
  day: boolean
  fetches: string[]
  reloads: number
  reloadFails: boolean
  reads: number
  nextReads: SystemSettings[]
  sets: SystemProxyConfig[]
  order: string[]
  applied: number
  /** Chromium's own session reads the script again, as it does when it notices an edit or is asked to. */
  notice: () => void
  /** The settings name another script, and Chromium's own session follows at once. */
  switchTo: (address: string) => void
  /** Every address either session was asked about. */
  asked: string[]
}

/** The text a session is set to by its `data:` address. */
function sourceOf (config: SystemProxyConfig): string {
  return Buffer.from((config.pacScript ?? '').split(',')[1] ?? '', 'base64').toString('latin1')
}

/** What a script may call beyond the helpers every script has: the model's own counter and clock. */
function helpers (world: World): Record<string, unknown> {
  return { tick: () => (world.counter += 1), phase: () => world.day }
}

/** A session's answer for the address; a script that throws or never loaded sends everything direct, as Chromium does. */
function answerOf (run: PacRun | undefined, url: string): string {
  if (run === undefined) return 'DIRECT'
  try {
    return String(run.answer(url))
  } catch {
    return 'DIRECT'
  }
}

function setup (served: Record<string, string | undefined> = { [ADDRESS]: FIRST }, options: { fetch?: boolean } = {}): { mirror: ProxyMirror, world: World, lines: string[] } {
  const settings: SystemSettings = { kind: 'script', url: ADDRESS }
  const world: World = {
    settings, served, chromium: undefined, checking: undefined, counter: 0, day: true, fetches: [], reloads: 0, reloadFails: false, reads: 0, nextReads: [], sets: [], order: [], applied: 0, asked: [],
    notice: () => {
      const text = world.settings.kind === 'script' ? world.served[world.settings.url] : undefined
      world.chromium = text === undefined ? undefined : load(text)
    },
    switchTo: (address) => {
      world.settings = { kind: 'script', url: address }
      world.notice()
    }
  }
  const load = (text: string): PacRun | undefined => {
    try {
      return runPac(text, helpers(world))
    } catch {
      return undefined
    }
  }
  world.notice()
  const lines: string[] = []
  const deps: ProxyMirrorDeps = {
    source: 'gnome',
    read: async () => {
      world.reads += 1
      return world.nextReads.shift() ?? world.settings
    },
    ...(options.fetch === false ? {} : {
      fetchScript: async (url: string) => {
        world.fetches.push(url)
        world.order.push('fetch')
        const text = world.served[url]
        if (text === undefined) throw new Error('the script did not arrive')
        return text
      }
    }),
    reloadSystem: async () => {
      world.order.push('reload')
      world.reloads += 1
      if (world.reloadFails) throw new Error('the session did not read again')
      world.notice()
    },
    systemAnswer: async (url) => { world.asked.push(url); return answerOf(world.chromium, url) },
    check: {
      set: async (config) => {
        world.order.push(`set:${config.mode ?? ''}`)
        world.sets.push(config)
        world.checking = config.mode === 'pac_script' ? load(sourceOf(config)) : undefined
      },
      answer: async (url) => { world.asked.push(url); return answerOf(world.checking, url) }
    },
    apply: async () => {
      world.order.push('apply')
      world.applied += 1
      return true
    },
    log: (line) => { lines.push(line) }
  }
  return { mirror: createProxyMirror(deps), world, lines }
}

/** What the sessions that follow the system answer for `url` under the mirror's config now. */
function copied (mirror: ProxyMirror, url: string, world: World): string {
  const config = mirror.config()
  expect(config.mode).toBe('pac_script')
  return answerOf(runPac(sourceOf(config), helpers(world)), url)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a proxy script the system names', () => {
  it('is fetched, wrapped and copied once the wrapped copy answers as Chromium\'s session does, tried on the check session first', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    expect(world.fetches).toEqual([ADDRESS])
    expect(world.order).toEqual(['fetch', 'set:pac_script', 'apply'])
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'script', state: 'mirrored', reason: 'copied' })
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3128')
    mirror.stop()
  })

  it('is checked with ordinary addresses alone: no name the verifier serves is put to Chromium\'s session, whose script would see it', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 2)
    expect(world.asked.length).toBeGreaterThan(0)
    expect(world.asked.filter(namesVerifierHost)).toEqual([])
    mirror.stop()
  })

  it('answers DIRECT for the names the verifier serves though the script sends them to a proxy', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    expect(answerOf(world.chromium, 'https://vitalik.eth/')).toBe('PROXY proxy.test:3128')
    for (const url of ['https://vitalik.eth/', 'https://vitalik.eth./', 'https://VITALIK.ETH/', 'http://x.orivon/']) expect(copied(mirror, url, world)).toBe('DIRECT')
    mirror.stop()
  })

  it.each([
    ['assigns its function to this', 'this.FindProxyForURL = function () { return "PROXY proxy.test:3128" }'],
    ['replaces the string methods', `String.prototype.endsWith = function () { return false }; String.prototype.slice = function () { return '' }; ${FIRST}`]
  ])('is copied, and the names the verifier serves still go direct, when it %s', async (_, text) => {
    const { mirror, world } = setup({ [ADDRESS]: text })
    await mirror.start()
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3128')
    expect(copied(mirror, 'https://vitalik.eth/', world)).toBe('DIRECT')
    expect(world.fetches).toEqual([ADDRESS])
    mirror.stop()
  })

  it('puts nothing of its address or its text in the status or the log', async () => {
    const { mirror, lines } = setup()
    await mirror.start()
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    const said = JSON.stringify([mirror.status(), lines])
    for (const secret of ['wpad.test', 'proxy.pac', 'proxy.test', '3128', 'FindProxyForURL']) expect(said).not.toContain(secret)
    expect(lines).toHaveLength(1)
    mirror.stop()
  })

  it('stays with the system when it cannot be fetched, and is fetched at the next read once it can be', async () => {
    const { mirror, world } = setup({})
    await mirror.start()
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'script', state: 'system', reason: 'unfetched' })
    expect(world.sets).toEqual([])
    expect(world.applied).toBe(0)
    world.served[ADDRESS] = FIRST
    world.notice()
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(world.fetches.length).toBeGreaterThan(1)
    mirror.stop()
  })

  it('stays with the system when nothing is given to fetch it', async () => {
    const { mirror, world } = setup(undefined, { fetch: false })
    await mirror.start()
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'unfetched' })
    expect(world.fetches).toEqual([])
    mirror.stop()
  })

  it('makes Chromium\'s session read the script again when the copy answers otherwise, and is copied once they agree', async () => {
    const { mirror, world } = setup()
    world.chromium = runPac(SECOND)
    await mirror.start()
    expect(world.reloads).toBe(1)
    expect(world.order).toEqual(['fetch', 'set:pac_script', 'reload', 'set:pac_script', 'apply'])
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('stays with the system when the copy answers otherwise and Chromium\'s session cannot be made to read the script again', async () => {
    const { mirror, world } = setup()
    world.chromium = runPac(SECOND)
    world.reloadFails = true
    await mirror.start()
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'script', state: 'system', reason: 'disagrees' })
    expect(world.applied).toBe(0)
    mirror.stop()
  })
})

describe('a proxy script that changes', () => {
  it('is fetched from the other address when the settings name another, with Chromium\'s own session left to read it', async () => {
    const { mirror, world } = setup({ [ADDRESS]: FIRST, [OTHER]: SECOND })
    await mirror.start()
    world.switchTo(OTHER)
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS, OTHER])
    expect(world.reloads).toBe(0)
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3129')
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('is fetched again at once when Chromium\'s session noticed an edit, and the copy follows', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.served[ADDRESS] = SECOND
    world.notice()
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS, ADDRESS])
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3129')
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('is fetched again before the copy is checked when Chromium\'s answers moved and the last fetch is not recent', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    await vi.advanceTimersByTimeAsync(SCRIPT_RECHECK_MS + 2 * ANSWER_EVERY_MS)
    world.served[ADDRESS] = SECOND
    world.notice()
    world.order.length = 0
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.order).toEqual(['fetch', 'reload', 'set:pac_script', 'apply'])
    expect(world.fetches).toEqual([ADDRESS, ADDRESS])
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3129')
    mirror.stop()
  })

  it('is fetched again after half an hour, and Chromium\'s session is made to read it again before the copy is checked', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.served[ADDRESS] = SECOND
    await vi.advanceTimersByTimeAsync(SCRIPT_EVERY_MS - READ_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS])
    await vi.advanceTimersByTimeAsync(2 * READ_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS, ADDRESS])
    expect(world.reloads).toBe(1)
    expect(world.order.slice(-4)).toEqual(['fetch', 'reload', 'set:pac_script', 'apply'])
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3129')
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('keeps its last text and the copy of it when a later fetch fails', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.served[ADDRESS] = undefined
    await vi.advanceTimersByTimeAsync(SCRIPT_EVERY_MS + 2 * READ_EVERY_MS)
    expect(world.fetches.length).toBeGreaterThan(1)
    expect(world.applied).toBe(1)
    expect(world.reloads).toBe(0)
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3128')
    mirror.stop()
  })

  it('keeps its last text, and does not give up the copy, when its answers move by the clock while the server is out', async () => {
    const { mirror, world } = setup({ [ADDRESS]: BY_THE_CLOCK })
    await mirror.start()
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY day.test:80')
    await vi.advanceTimersByTimeAsync(SCRIPT_RECHECK_MS + 2 * ANSWER_EVERY_MS)
    world.served[ADDRESS] = undefined
    world.day = false
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS, ADDRESS])
    expect(mirror.status()).toEqual({ source: 'gnome', mode: 'script', state: 'mirrored', reason: 'copied' })
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY night.test:80')
    expect(world.applied).toBe(1)
    mirror.stop()
  })

  it('does not change what is applied when it is fetched again and is the same', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    await vi.advanceTimersByTimeAsync(SCRIPT_EVERY_MS + 2 * READ_EVERY_MS)
    expect(world.fetches.length).toBeGreaterThan(1)
    expect(world.applied).toBe(1)
    expect(world.reloads).toBe(0)
    expect(world.sets).toHaveLength(1)
    mirror.stop()
  })

  it('goes back to the system\'s own when Chromium\'s session cannot be made to read the new text, and is copied once it does', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.reloadFails = true
    world.served[ADDRESS] = SECOND
    await vi.advanceTimersByTimeAsync(SCRIPT_EVERY_MS + READ_EVERY_MS)
    expect(world.reloads).toBeGreaterThan(0)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'disagrees' })
    world.notice()
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS)
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(copied(mirror, 'https://ordinary.test/', world)).toBe('PROXY proxy.test:3129')
    mirror.stop()
  })
})

describe('a proxy script that is copied, and settings that stop naming it', () => {
  it('stays through a read that failed while Chromium\'s answers are what they were', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.nextReads = [{ kind: 'unreadable' }]
    await mirror.refresh()
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    expect(world.applied).toBe(1)
    mirror.stop()
  })

  it('is forgotten when the settings name no script, and fetched again when they name one', async () => {
    const { mirror, world } = setup()
    await mirror.start()
    world.settings = { kind: 'none' }
    world.chromium = undefined
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'no-proxy' })
    world.settings = { kind: 'script', url: ADDRESS }
    world.notice()
    await vi.advanceTimersByTimeAsync(ANSWER_EVERY_MS)
    expect(world.fetches).toEqual([ADDRESS, ADDRESS])
    expect(mirror.status()).toMatchObject({ state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })
})

describe('a proxy script whose answers differ at every question', () => {
  it('stays with the system, and costs a bounded number of reads and fetches', async () => {
    const { mirror, world } = setup({ [ADDRESS]: VOLATILE })
    await mirror.start()
    const minutes = 10
    await vi.advanceTimersByTimeAsync(minutes * 60_000)
    expect(mirror.config()).toEqual({ mode: 'system' })
    expect(mirror.status()).toMatchObject({ state: 'system', reason: 'disagrees', mode: 'script' })
    // One pass at the start and one at each read; a pass reads the settings twice when it finds a difference.
    const passes = 1 + (minutes * 60_000) / READ_EVERY_MS
    expect(world.reads).toBeLessThanOrEqual(2 * passes + 2)
    expect(world.fetches.length).toBeLessThanOrEqual(passes + 2)
    expect(world.reloads).toBeLessThanOrEqual(passes + 2)
    expect(world.sets).not.toEqual([])
    mirror.stop()
  })
})
