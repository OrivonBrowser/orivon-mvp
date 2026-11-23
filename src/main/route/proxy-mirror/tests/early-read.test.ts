// The operating system's proxy settings are read before the browser is ready, and the mirror's first pass takes that read instead of starting one.
// A read that failed ends the pass where a read made after ready ends it, and the passes after the first read afresh.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemProxyConfig } from '../../system-follow.js'
import { readEarly, readerFor, startSystemRead } from '../early-read.js'
import type { SettingsReader } from '../early-read.js'
import { createProxyMirror } from '../proxy-mirror.js'
import type { ProxyMirror } from '../proxy-mirror.js'
import type { SystemSettings } from '../settings-source.js'

const programs = vi.hoisted(() => ({
  gnome: vi.fn(async () => ({ kind: 'none' as const })),
  kde: vi.fn(async () => ({ kind: 'none' as const })),
  macos: vi.fn(async () => ({ kind: 'none' as const })),
  windows: vi.fn(async () => ({ kind: 'none' as const }))
}))

// The readers that start a program or open a file are counted, never run; `CommandFailed` and `readWindowsSettings` stay real for the mirror cases below.
vi.mock('../run-readers.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../run-readers.js')>(),
  readGnomeSettings: programs.gnome,
  readMacosSettings: programs.macos,
  readWindowsSettings: programs.windows
}))
vi.mock('../read-kde-files.js', () => ({ readKdeSettings: programs.kde }))

const { CommandFailed, readWindowsSettings } = await vi.importActual<typeof import('../run-readers.js')>('../run-readers.js')

const MANUAL: SystemSettings = { kind: 'manual', proxyRules: 'http=proxy.test:3128;https=proxy.test:3128', exceptions: ['localhost'] }
const UNREADABLE: SystemSettings = { kind: 'unreadable' }
const GNOME = { XDG_CURRENT_DESKTOP: 'GNOME' }
const KDE = { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }
const XFCE = { XDG_CURRENT_DESKTOP: 'XFCE' }
const app = '/opt/Orivon/orivon'

beforeEach(() => { vi.clearAllMocks() })

/** A reader that counts how often it was asked and answers with each of `answers` in turn, then with the last. */
function counting (...answers: SystemSettings[]): { read: SettingsReader, asked: () => number } {
  let asked = 0
  return { read: async () => answers[Math.min(asked++, answers.length - 1)] ?? UNREADABLE, asked: () => asked }
}

/** A mirror whose sessions all answer DIRECT, so that a settings read alone decides what it does. */
function mirrorOver (read: SettingsReader | undefined): { mirror: ProxyMirror, applied: SystemProxyConfig[] } {
  const applied: SystemProxyConfig[] = []
  const mirror: ProxyMirror = createProxyMirror({
    source: 'windows',
    read,
    systemAnswer: async () => 'DIRECT',
    check: { set: async () => {}, answer: async () => 'DIRECT' },
    apply: async () => { applied.push(mirror.config()); return true },
    log: () => {}
  })
  return { mirror, applied }
}

