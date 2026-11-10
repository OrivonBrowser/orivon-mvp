// Whether a name put to a session would reach code the system supplied, per what the mirror found and what the session is set to.

import { afterEach, describe, expect, it } from 'vitest'
import { trackProxySet } from '../proxy-answers.js'
import { setMirrorStatusSource } from '../proxy-mirror/mirror-status.js'
import type { MirrorStatus } from '../proxy-mirror/mirror-status.js'
import { askHolderOfCopy, settingsMayRunCode, wouldRunSystemCode } from '../system-code.js'

afterEach(() => { setMirrorStatusSource(undefined) })

const status = (facts: Partial<MirrorStatus>): MirrorStatus => ({ source: 'gnome', mode: 'none', state: 'system', reason: 'no-proxy', ...facts })

describe('whether the system\'s settings may run code on a name', () => {
  it('does not when the system has no proxy, or a manual proxy whose copy the sessions took', () => {
    expect(settingsMayRunCode(status({}), {})).toBe(false)
    expect(settingsMayRunCode(status({ mode: 'manual', state: 'mirrored', reason: 'copied' }), {})).toBe(false)
    for (const source of ['gnome', 'windows', 'macos'] as const) expect(settingsMayRunCode(status({ source }), { auto_proxy: 'http://wpad/x.pac' }), `${source} ignores the environment`).toBe(false)
  })

  it('does for a script and for automatic detection, whether or not a copy of the script was taken, since a session that did not take it still runs it', () => {
    for (const mode of ['script', 'detect'] as const) {
      expect(settingsMayRunCode(status({ mode, reason: mode === 'script' ? 'unfetched' : 'detect' }), {}), `${mode} left to the system`).toBe(true)
      expect(settingsMayRunCode(status({ mode, state: 'mirrored', reason: 'copied' }), {}), `${mode} copied`).toBe(true)
    }
  })

  it('does when the mirror could not tell: settings it cannot carry or read, and a first read not made yet', () => {
    expect(settingsMayRunCode(status({ mode: 'unsupported', reason: 'unsupported' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unreadable', reason: 'unreadable' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ source: 'none', mode: 'unknown', reason: 'starting' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unknown', reason: 'starting' }), {})).toBe(true)
    expect(settingsMayRunCode(status({ mode: 'unknown', reason: 'held' }), {})).toBe(true)
  })

  it('does for a manual proxy whose copy was not taken, since Chromium may do more with the settings than the reader saw', () => {
    expect(settingsMayRunCode(status({ mode: 'manual', state: 'system', reason: 'disagrees' }), {})).toBe(true)
  })

  it('follows the environment where Chromium reads it: a desktop with no reader, and KDE with no proxy set', () => {
    const bare = status({ source: 'environment', mode: 'unknown', reason: 'no-reader' })
    expect(settingsMayRunCode(bare, {})).toBe(false)
    expect(settingsMayRunCode(bare, { http_proxy: 'http://proxy.test:3128' })).toBe(false)
    expect(settingsMayRunCode(bare, { auto_proxy: 'http://wpad/proxy.pac' })).toBe(true)
    expect(settingsMayRunCode(bare, { auto_proxy: '' }), 'empty is automatic detection').toBe(true)
    expect(settingsMayRunCode(bare, { AUTO_PROXY: 'http://wpad/proxy.pac' })).toBe(true)
    const kde = status({ source: 'kde' })
    expect(settingsMayRunCode(kde, {})).toBe(false)
    expect(settingsMayRunCode(kde, { auto_proxy: 'http://wpad/proxy.pac' })).toBe(true)
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

  it('fails without being put to the holder when it holds no copy of a script, of detection, or of settings not read yet', async () => {
    for (const facts of [{ mode: 'script' }, { mode: 'detect' }, { mode: 'unknown', reason: 'starting' }] as const) {
      setMirrorStatusSource(() => status(facts))
      const { holder, asked } = recording()
      await expect(askHolderOfCopy(holder, NAME), facts.mode).rejects.toThrow(/may run a script/)
      expect(asked, facts.mode).toEqual([])
    }
  })
})
