// Whether a name put to a session would reach code the system supplied, per what the mirror found and what the session is set to.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackProxySet } from '../proxy-answers.js'
import { setMirrorStatusSource } from '../proxy-mirror/mirror-status.js'
import type { MirrorStatus } from '../proxy-mirror/mirror-status.js'
import { askHolderOfCopy, settingsMayRunCode, wouldRunSystemCode } from '../system-code.js'

afterEach(() => { setMirrorStatusSource(undefined) })

const status = (facts: Partial<MirrorStatus>): MirrorStatus => ({ source: 'gnome', mode: 'none', state: 'system', reason: 'no-proxy', ...facts })

describe('whether the system\'s settings may run code on a name', () => {
  it('does not when the system has no proxy', () => {
    expect(settingsMayRunCode(status({}), {})).toBe(false)
    for (const source of ['windows', 'macos'] as const) expect(settingsMayRunCode(status({ source }), { auto_proxy: 'http://wpad/x.pac' }), `${source} ignores the environment`).toBe(false)
  })

  it('does for a script, whether or not a copy of it was taken, since a session that did not take it still runs it', () => {
    expect(settingsMayRunCode(status({ mode: 'script', reason: 'unfetched' }), {}), 'script left to the system').toBe(true)
    expect(settingsMayRunCode(status({ mode: 'script', state: 'mirrored', reason: 'copied' }), {}), 'script copied').toBe(true)
    expect(settingsMayRunCode(status({ mode: 'script', reason: 'unfetched', probe: 'direct' }), {}), 'a script is never excused by what the probe answers').toBe(true)
  })

  it('does for automatic detection, unless the mirror\'s own question about an ordinary address was answered DIRECT after the settings were last read', () => {
    const detecting = (facts: Partial<MirrorStatus>): MirrorStatus => status({ mode: 'detect', reason: 'detect', ...facts })
    expect(settingsMayRunCode(detecting({ probe: 'direct' }), {}), 'direct').toBe(false)
    expect(settingsMayRunCode(detecting({ probe: 'not-direct' }), {}), 'a proxy or a failure').toBe(true)
    expect(settingsMayRunCode(detecting({ probe: 'unsure' }), {}), 'no answer since the last read, or one too old, or one still pending').toBe(true)
    expect(settingsMayRunCode(detecting({}), {}), 'no probe fact at all').toBe(true)
    expect(settingsMayRunCode(detecting({ state: 'mirrored', reason: 'copied', probe: 'unsure' }), {}), 'detection copied').toBe(true)
  })

  it('does not take the probe for any settings but detection', () => {
    for (const mode of ['manual', 'unsupported', 'unreadable', 'unknown'] as const) {
      expect(settingsMayRunCode(status({ mode, source: 'windows', reason: mode === 'unknown' ? 'starting' : 'disagrees', probe: 'direct' }), {}), mode).toBe(true)
    }
  })

  it('does for a script or detection the environment names, which the mirror reads as it does a desktop\'s', () => {
    for (const source of ['environment', 'gnome', 'kde', 'windows', 'macos'] as const) {
      expect(settingsMayRunCode(status({ source, mode: 'script', reason: 'unfetched' }), {}), `${source} script left to the system`).toBe(true)
      expect(settingsMayRunCode(status({ source, mode: 'detect', reason: 'detect' }), {}), `${source} detection, no probe`).toBe(true)
    }
    expect(settingsMayRunCode(status({ source: 'environment', mode: 'unknown', reason: 'no-reader' }), {}), 'no auto_proxy, so no reader').toBe(false)
  })

  it('does when the mirror could not tell: settings it cannot carry or read, and a first read not made yet', () => {
    expect(settingsMayRunCode(status({ mode: 'unsupported', reason: 'unsupported' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unreadable', reason: 'unreadable' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ source: 'none', mode: 'unknown', reason: 'starting' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unknown', reason: 'starting' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unknown', reason: 'held' }), {})).toBe(true)
  })

  it('does for a manual proxy, copied or not: a session on the system\'s config reads it with whatever else the system does beside it (automatic detection), and the readers report a manual proxy even then', () => {
    expect(settingsMayRunCode(status({ mode: 'manual', state: 'system', reason: 'disagrees' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'manual', state: 'mirrored', reason: 'copied' }), {})).toBe(true)
  })

  it('follows the environment where Chromium reads it: a desktop with no reader, and KDE with no proxy set', () => {
    const bare = status({ source: 'environment', mode: 'unknown', reason: 'no-reader' })
    expect(settingsMayRunCode(bare, {})).toBe(false)
    expect(settingsMayRunCode(bare, { http_proxy: 'http://proxy.test:3128' })).toBe(false)
    expect(settingsMayRunCode(bare, { auto_proxy: 'http://wpad/proxy.pac' })).toBe(true)
    expect(settingsMayRunCode(bare, { auto_proxy: '' }), 'empty is automatic detection').toBe(true)
    expect(settingsMayRunCode(bare, { AUTO_PROXY: 'http://wpad/proxy.pac' })).toBe(true)
    expect(settingsMayRunCode(status({ source: 'environment' }), { auto_proxy: '/a/path/is/no/address' }), 'a value Chromium cannot parse leaves no proxy at all').toBe(false)
    for (const source of ['kde', 'gnome'] as const) {
      const desktop = status({ source })
      expect(settingsMayRunCode(desktop, {}), `${source} with no proxy`).toBe(false)
      expect(settingsMayRunCode(desktop, { auto_proxy: 'http://wpad/proxy.pac' }), `${source} with no proxy and a script in the environment`).toBe(true)
    }
  })
})

describe('whether a name put to a session would reach code of the system\'s', () => {
  const COPY = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128' }

  it('does when the system\'s settings may run code and the session is on the system\'s config', () => {
    setMirrorStatusSource(() => status({ mode: 'script' }))
    expect(wouldRunSystemCode({})).toBe(true)
  })

  it('does not once the session holds a config of Orivon\'s own, though the settings still run code', async () => {
    setMirrorStatusSource(() => status({ mode: 'script', state: 'mirrored', reason: 'copied' }))
    const session = {}
    await trackProxySet(session, async () => {}, 1_000, COPY)
    expect(wouldRunSystemCode(session)).toBe(false)
  })

  it('does not for a session on the wrapped copy of the script the environment names, and does once it is back on the system\'s config', async () => {
    setMirrorStatusSource(() => status({ source: 'environment', mode: 'script', state: 'mirrored', reason: 'copied' }))
    const session = {}
    await trackProxySet(session, async () => {}, 1_000, { mode: 'pac_script' })
    expect(wouldRunSystemCode(session)).toBe(false)
    await trackProxySet(session, async () => {}, 1_000, { mode: 'system' })
    expect(wouldRunSystemCode(session)).toBe(true)
  })

  it('does for a session on the system\'s config, or never set, behind a manual proxy that was copied: a session that has not taken the copy (or failed to) is asked under the system\'s own settings', async () => {
    setMirrorStatusSource(() => status({ mode: 'manual', state: 'mirrored', reason: 'copied' }))
    expect(wouldRunSystemCode({}), 'never set').toBe(true)
    const left = {}
    await trackProxySet(left, async () => {}, 1_000, { mode: 'system' })
    expect(wouldRunSystemCode(left), 'on the system\'s config').toBe(true)
    const failed = {}
    await expect(trackProxySet(failed, async () => { throw new Error('the set failed') }, 1_000, COPY)).rejects.toThrow()
    expect(wouldRunSystemCode(failed), 'a set to the copy that failed').toBe(true)
    const holder = {}
    await trackProxySet(holder, async () => {}, 1_000, COPY)
    expect(wouldRunSystemCode(holder), 'the holder of the copy').toBe(false)
  })

  it('does not for a session on the system\'s config while the probe says detection finds nothing, and does once it does not', () => {
    const probe = { current: 'direct' as MirrorStatus['probe'] }
    setMirrorStatusSource(() => status({ source: 'windows', mode: 'detect', reason: 'detect', ...(probe.current === undefined ? {} : { probe: probe.current }) }))
    expect(wouldRunSystemCode({})).toBe(false)
    probe.current = 'unsure'
    expect(wouldRunSystemCode({})).toBe(true)
    probe.current = 'not-direct'
    expect(wouldRunSystemCode({})).toBe(true)
  })

  it('does not when the settings run none, whatever the session is on', () => {
    setMirrorStatusSource(() => status({}))
    expect(wouldRunSystemCode({})).toBe(false)
  })

  it('does before the mirror exists', () => {
    expect(wouldRunSystemCode({})).toBe(true)
  })

  it('reads this run\'s environment when none is handed in', () => {
    const before = process.env['auto_proxy']
    setMirrorStatusSource(() => status({ source: 'environment', mode: 'unknown', reason: 'no-reader' }))
    try {
      delete process.env['auto_proxy']
      delete process.env['AUTO_PROXY']
      expect(wouldRunSystemCode({})).toBe(false)
      process.env['auto_proxy'] = 'http://wpad/proxy.pac'
      expect(wouldRunSystemCode({})).toBe(true)
    } finally {
      if (before === undefined) delete process.env['auto_proxy']
      else process.env['auto_proxy'] = before
    }
  })
})

describe('Orivon\'s own question about a name the verifier serves', () => {
  const NAME = 'https://fixture.eth/'
  const COPY = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128' }
  const recording = (): { holder: { resolveProxy: (url: string) => Promise<string> }, asked: string[] } => {
    const asked: string[] = []
    return { holder: { resolveProxy: async (url) => { asked.push(url); return 'DIRECT' } }, asked }
  }

  it('is put to the holder of the copy, which has taken it, behind a script', async () => {
    setMirrorStatusSource(() => status({ mode: 'script', state: 'mirrored', reason: 'copied' }))
    const { holder, asked } = recording()
    await trackProxySet(holder, async () => {}, 1_000, COPY)
    expect(await askHolderOfCopy(holder, NAME)).toBe('DIRECT')
    expect(asked).toEqual([NAME])
  })

  it('is put to the holder where the system runs no code of its own', async () => {
    setMirrorStatusSource(() => status({}))
    const { holder, asked } = recording()
    expect(await askHolderOfCopy(holder, NAME)).toBe('DIRECT')
    expect(asked).toEqual([NAME])
  })

  it('is counted as a question under way on the holder, which a change to the system\'s config waits for', async () => {
    setMirrorStatusSource(() => status({}))
    let answer: () => void = () => {}
    const holder = { resolveProxy: async () => await new Promise<string>((done) => { answer = () => { done('DIRECT') } }) }
    await trackProxySet(holder, async () => {}, 1_000, COPY)
    const asked = askHolderOfCopy(holder, NAME)
    const work = vi.fn(async () => {})
    const change = trackProxySet(holder, work, 1_000, { mode: 'system' })
    await new Promise<void>((done) => { setTimeout(done, 20) })
    expect(work).not.toHaveBeenCalled()
    answer()
    await asked
    await change
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('fails without being put to the holder when it holds no copy of a script, of detection, or of settings not read yet', async () => {
    for (const facts of [{ mode: 'script' }, { mode: 'detect' }, { mode: 'unknown', reason: 'starting' }] as const) {
      setMirrorStatusSource(() => status(facts))
      const { holder, asked } = recording()
      await expect(askHolderOfCopy(holder, NAME), facts.mode).rejects.toThrow(/may run a script/)
      expect(asked, facts.mode).toEqual([])
    }
  })
})
