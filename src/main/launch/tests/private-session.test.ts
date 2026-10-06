import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRACE_MS, createPrivateDir, isPrivateDirName, markPrivate, removeAfterExit, removePrivateDir, sweepPrivateDirs } from '../private-session.js'

let root: string
let tmp: string
let home: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-private-test-'))
  tmp = join(root, 'tmp')
  home = join(root, 'home')
  await mkdir(tmp, { recursive: true })
  await mkdir(home, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('a private session\'s directory', () => {
  it('is new, named as a private directory is, and closed to other users', async () => {
    const dir = createPrivateDir(home, home, tmp)
    expect(dir.startsWith(tmp)).toBe(true)
    expect(isPrivateDirName(dir.slice(tmp.length + 1))).toBe(true)
    if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect(createPrivateDir(home, home, tmp)).not.toBe(dir)
  })

  it('begins with the settings, shortcuts and search engines of the profile that opened it and the light client\'s checkpoint, and nothing else', async () => {
    await writeFile(join(home, 'settings.json'), '{"version":1,"values":{"appearance.theme":"dark"}}')
    await writeFile(join(home, 'shortcuts.json'), '{"version":1,"bindings":{"new-tab":"Ctrl+T"}}')
    await writeFile(join(home, 'search-engines.json'), '{"version":1,"engines":[],"removedSeeds":[]}')
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'checkpoint.json'), '{"c":1}')
    await writeFile(join(home, 'verifier', 'ipns-sequences.json'), '{"k51visited":7}')
    for (const secret of ['bookmarks.json', 'history.db', 'zoom.json', 'telemetry.json']) await writeFile(join(home, secret), 'private')
    await mkdir(join(home, 'identity'), { recursive: true })
    await writeFile(join(home, 'identity', 'seed.json'), '{"seed":"secret"}')
    await mkdir(join(home, 'grants'), { recursive: true })
    await writeFile(join(home, 'grants', 'ledger.json'), '{}')

    const dir = createPrivateDir(home, home, tmp)

    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toContain('dark')
    expect(await readFile(join(dir, 'shortcuts.json'), 'utf8')).toContain('new-tab')
    expect(await readFile(join(dir, 'search-engines.json'), 'utf8')).toContain('removedSeeds')
    expect(await readFile(join(dir, 'verifier', 'checkpoint.json'), 'utf8')).toBe('{"c":1}')
    for (const name of ['bookmarks.json', 'history.db', 'zoom.json', 'telemetry.json', 'identity', 'grants', join('verifier', 'ipns-sequences.json')]) expect(existsSync(join(dir, name)), name).toBe(false)
  })

  it('takes the settings from the opener and the checkpoint from home, when they are not the same profile', async () => {
    const opener = join(root, 'opener')
    await mkdir(opener, { recursive: true })
    await writeFile(join(opener, 'settings.json'), 'from the opener')
    await writeFile(join(home, 'settings.json'), 'from home')
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'checkpoint.json'), 'x')
    const dir = createPrivateDir(opener, home, tmp)
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('from the opener')
    expect(existsSync(join(dir, 'verifier', 'checkpoint.json'))).toBe(true)
  })

  it('is made when there is nothing to copy', () => {
    expect(existsSync(createPrivateDir(join(root, 'nowhere'), join(root, 'nowhere-either'), tmp))).toBe(true)
  })
})

describe('removing a private directory', () => {
  it('removes one made here, contents and all', async () => {
    const dir = createPrivateDir(home, home, tmp)
    await writeFile(join(dir, 'Cookies'), 'x')
    expect(removePrivateDir(dir, tmp)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('removes nothing that is not one: another name, another place, a link, a file', async () => {
    const other = join(tmp, 'documents')
    await mkdir(other)
    expect(removePrivateDir(other, tmp)).toBe(false)
    expect(existsSync(other)).toBe(true)

    const elsewhere = await mkdtemp(join(root, 'orivon-private-'))
    expect(removePrivateDir(elsewhere, tmp)).toBe(false)
    expect(existsSync(elsewhere)).toBe(true)

    const target = join(root, 'precious')
    await mkdir(target)
    await symlink(target, join(tmp, 'orivon-private-abcdef'))
    expect(removePrivateDir(join(tmp, 'orivon-private-abcdef'), tmp)).toBe(false)
    expect(existsSync(target)).toBe(true)

    await writeFile(join(tmp, 'orivon-private-ghijkl'), 'file')
    expect(removePrivateDir(join(tmp, 'orivon-private-ghijkl'), tmp)).toBe(false)
    expect(removePrivateDir('/', tmp)).toBe(false)
  })
})

describe('removing a private directory after its process has ended', () => {
  it.skipIf(process.platform === 'win32')('removes it once the process is gone, with whatever was written to it meanwhile', async () => {
    const dir = createPrivateDir(home, home, tmp)
    await writeFile(join(dir, 'late-write'), 'Chromium writes after quit')
    const ended = spawnSync(process.execPath, ['-e', ''])
    expect(removeAfterExit(dir, ended.pid, tmp)).toBe(true)
    await vi.waitFor(() => { expect(existsSync(dir)).toBe(false) }, { timeout: 5000 })
  })

  it('names the directory and the process to the cleaner as arguments, never in the command text', () => {
    const dir = createPrivateDir(home, home, tmp)
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }))
    expect(removeAfterExit(dir, 4242, tmp, 'linux', spawn as never)).toBe(true)
    const [program, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean, stdio: string }]
    expect(program).toBe('/bin/sh')
    expect(args.slice(3)).toEqual(['4242', dir])
    expect(args[1]).not.toContain(dir)
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' })
  })

  it('does nothing for a directory that is not a private one made here, or on Windows, and reports it', () => {
    const spawn = vi.fn()
    const other = join(tmp, 'not-private')
    expect(removeAfterExit(other, 1, tmp, 'linux', spawn as never)).toBe(false)
    expect(removeAfterExit(join(root, 'orivon-private-abcdef'), 1, tmp, 'linux', spawn as never)).toBe(false)
    expect(removeAfterExit(join(tmp, 'orivon-private-abcdef'), 1, tmp, 'win32', spawn as never)).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a cleaner that could not be started, so the caller removes the directory itself', () => {
    const dir = createPrivateDir(home, home, tmp)
    const spawn = vi.fn(() => { throw new Error('no sh') })
    expect(removeAfterExit(dir, 1, tmp, 'linux', spawn as never)).toBe(false)
  })
})

