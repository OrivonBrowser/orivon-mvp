import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GRACE_MS, createPrivateDir, isPrivateDirName, markPrivate, removePrivateDir, sweepPrivateDirs } from '../private-session.js'

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

  it('begins with the settings of the profile that opened it and the light client\'s checkpoint, and nothing else', async () => {
    await writeFile(join(home, 'settings.json'), '{"version":1,"values":{"appearance.theme":"dark"}}')
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'checkpoint.json'), '{"c":1}')
    for (const secret of ['bookmarks.json', 'history.db', 'zoom.json', 'shortcuts.json', 'telemetry.json']) await writeFile(join(home, secret), 'private')
    await mkdir(join(home, 'identity'), { recursive: true })
    await writeFile(join(home, 'identity', 'seed.json'), '{"seed":"secret"}')
    await mkdir(join(home, 'grants'), { recursive: true })
    await writeFile(join(home, 'grants', 'ledger.json'), '{}')

    const dir = createPrivateDir(home, home, tmp)

    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toContain('dark')
    expect(await readFile(join(dir, 'verifier', 'checkpoint.json'), 'utf8')).toBe('{"c":1}')
    for (const name of ['bookmarks.json', 'history.db', 'zoom.json', 'shortcuts.json', 'telemetry.json', 'identity', 'grants']) expect(existsSync(join(dir, name)), name).toBe(false)
  })

  it('takes the settings from the opener and the checkpoint from home, when they are not the same profile', async () => {
    const opener = join(root, 'opener')
    await mkdir(opener, { recursive: true })
    await writeFile(join(opener, 'settings.json'), 'from the opener')
    await writeFile(join(home, 'settings.json'), 'from home')
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'c.json'), 'x')
    const dir = createPrivateDir(opener, home, tmp)
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('from the opener')
    expect(existsSync(join(dir, 'verifier', 'c.json'))).toBe(true)
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
