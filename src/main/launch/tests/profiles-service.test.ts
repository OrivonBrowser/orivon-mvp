import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilesService } from '../profiles-service.js'
import { ProfileStore } from '../profile-store.js'
import { isPrivateDirName } from '../private-session.js'
import type { Runtime } from '../start-launch.js'

let root: string
let home: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-profiles-service-'))
  home = join(root, 'home')
  await mkdir(home, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function service (options: { isPrivate?: boolean, profileId?: string, inherit?: string[], alive?: boolean } = {}): { service: ProfilesService, spawn: ReturnType<typeof vi.fn>, store: ProfileStore, children: EventEmitter[] } {
  const store = new ProfileStore(home, () => 5, () => options.alive === true)
  const runtime: Runtime = {
    launch: options.isPrivate === true ? { kind: 'private', home, dir: null } : { kind: 'default', home, dir: home },
    dir: home,
    profiles: store,
    source: { execPath: '/x/orivon', appPath: '/x', packaged: true, appImage: undefined, env: {} },
    isPrivate: options.isPrivate ?? false,
    profileId: options.profileId ?? 'default',
    inherit: options.inherit ?? []
  }
  const children: EventEmitter[] = []
  const spawn = vi.fn(() => { const child = new EventEmitter(); children.push(child); return child })
  return { service: new ProfilesService(runtime, spawn as never), spawn, store, children }
}

describe('the profiles service', () => {
  it('lists the profiles, marks this one and the ones that are running', () => {
    const { service: s, store } = service({ alive: true })
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    store.markRunning(made.profile.id, process.pid)
    const rows = s.list()
    expect(rows.map((row) => [row.name, row.current, row.running])).toEqual([['Default', true, false], ['Work', false, true]])
  })

  it('shows the profile in the chrome only when there is more than one, and always in a private session', () => {
    const one = service()
    expect(one.service.look()).toEqual({ name: 'Default', color: 'blue', isPrivate: false, shown: false })
    one.service.create('Work', 'green')
    expect(one.service.look().shown).toBe(true)
    expect(service({ isPrivate: true }).service.look()).toEqual({ name: 'Private', color: 'purple', isPrivate: true, shown: true })
  })

  it('tells the shell when the profiles change, and not when a change was refused', () => {
    const { service: s } = service()
    const heard = vi.fn()
    s.onChange(heard)
    s.create('Work', 'green')
    s.create('', 'green')
    expect(heard).toHaveBeenCalledTimes(1)
    const [, work] = s.list()
    s.rename(work?.id ?? '', 'Office')
    s.setColor(work?.id ?? '', 'red')
    s.rename('default', '')
    expect(heard).toHaveBeenCalledTimes(3)
    s.remove(work?.id ?? '')
    expect(heard).toHaveBeenCalledTimes(4)
  })

  it('gives a new profile the light client\'s checkpoint and nothing else of the default\'s', async () => {
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'checkpoint.json'), '1')
    await writeFile(join(home, 'bookmarks.json'), '[]')
    const { service: s } = service()
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    expect(existsSync(join(home, 'profiles', made.profile.id, 'verifier', 'checkpoint.json'))).toBe(true)
    expect(existsSync(join(home, 'profiles', made.profile.id, 'bookmarks.json'))).toBe(false)
  })

  it('never deletes the profile it is', () => {
    const made = service()
    const created = made.service.create('Work', 'green')
    if (!created.ok) throw new Error('not created')
    const working = service({ profileId: created.profile.id })
    expect(working.service.remove(created.profile.id)).toEqual({ ok: false, reason: 'running' })
    expect(working.store.read(created.profile.id)).not.toBeNull()
  })

  it('starts another profile with its flag and the launch\'s data directory, and not the one it is', () => {
    const { service: s, spawn } = service({ inherit: ['--user-data-dir=/somewhere'] })
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')

    expect(s.open(made.profile.id)).toBe(true)
    expect(spawn).toHaveBeenLastCalledWith(expect.anything(), ['--user-data-dir=/somewhere', `--orivon-profile=${made.profile.id}`])
    expect(s.open('default')).toBe(false)
    expect(s.open('0123456789ab')).toBe(false)
    expect(s.open('../..')).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('can start the default profile from another one', () => {
    const made = service()
    const created = made.service.create('Work', 'green')
    if (!created.ok) throw new Error('not created')
    const { service: inWork, spawn } = service({ profileId: created.profile.id })
    expect(inWork.open('default')).toBe(true)
    expect(spawn).toHaveBeenCalledWith(expect.anything(), [])
  })

  it('starts a private session on a directory made for it, and removes it when the process is over', () => {
    const { service: s, spawn, children } = service()
    s.openPrivate()
    const args = (spawn.mock.calls[0] as [unknown, string[]])[1]
    expect(args[0]).toBe('--orivon-private')
    const dir = String(args[1]).replace('--orivon-private-dir=', '')
    expect(existsSync(dir)).toBe(true)
    children[0]?.emit('exit')
    expect(existsSync(dir)).toBe(false)
  })

  it('reports a profile it could not start instead of raising in the event that asked', () => {
    const made = service()
    const created = made.service.create('Work', 'green')
    if (!created.ok) throw new Error('not created')
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(() => { throw new Error('no such program') })
    const s = new ProfilesService({ launch: { kind: 'default', home, dir: home }, dir: home, profiles: made.store, source: { execPath: '/x', appPath: '/x', packaged: true, appImage: undefined, env: {} }, isPrivate: false, profileId: 'default', inherit: [] }, failing as never)

    expect(s.open(created.profile.id)).toBe(false)
    complaint.mockRestore()
  })

  it('says whether a private session was started', () => {
    const { service: s, children } = service()
    expect(s.openPrivate()).toBe(true)
    children[0]?.emit('exit')
  })

  it('removes the directory of a private session that could not be started', () => {
    const made = service()
    const failing = vi.fn(() => { throw new Error('no such program') })
    const s = new ProfilesService({ launch: { kind: 'default', home, dir: home }, dir: home, profiles: made.store, source: { execPath: '/x', appPath: '/x', packaged: true, appImage: undefined, env: {} }, isPrivate: false, profileId: 'default', inherit: [] }, failing as never)
    const count = (): number => readdirSync(tmpdir()).filter(isPrivateDirName).length
    const before = count()
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(s.openPrivate()).toBe(false)
    complaint.mockRestore()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(count()).toBe(before)
  })
})
