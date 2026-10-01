import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_NAME_LENGTH, PROFILE_COLORS, ProfileStore, cleanName } from '../profile-store.js'

// Lets one test make the next writeFileSync call land a partial, garbled
// write and then throw, simulating a process that dies mid-write. `fsGate`
// is declared through vi.hoisted because vi.mock's factory runs before the
// rest of this file. writeFileAtomic (atomic-write.ts, which profile-store.ts
// writes through) calls writeFileSync(fd, text) on its own already-open temp
// file, so the garbage lands there, never on the real profile.json -- this is
// what proves a failed write leaves the previous file intact rather than
// truncated.
const fsGate = vi.hoisted(() => ({ failNextWith: null as Error | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const failure = fsGate.failNextWith
      if (failure !== null) {
        fsGate.failNextWith = null
        actual.writeFileSync(args[0], 'CORRUPTED-PARTIAL-WRITE')
        throw failure
      }
      return actual.writeFileSync(...args)
    }
  }
})

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'orivon-profiles-')) })
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  fsGate.failNextWith = null
})

const store = (alive: (pid: number) => boolean = () => false): ProfileStore => new ProfileStore(home, () => 1_000, alive)

describe('the profile list', () => {
  it('has the default profile, in the browser\'s own directory, before any is made', () => {
    expect(store().list()).toEqual([{ id: 'default', name: 'Default', color: 'blue', created: 0 }])
    expect(store().dirOf('default')).toBe(home)
  })

  it('has the others after it, in the order they were made', () => {
    let clock = 0
    const s = new ProfileStore(home, () => (clock += 10), () => false)
    const first = s.create('Work', 'green')
    const second = s.create('Family', 'orange')
    if (!first.ok || !second.ok) throw new Error('not created')
    expect(s.list().map((profile) => profile.name)).toEqual(['Default', 'Work', 'Family'])
  })

  it('ignores a directory that is not a profile: a file, a name no profile has, or one with no profile.json', async () => {
    await mkdir(join(home, 'profiles', 'not-an-id'), { recursive: true })
    await mkdir(join(home, 'profiles', '0123456789ab'), { recursive: true })
    await writeFile(join(home, 'profiles', 'stray-file'), 'x')
    expect(store().list().map((profile) => profile.id)).toEqual(['default'])
  })

  it('reads a damaged profile file as a profile with no name of its own', async () => {
    await mkdir(join(home, 'profiles', '0123456789ab'), { recursive: true })
    await writeFile(join(home, 'profiles', '0123456789ab', 'profile.json'), '{not json')
    expect(store().list()[1]).toMatchObject({ id: '0123456789ab', name: 'Profile', color: 'blue' })
  })
})

