import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateRouteKinds, moveNymProfileToProxy, profileFolder } from '../kinds-migration.js'
import { RouteStore } from '../route-store.js'

const dirs: string[] = []
const userData = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-kinds-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function withNymFolder (dir: string): string {
  const from = profileFolder(dir, 'nym')
  mkdirSync(join(from, 'Local Storage'), { recursive: true })
  writeFileSync(join(from, 'Cookies'), 'a cookie')
  writeFileSync(join(from, 'Local Storage', 'leveldb'), 'a value')
  return from
}

describe('the folders of the two tunnel profiles', () => {
  it('are named after the session names under Partitions', () => {
    expect(profileFolder('/data', 'nym')).toBe(join('/data', 'Partitions', 'tunnel-profile'))
    expect(profileFolder('/data', 'socks5')).toBe(join('/data', 'Partitions', 'proxy-profile'))
  })
})

describe('moving the data of the websites that went through the proxy', () => {
  it('renames the folder with everything in it, so a cookie is where the proxy profile will look', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    expect(moveNymProfileToProxy(dir)).toBe('moved')
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(profileFolder(dir, 'socks5'), 'Cookies'), 'utf8')).toBe('a cookie')
    expect(readFileSync(join(profileFolder(dir, 'socks5'), 'Local Storage', 'leveldb'), 'utf8')).toBe('a value')
  })

  it('has nothing to move when no website was ever in the profile', () => {
    const dir = userData()
    expect(moveNymProfileToProxy(dir)).toBe('nothing')
    mkdirSync(join(dir, 'Partitions'))
    expect(moveNymProfileToProxy(dir)).toBe('nothing')
  })

  it('replaces an empty folder of the proxy profile, and moves nothing over one that holds anything', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    mkdirSync(profileFolder(dir, 'socks5'), { recursive: true })
    expect(moveNymProfileToProxy(dir)).toBe('moved')
    expect(existsSync(join(profileFolder(dir, 'socks5'), 'Cookies'))).toBe(true)

    const other = userData()
    const kept = withNymFolder(other)
    mkdirSync(profileFolder(other, 'socks5'), { recursive: true })
    writeFileSync(join(profileFolder(other, 'socks5'), 'Cookies'), 'newer')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(moveNymProfileToProxy(other)).toBe('conflict')
    error.mockRestore()
    expect(readFileSync(join(kept, 'Cookies'), 'utf8')).toBe('a cookie')
    expect(readFileSync(join(profileFolder(other, 'socks5'), 'Cookies'), 'utf8')).toBe('newer')
    expect(existsSync(from)).toBe(false)
  })
})

describe('recording which tunnel each origin uses', () => {
  const SITE = 'https://news.example'
  const fileWith = (dir: string): string => {
    const path = join(dir, 'routes.json')
    writeFileSync(path, JSON.stringify({ version: 1, profiles: 1, origins: [SITE], apart: [SITE] }))
    return path
  }

  it('moves the folder and the record of its storage together when the choice was the proxy', () => {
    const dir = userData()
    withNymFolder(dir)
    const path = fileWith(dir)
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    migrateRouteKinds(store, () => moveNymProfileToProxy(dir))
    expect(existsSync(profileFolder(dir, 'socks5'))).toBe(true)
    const again = new RouteStore(path)
    expect(again.stateOf(SITE)).toBe('socks5')
    expect(again.apart('socks5')).toEqual([SITE])
    expect(again.apart('nym')).toEqual([])
  })

  it('leaves the folder alone when the choice was Nym, and marks the file', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    const move = vi.fn(() => moveNymProfileToProxy(dir))
    const path = fileWith(dir)
    migrateRouteKinds(new RouteStore(path, { legacyKind: 'nym' }), move)
    expect(move).not.toHaveBeenCalled()
    expect(existsSync(from)).toBe(true)
    expect(new RouteStore(path).needsKinds()).toBe(false)
    expect(new RouteStore(path).stateOf(SITE)).toBe('nym')
  })

  it('keeps the record of storage in Nym\'s profile when the folder could not be moved, so the person can remove it', () => {
    const dir = userData()
    const path = fileWith(dir)
    migrateRouteKinds(new RouteStore(path, { legacyKind: 'socks5' }), () => 'conflict')
    const again = new RouteStore(path)
    expect(again.stateOf(SITE)).toBe('socks5')
    expect(again.apart('nym')).toEqual([SITE])
    expect(again.apart('socks5')).toEqual([])
  })

  it('does nothing when the choice could not be read, and nothing when the file is already marked', () => {
    const dir = userData()
    const path = fileWith(dir)
    const move = vi.fn((): 'nothing' => 'nothing')
    migrateRouteKinds(new RouteStore(path, { legacyKind: 'socks5' }), move, false)
    expect(move).not.toHaveBeenCalled()
    expect(new RouteStore(path).needsKinds()).toBe(true)
    migrateRouteKinds(new RouteStore(path, { legacyKind: 'socks5' }), move)
    const second = vi.fn((): 'nothing' => 'nothing')
    migrateRouteKinds(new RouteStore(path, { legacyKind: 'socks5' }), second)
    expect(second).not.toHaveBeenCalled()
  })

  it('never throws: a file that cannot be saved is tried again at the next start', () => {
    const dir = userData()
    const path = fileWith(dir)
    const store = new RouteStore(path, { legacyKind: 'nym' })
    store.stateOf(SITE)
    rmSync(path)
    mkdirSync(path)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { migrateRouteKinds(store, () => 'nothing') }).not.toThrow()
    error.mockRestore()
    expect(store.needsKinds()).toBe(true)
  })
})