describe('a read started before the browser is ready', () => {
  it('starts the read at once, and once', () => {
    const { read, asked } = counting(MANUAL)
    readEarly(read)
    expect(asked()).toBe(1)
  })

  it('hands the first caller that read, started or not, and every later caller a read of its own', async () => {
    const { read, asked } = counting(MANUAL, { kind: 'none' })
    const early = readEarly(read)
    expect(await early?.()).toEqual(MANUAL)
    expect(asked()).toBe(1)
    expect(await early?.()).toEqual({ kind: 'none' })
    expect(asked()).toBe(2)
  })

  it('has nothing to start where there is no reader', () => {
    expect(readEarly(undefined)).toBeUndefined()
  })

  it('is awaited by a first pass that comes while it is in flight, with no second read', async () => {
    let finish: (settings: SystemSettings) => void = () => {}
    const read = vi.fn(async () => await new Promise<SystemSettings>((resolve) => { finish = resolve }))
    const { mirror, applied } = mirrorOver(readEarly(read))
    const started = mirror.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(read).toHaveBeenCalledTimes(1)
    expect(applied).toEqual([])
    finish(MANUAL)
    await started
    expect(read).toHaveBeenCalledTimes(1)
    expect(mirror.status()).toEqual({ source: 'windows', mode: 'manual', state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })

  it('is read afresh by the passes after the first', async () => {
    const { read, asked } = counting(UNREADABLE, MANUAL)
    const { mirror } = mirrorOver(readEarly(read))
    await mirror.start()
    expect(asked()).toBe(1)
    expect(mirror.status().reason).toBe('unreadable')
    await mirror.refresh()
    expect(asked()).toBe(2)
    expect(mirror.status()).toMatchObject({ mode: 'manual', state: 'mirrored', reason: 'copied' })
    mirror.stop()
  })
})

describe('an early read that failed', () => {
  /** The three `reg.exe` calls end as one that took too long ends: killed, with no exit code of its own. */
  const tooSlow = async (): Promise<string> => { throw new CommandFailed(undefined) }
  const notRunnable = async (): Promise<string> => { throw new Error('spawn reg.exe ENOENT') }

  it.each([['reading nothing it can use', async () => UNREADABLE], ['taking too long', async () => await readWindowsSettings(tooSlow, 'C:\\Windows')], ['a program that cannot start', async () => await readWindowsSettings(notRunnable, 'C:\\Windows')]])('leaves the mirror where a late read %s leaves it', async (_name, read) => {
    const late = mirrorOver(read)
    await late.mirror.start()
    const early = mirrorOver(readEarly(read))
    await early.mirror.start()
    expect(early.mirror.status()).toEqual({ source: 'windows', mode: 'unreadable', state: 'system', reason: 'unreadable' })
    expect(early.mirror.status()).toEqual(late.mirror.status())
    expect(early.mirror.config()).toEqual(late.mirror.config())
    expect(early.applied).toEqual(late.applied)
    late.mirror.stop()
    early.mirror.stop()
  })

  it('does not fail the start: the read that failed is a word the mirror reports, and nothing rejects', async () => {
    const { mirror } = mirrorOver(readEarly(async () => await readWindowsSettings(tooSlow, 'C:\\Windows')))
    await expect(mirror.start()).resolves.toBeUndefined()
    mirror.stop()
  })
})

describe('which reader is started before the browser is ready', () => {
  it('is the reader of the computer\'s own settings source, and only that one', async () => {
    expect(readerFor('gnome', {})).toBe(programs.gnome)
    expect(readerFor('kde', {})).toBe(programs.kde)
    expect(readerFor('windows', {})).toBe(programs.windows)
    expect(readerFor('macos', {})).toBe(programs.macos)
    expect(readerFor('environment', {})).toBeUndefined()
    expect(await readerFor('environment', { auto_proxy: 'http://wpad.test/proxy.pac' })?.()).toEqual({ kind: 'script', url: 'http://wpad.test/proxy.pac' })
  })

  it.each([
    ['win32', {}, programs.windows],
    ['darwin', {}, programs.macos],
    ['linux', GNOME, programs.gnome],
    ['linux', KDE, programs.kde]
  ] as const)('runs the one for %s with %j now, and the first read the mirror makes is that run', async (platform, env, program) => {
    program.mockResolvedValueOnce(MANUAL as never)
    const read = startSystemRead(platform, env, [app])
    expect(program).toHaveBeenCalledTimes(1)
    for (const other of Object.values(programs)) if (other !== program) expect(other).not.toHaveBeenCalled()
    expect(await read?.()).toEqual(MANUAL)
    expect(program).toHaveBeenCalledTimes(1)
  })

  it('starts no program where the settings are the environment\'s', () => {
    expect(startSystemRead('linux', XFCE, [app])).toBeUndefined()
    expect(startSystemRead('linux', { ...XFCE, auto_proxy: '' }, [app])).toBeDefined()
    for (const program of Object.values(programs)) expect(program).not.toHaveBeenCalled()
  })

  it('starts nothing in a private session held to its tunnel, which follows no setting of the computer', () => {
    expect(startSystemRead('win32', {}, [app, '--orivon-private', '--orivon-private-tunnel=nym'])).toBeUndefined()
    for (const program of Object.values(programs)) expect(program).not.toHaveBeenCalled()
  })

  it('starts one in a private session that is held to no tunnel, and after the first `--`, which names a link and no switch', () => {
    expect(startSystemRead('win32', {}, [app, '--orivon-private'])).toBeDefined()
    expect(programs.windows).toHaveBeenCalledTimes(1)
    expect(startSystemRead('win32', {}, [app, '--', '--orivon-private', '--orivon-private-tunnel=nym'])).toBeDefined()
    expect(programs.windows).toHaveBeenCalledTimes(2)
  })
})