describe('making a profile', () => {
  it('makes a directory of its own with the name and colour in it, and returns the profile', async () => {
    const result = store().create('  Work  ', 'purple')
    if (!result.ok) throw new Error('not created')
    expect(result.profile).toMatchObject({ name: 'Work', color: 'purple', created: 1000 })
    expect(result.profile.id).toMatch(/^[0-9a-f]{12}$/)
    const written = JSON.parse(await readFile(join(home, 'profiles', result.profile.id, 'profile.json'), 'utf8')) as Record<string, unknown>
    expect(written).toEqual({ version: 1, name: 'Work', color: 'purple', created: 1000 })
  })

  it('copies in only the public data it is asked to, from the default profile', async () => {
    await mkdir(join(home, 'verifier'), { recursive: true })
    await writeFile(join(home, 'verifier', 'checkpoint.json'), '{"c":1}')
    await writeFile(join(home, 'verifier', 'ipns-sequences.json'), '{"k51visited":7}')
    await writeFile(join(home, 'bookmarks.json'), '[]')
    await writeFile(join(home, 'history.db'), 'private')
    const result = store().create('Work', 'blue', true)
    if (!result.ok) throw new Error('not created')
    const dir = join(home, 'profiles', result.profile.id)
    expect(await readFile(join(dir, 'verifier', 'checkpoint.json'), 'utf8')).toBe('{"c":1}')
    expect(existsSync(join(dir, 'bookmarks.json'))).toBe(false)
    expect(existsSync(join(dir, 'history.db'))).toBe(false)
    expect(existsSync(join(dir, 'verifier', 'ipns-sequences.json'))).toBe(false)
  })

  it('refuses a name or colour it cannot keep, and makes nothing', () => {
    const s = store()
    for (const bad of ['', '   ', 'x'.repeat(MAX_NAME_LENGTH + 1), 'line\nbreak', 'nul\u0000', 5, null]) expect(s.create(bad, 'blue'), String(bad)).toEqual({ ok: false, reason: 'invalid-name' })
    expect(s.create('Work', 'chartreuse')).toEqual({ ok: false, reason: 'invalid-color' })
    expect(s.create('Work', 3)).toEqual({ ok: false, reason: 'invalid-color' })
    expect(s.list()).toHaveLength(1)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('knows every colour it offers', () => {
    for (const color of PROFILE_COLORS) expect(store().create('X', color).ok).toBe(true)
  })
})

describe('changing a profile', () => {
  it('renames and recolours one, the default included', () => {
    const s = store()
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    expect(s.rename(made.profile.id, 'Office')).toEqual({ ok: true })
    expect(s.setColor(made.profile.id, 'red')).toEqual({ ok: true })
    expect(s.read(made.profile.id)).toMatchObject({ name: 'Office', color: 'red', created: 1000 })

    expect(s.rename('default', 'Me')).toEqual({ ok: true })
    expect(s.list()[0]).toMatchObject({ id: 'default', name: 'Me' })
  })

  it('refuses a bad name, colour or id, and changes nothing', () => {
    const s = store()
    expect(s.rename('default', '')).toEqual({ ok: false, reason: 'invalid-name' })
    expect(s.setColor('default', 'plaid')).toEqual({ ok: false, reason: 'invalid-color' })
    expect(s.rename('../../etc', 'x')).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(s.rename('0123456789ab', 'x')).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(s.list()[0]?.name).toBe('Default')
  })

  it('a write that fails leaves the previously persisted profile intact, not truncated', () => {
    const s = store()
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')

    fsGate.failNextWith = new Error('ENOSPC: no space left on device')
    expect(s.rename(made.profile.id, 'Renamed')).toEqual({ ok: false, reason: 'failed' })

    expect(s.read(made.profile.id)).toMatchObject({ name: 'Work', color: 'green' })
  })
})

describe('deleting a profile', () => {
  it('removes its directory and everything in it, and nothing else', async () => {
    const s = store()
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    const dir = join(home, 'profiles', made.profile.id)
    await writeFile(join(dir, 'bookmarks.json'), '[]')
    await writeFile(join(home, 'bookmarks.json'), '[1]')

    expect(s.remove(made.profile.id)).toEqual({ ok: true })

    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(home, 'profiles', `.deleting-${made.profile.id}`))).toBe(false)
    expect(await readFile(join(home, 'bookmarks.json'), 'utf8')).toBe('[1]')
    expect(s.list()).toHaveLength(1)
  })

  it('never deletes the default profile, one that does not exist, or an id that names a path', () => {
    const s = store()
    expect(s.remove('default')).toEqual({ ok: false, reason: 'default-profile' })
    expect(s.remove('0123456789ab')).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(s.remove('../..')).toEqual({ ok: false, reason: 'unknown-profile' })
    expect(existsSync(home)).toBe(true)
  })

  it('never deletes a profile that is running, and does once the process is gone', () => {
    let alive = true
    const s = store(() => alive)
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    s.markRunning(made.profile.id, 4242)
    expect(s.isRunning(made.profile.id)).toBe(true)
    expect(s.remove(made.profile.id)).toEqual({ ok: false, reason: 'running' })
    alive = false
    expect(s.isRunning(made.profile.id)).toBe(false)
    expect(s.remove(made.profile.id)).toEqual({ ok: true })
  })

  it('does not follow a link out of the profiles directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'orivon-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'keep')
    await mkdir(join(home, 'profiles'), { recursive: true })
    await symlink(outside, join(home, 'profiles', '0123456789ab'))
    store().remove('0123456789ab')
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
    await rm(outside, { recursive: true, force: true })
  })
})

describe('what a failed deletion leaves', () => {
  it('is removed by the sweep, and a profile beside it is not', async () => {
    const s = store()
    const kept = s.create('Kept', 'green')
    if (!kept.ok) throw new Error('not created')
    const left = join(home, 'profiles', '.deleting-0123456789ab')
    await mkdir(left, { recursive: true })
    await writeFile(join(left, 'bookmarks.json'), 'what was deleted')

    s.sweepDeleted()

    expect(existsSync(left)).toBe(false)
    expect(s.read(kept.profile.id)).not.toBeNull()
  })

  it('is nothing to do when there is no profiles directory', () => {
    expect(() => { store().sweepDeleted() }).not.toThrow()
  })
})

describe('the running marker', () => {
  it('is written and cleared, and a profile with none is not running', () => {
    const s = store(() => true)
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    expect(s.isRunning(made.profile.id)).toBe(false)
    s.markRunning(made.profile.id, 7)
    expect(s.isRunning(made.profile.id)).toBe(true)
    s.clearRunning(made.profile.id)
    expect(s.isRunning(made.profile.id)).toBe(false)
  })

  it('is not written for an id that is not a profile', () => {
    const s = store(() => true)
    // A name of this run's own beside the home, so a stray file in the shared temp directory cannot fail it.
    const escaping = `../${basename(home)}-escaped`
    s.markRunning(escaping, 7)
    expect(s.isRunning(escaping)).toBe(false)
    expect(existsSync(join(home, escaping))).toBe(false)
  })

  it('is not running after a reboot, even if the OS has already reused the pid (process.kill(pid, 0) alone cannot tell)', () => {
    let uptimeSec = 3600
    const s = new ProfileStore(home, () => 1_700_000_000_000, () => true, () => uptimeSec)
    const made = s.create('Work', 'green')
    if (!made.ok) throw new Error('not created')
    s.markRunning(made.profile.id, 4242)
    expect(s.isRunning(made.profile.id)).toBe(true)

    uptimeSec = 60 // a reboot since the marker was written
    expect(s.isRunning(made.profile.id)).toBe(false)
    expect(s.remove(made.profile.id)).toEqual({ ok: true })
  })
})

describe('cleanName', () => {
  it('keeps a name as it is written, trimmed', () => {
    expect(cleanName('  Trabajo — 私用 ')).toBe('Trabajo — 私用')
  })
})