describe('a rename that fails because something holds the folder open', () => {
  const SITE = 'https://news.example'
  const NYM_SITE = 'https://private.example'
  const busy = (): never => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }
  const fileWith = (dir: string): string => {
    const path = join(dir, 'routes.json')
    writeFileSync(path, JSON.stringify({ version: 1, profiles: 1, origins: [SITE], apart: [SITE] }))
    return path
  }
  const start = (dir: string, path: string, rename: (from: string, to: string) => void): RouteStore => {
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    migrateRouteKinds(store, () => moveNymProfileToProxy(dir, rename))
    return store
  }

  it('is reported as failed, leaving the folder where it was', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(moveNymProfileToProxy(dir, busy)).toBe('failed')
    error.mockRestore()
    expect(existsSync(from)).toBe(true)
  })

  it('leaves the file unmarked, so the next start tries again and moves the folder once the handle is gone', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    const path = fileWith(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    start(dir, path, busy)
    error.mockRestore()
    expect(new RouteStore(path, { legacyKind: 'socks5' }).needsKinds()).toBe(true)
    expect(existsSync(from)).toBe(true)

    const second = start(dir, path, renameSync)
    expect(second.needsKinds()).toBe(false)
    const again = new RouteStore(path)
    expect(again.stateOf(SITE)).toBe('socks5')
    expect(again.apart('socks5')).toEqual([SITE])
    expect(again.apart('nym')).toEqual([])
    expect(again.isForeignToNym(SITE)).toBe(false)
  })

  it('reads the origins with the legacy choice meanwhile, and never as Nym\'s own storage', () => {
    const dir = userData()
    withNymFolder(dir)
    const path = fileWith(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = start(dir, path, busy)
    error.mockRestore()
    expect(store.stateOf(SITE)).toBe('socks5')
    expect(store.isForeignToNym(SITE)).toBe(true)
  })

  it('keeps a Nym pick made while the move is pending across a restart', () => {
    const dir = userData()
    withNymFolder(dir)
    const path = fileWith(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = start(dir, path, busy)
    store.setEntry(NYM_SITE, 'nym')
    const next = new RouteStore(path, { legacyKind: 'socks5' })
    expect(next.stateOf(NYM_SITE)).toBe('nym')
    expect(next.stateOf(SITE)).toBe('socks5')
    error.mockRestore()
  })

  it('is given up after three starts: the file is marked and the storage left in Nym\'s profile is recorded as the proxy\'s', () => {
    const dir = userData()
    const from = withNymFolder(dir)
    const path = fileWith(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    start(dir, path, busy)
    expect(new RouteStore(path, { legacyKind: 'socks5' }).needsKinds()).toBe(true)
    start(dir, path, busy)
    expect(new RouteStore(path, { legacyKind: 'socks5' }).needsKinds()).toBe(true)
    start(dir, path, busy)
    error.mockRestore()
    const given = new RouteStore(path, { legacyKind: 'socks5' })
    expect(given.needsKinds()).toBe(false)
    expect(given.stateOf(SITE)).toBe('socks5')
    expect(given.apart('nym')).toEqual([SITE])
    expect(given.isForeignToNym(SITE)).toBe(true)
    expect(existsSync(from)).toBe(true)
    given.dropApart(SITE, 'nym')
    expect(new RouteStore(path).isForeignToNym(SITE)).toBe(false)
  })

  it('is not tried again for a folder that cannot be merged, and its storage is recorded as the proxy\'s at once', () => {
    const dir = userData()
    withNymFolder(dir)
    mkdirSync(profileFolder(dir, 'socks5'), { recursive: true })
    writeFileSync(join(profileFolder(dir, 'socks5'), 'Cookies'), 'newer')
    const path = fileWith(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = start(dir, path, renameSync)
    error.mockRestore()
    expect(store.needsKinds()).toBe(false)
    expect(store.isForeignToNym(SITE)).toBe(true)
  })
})
