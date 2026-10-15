import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PACKAGE_PROGRAM, SOURCE_PROGRAM } from '../program-names.js'
import { everywhereBeforeReady } from '../../settings/settings-file.js'
import { startLaunch, takeSourceIdentity } from '../start-launch.js'

let home = ''
let tmp = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orivon-start-home-'))
  tmp = mkdtempSync(join(tmpdir(), 'orivon-start-tmp-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

function fakeApp (lock: boolean): { app: Parameters<typeof startLaunch>[0], calls: ReturnType<typeof vi.fn>, exit: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn>, setPath: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(() => lock)
  const exit = vi.fn()
  const release = vi.fn()
  const setPath = vi.fn()
  const app = { getPath: () => home, setPath, exit, requestSingleInstanceLock: calls, releaseSingleInstanceLock: release, isPackaged: true, getAppPath: () => '/app', commandLine: { hasSwitch: () => false } }
  return { app: app as unknown as Parameters<typeof startLaunch>[0], calls, exit, release, setPath }
}

const run = (app: Parameters<typeof startLaunch>[0], ...args: string[]): ReturnType<typeof startLaunch> => startLaunch(app, ['/opt/Orivon/orivon', ...args], {}, '/opt/Orivon/orivon', tmp)

describe('a second start of a running profile', () => {
  it('hands over what it was asked, and exits with status 0', () => {
    const { app, calls, exit } = fakeApp(false)
    expect(run(app, 'https://a.example/')).toBeNull()
    expect(calls).toHaveBeenCalledWith({ orivonLaunch: 1, kind: 'open', urls: ['https://a.example/'] })
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('asks for a new window when it names nothing', () => {
    const { app, calls } = fakeApp(false)
    run(app)
    expect(calls).toHaveBeenCalledWith({ orivonLaunch: 1, kind: 'window', urls: [] })
  })

  it('asks for a private window, and makes no private directory of its own', () => {
    const { app, calls, exit } = fakeApp(false)
    expect(run(app, '--new-private-window')).toBeNull()
    expect(calls).toHaveBeenCalledWith({ orivonLaunch: 1, kind: 'private', urls: [] })
    expect(exit).toHaveBeenCalledWith(0)
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('the switches a start passes to the browsers it opens', () => {
  it('are the ones before the end of the switches, never what came after it', () => {
    const { app } = fakeApp(true)
    expect(run(app, '--no-sandbox', '--user-data-dir=/data', '--', '--user-data-dir=/elsewhere', 'https://a.example/')?.inherit).toEqual(['--no-sandbox', '--user-data-dir=/data'])
    const second = fakeApp(true)
    expect(run(second.app, '--', '--no-sandbox')?.inherit).toEqual([])
  })
})

describe('a first start of a profile', () => {
  it('keeps the lock and marks the profile running', () => {
    const { app, release } = fakeApp(true)
    const runtime = run(app)
    expect(runtime?.isPrivate).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.orivon-running'))).toBe(true)
  })

  it('that asks for a private window releases the lock and runs as a private session in a directory of its own', () => {
    writeFileSync(join(home, 'settings.json'), '{"version":1,"values":{}}')
    const { app, release, setPath } = fakeApp(true)
    const runtime = run(app, '--new-private-window', 'https://a.example/')
    expect(release).toHaveBeenCalledTimes(1)
    expect(runtime?.isPrivate).toBe(true)
    expect(runtime?.profileId).toBe('private')
    expect(runtime?.dir.startsWith(join(tmp, 'orivon-private-'))).toBe(true)
    expect(setPath).toHaveBeenCalledWith('userData', runtime?.dir)
    expect(existsSync(join(runtime?.dir ?? '', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.orivon-running'))).toBe(false)
  })

  it('names the private directory it made, since no other process is left to remove it, and none for a directory it was given or for a profile', () => {
    const cold = run(fakeApp(true).app, '--new-private-window')
    expect(cold?.madeDir).toBe(cold?.dir)
    const bare = run(fakeApp(false).app, '--orivon-private')
    expect(bare?.madeDir).toBe(bare?.dir)
    const given = join(tmp, 'orivon-private-abc123')
    mkdirSync(given)
    const named = run(fakeApp(false).app, '--orivon-private', `--orivon-private-dir=${given}`)
    expect(named?.dir).toBe(given)
    expect(named?.madeDir).toBeUndefined()
    expect(run(fakeApp(true).app)?.madeDir).toBeUndefined()
  })

  it('held to Nym, knows it in its runtime and reads settings that already hold the tunnel, whether it made its directory or was given one', () => {
    const made = run(fakeApp(false).app, '--orivon-private', '--orivon-private-tunnel=nym')
    expect(made?.launch).toMatchObject({ kind: 'private', tunnel: 'nym' })
    expect(everywhereBeforeReady(join(made?.dir ?? '', 'settings.json'))).toBe(true)

    // A directory the opener made with a settings file that does not hold it: this process writes it again before anything reads it.
    const given = join(tmp, 'orivon-private-abc123')
    mkdirSync(given)
    writeFileSync(join(given, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': false } }))
    const named = run(fakeApp(false).app, '--orivon-private', `--orivon-private-dir=${given}`, '--orivon-private-tunnel=nym')
    expect(named?.dir).toBe(given)
    expect(everywhereBeforeReady(join(given, 'settings.json'))).toBe(true)
    // Without the flag it is an ordinary private session, which reads its file as it is.
    const plain = join(tmp, 'orivon-private-abc124')
    mkdirSync(plain)
    writeFileSync(join(plain, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': false } }))
    expect(run(fakeApp(false).app, '--orivon-private', `--orivon-private-dir=${plain}`)?.launch).not.toHaveProperty('tunnel')
    expect(everywhereBeforeReady(join(plain, 'settings.json'))).toBe(false)
  })

  it('held to Nym, does not start when its settings cannot be set up', () => {
    const given = join(tmp, 'orivon-private-abc125')
    mkdirSync(given)
    mkdirSync(join(given, 'settings.json'))
    const { app, exit } = fakeApp(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(run(app, '--orivon-private', `--orivon-private-dir=${given}`, '--orivon-private-tunnel=nym')).toBeNull()
    expect(exit).toHaveBeenCalledWith(2)
  })

  it('named a private session on the command line takes no lock at all', () => {
    const { app, calls } = fakeApp(false)
    const runtime = run(app, '--orivon-private')
    expect(runtime?.isPrivate).toBe(true)
    expect(calls).not.toHaveBeenCalled()
  })

  it('that names a profile that does not exist exits with status 2', () => {
    const { app, exit } = fakeApp(true)
    mkdirSync(join(home, 'profiles'), { recursive: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(run(app, '--orivon-profile=0123456789ab')).toBeNull()
    expect(exit).toHaveBeenCalledWith(2)
  })
})

describe('a run from source', () => {
  function sourceApp (switches: readonly string[] = [], isPackaged = false): { app: Parameters<typeof takeSourceIdentity>[0], setName: ReturnType<typeof vi.fn>, setDesktopName: ReturnType<typeof vi.fn>, setPath: ReturnType<typeof vi.fn> } {
    const setName = vi.fn()
    const setDesktopName = vi.fn()
    const setPath = vi.fn()
    const app = { isPackaged, setName, setDesktopName, setPath, getPath: () => home, commandLine: { hasSwitch: (name: string) => switches.includes(name) } }
    return { app: app as unknown as Parameters<typeof takeSourceIdentity>[0], setName, setDesktopName, setPath }
  }

  it('keeps its data in a directory of its own, never the one an installed package uses', () => {
    const { app, setPath } = sourceApp()
    takeSourceIdentity(app, 'linux')
    const dir = join(home, SOURCE_PROGRAM)
    expect(setPath).toHaveBeenCalledWith('userData', dir)
    expect(existsSync(dir)).toBe(true)
    expect(SOURCE_PROGRAM).not.toBe(PACKAGE_PROGRAM)
  })

  it('names its windows after its own desktop entry, so the dock gives it an icon of its own', () => {
    const { app, setName, setDesktopName } = sourceApp()
    takeSourceIdentity(app, 'linux')
    expect(setName).toHaveBeenCalledWith(SOURCE_PROGRAM)
    expect(setDesktopName).toHaveBeenCalledWith(`${SOURCE_PROGRAM}.desktop`)
  })

  it('names no desktop entry where there is none', () => {
    const { app, setDesktopName } = sourceApp()
    takeSourceIdentity(app, 'win32')
    expect(setDesktopName).not.toHaveBeenCalled()
  })

  it('keeps a data directory named on its command line', () => {
    const { app, setName, setPath } = sourceApp(['user-data-dir'])
    takeSourceIdentity(app, 'linux')
    expect(setName).toHaveBeenCalledWith(SOURCE_PROGRAM)
    expect(setPath).not.toHaveBeenCalled()
  })

  it('changes nothing in an installed package', () => {
    const { app, setName, setDesktopName, setPath } = sourceApp([], true)
    takeSourceIdentity(app, 'linux')
    for (const call of [setName, setDesktopName, setPath]) expect(call).not.toHaveBeenCalled()
  })
})