describe('sweeping what a crash left', () => {
  const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)

  it('removes the directory of a session whose process is gone, and keeps that of one still running', async () => {
    const gone = createPrivateDir(home, home, tmp)
    const running = createPrivateDir(home, home, tmp)
    markPrivate(gone, 111)
    markPrivate(running, 222)

    const removed = sweepPrivateDirs({ tmp, isAlive: alive(222), uid: undefined })

    expect(removed).toEqual([gone.slice(tmp.length + 1)])
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(running)).toBe(true)
  })

  it('removes a directory whose pid was reused after a reboot, even though the probe says it is alive', async () => {
    const dir = createPrivateDir(home, home, tmp)
    // Marked in one boot (an arbitrary now/uptime pair)...
    markPrivate(dir, 111, 1_700_000_000_000, 3600)
    // ...swept in a later one: the same pid now belongs to something else,
    // and process.kill(pid, 0) -- alive(111) here -- cannot tell the difference.
    const removed = sweepPrivateDirs({ tmp, now: 1_700_100_000_000, uptimeSec: 60, isAlive: alive(111), uid: undefined })

    expect(removed).toEqual([dir.slice(tmp.length + 1)])
    expect(existsSync(dir)).toBe(false)
  })

  it('keeps a directory whose marker and the sweep agree on the boot, whatever the probe says', async () => {
    const dir = createPrivateDir(home, home, tmp)
    markPrivate(dir, 111, 1_700_000_000_000, 3600)

    const removed = sweepPrivateDirs({ tmp, now: 1_700_000_010_000, uptimeSec: 3610, isAlive: alive(111), uid: undefined })

    expect(removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('waits out a grace for a directory whose process has not written its marker yet, and removes it after', async () => {
    const dir = createPrivateDir(home, home, tmp)
    const now = Date.now()
    expect(sweepPrivateDirs({ tmp, now, isAlive: alive(), uid: undefined })).toEqual([])
    expect(existsSync(dir)).toBe(true)

    const old = new Date(now - GRACE_MS - 1000)
    await utimes(dir, old, old)
    expect(sweepPrivateDirs({ tmp, now, isAlive: alive(), uid: undefined })).toHaveLength(1)
    expect(existsSync(dir)).toBe(false)
  })

  it('leaves everything that is not a private session\'s directory', async () => {
    await mkdir(join(tmp, 'orivon-private-toolong1'))
    await mkdir(join(tmp, 'somebody-elses'))
    await writeFile(join(tmp, 'orivon-private-abcdef'), 'a file with the name')
    const removed = sweepPrivateDirs({ tmp, now: Date.now() + 10 * GRACE_MS, isAlive: alive(), uid: undefined })
    expect(removed).toEqual([])
    expect(existsSync(join(tmp, 'somebody-elses'))).toBe(true)
  })

  it('leaves a directory another user owns, and does not follow a link', async () => {
    const dir = createPrivateDir(home, home, tmp)
    markPrivate(dir, 1)
    if (process.getuid !== undefined) {
      expect(sweepPrivateDirs({ tmp, isAlive: alive(), uid: process.getuid() + 1 })).toEqual([])
      expect(existsSync(dir)).toBe(true)
    }
    const target = join(root, 'precious')
    await mkdir(target)
    await symlink(target, join(tmp, 'orivon-private-linkAB'))
    sweepPrivateDirs({ tmp, now: Date.now() + 10 * GRACE_MS, isAlive: alive(), uid: undefined })
    expect(existsSync(target)).toBe(true)
  })

  it('does not throw when there is no temp directory', () => {
    expect(sweepPrivateDirs({ tmp: join(root, 'no-such-dir'), uid: undefined })).toEqual([])
  })
})
