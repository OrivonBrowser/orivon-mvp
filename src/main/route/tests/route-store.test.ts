import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRoutes, RouteStore, RouteStoreError } from '../route-store.js'

const APP = 'https://torrent.example'
const dirs: string[] = []
const fileIn = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-routes-'))
  dirs.push(dir)
  return join(dir, 'routes.json')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('RouteStore', () => {
  it('has no app routed until the person turns one on', () => {
    const store = new RouteStore(null)
    expect(store.has(APP)).toBe(false)
    expect(store.origins()).toEqual([])
  })

  it('remembers a routed app across a restart, in a versioned file', () => {
    const path = fileIn()
    new RouteStore(path).setEntry(APP, 'nym')
    expect(new RouteStore(path).has(APP)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, profiles: 1, kinds: 1, origins: [APP], via: {}, off: [], apart: [], apartProxy: [], apartDirect: [] })
  })

  it('turns a route off, says whether anything changed, and tells listeners only when something did', () => {
    const store = new RouteStore(fileIn())
    const heard = vi.fn()
    store.onChange(heard)

    expect(store.setEntry(APP, 'nym')).toBe(true)
    expect(store.setEntry(APP, 'nym')).toBe(false)
    expect(store.setEntry(APP, undefined)).toBe(true)
    expect(store.setEntry(APP, undefined)).toBe(false)
    expect(heard.mock.calls).toEqual([[APP, 'nym', undefined], [APP, undefined, 'nym']])
  })

  it('stops telling a listener that unsubscribed', () => {
    const store = new RouteStore(null)
    const heard = vi.fn()
    store.onChange(heard)()
    store.setEntry(APP, 'nym')
    expect(heard).not.toHaveBeenCalled()
  })

  it('refuses an origin that is not canonical', () => {
    const store = new RouteStore(null)
    for (const bad of ['https://torrent.example/path', 'torrent.example', 'not an origin', 'file:///etc/passwd', '']) {
      expect(store.setEntry(bad, 'nym'), bad).toBe(false)
    }
    expect(store.origins()).toEqual([])
  })

  it('keeps a plain-http or loopback origin out of the file', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry('http://127.0.0.1:8080', 'nym')
    expect(store.has('http://127.0.0.1:8080')).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).origins).toEqual([])
  })

  it('starts empty, and not unreadable, when there is no file yet', () => {
    const store = new RouteStore(fileIn())
    expect(store.origins()).toEqual([])
    expect(store.unreadable()).toBe(false)
  })
})

describe('a store held to one tunnel', () => {
  it('refuses an off entry and changes nothing, and still takes an on entry and its removal', () => {
    const store = new RouteStore(null, { onlyKind: 'nym' })
    const heard = vi.fn()
    store.onChange(heard)
    expect(() => store.setEntry(APP, 'off')).toThrow(RouteStoreError)
    expect(() => store.setEntry(APP, 'socks5')).toThrow(/Nym/)
    expect(store.stateOf(APP)).toBeUndefined()
    expect(store.entries()).toEqual([])
    expect(heard).not.toHaveBeenCalled()
    expect(store.setEntry(APP, 'nym')).toBe(true)
    expect(store.setEntry(APP, undefined)).toBe(true)
    expect(store.stateOf(APP)).toBeUndefined()
  })

  it('is an ordinary store without the option', () => {
    expect(new RouteStore(null).setEntry(APP, 'off')).toBe(true)
  })
})

describe('a routes file that cannot be trusted', () => {
  const damaged: Array<[string, (path: string) => void]> = [
    ['is not JSON', (path) => { writeFileSync(path, '{ not json') }],
    ['is of another version', (path) => { writeFileSync(path, JSON.stringify({ version: 2, origins: [APP] })) }],
    ['is of another shape', (path) => { writeFileSync(path, JSON.stringify({ version: 1, origins: APP })) }],
    ['cannot be read as a file', (path) => { mkdirSync(path) }]
  ]

  for (const [what, damage] of damaged) {
    it(`reports itself unreadable when it ${what}, and lists no app`, () => {
      const path = fileIn()
      damage(path)
      const store = new RouteStore(path)
      expect(store.unreadable()).toBe(true)
      expect(store.origins()).toEqual([])
      expect(store.has(APP)).toBe(false)
    })
  }

  it('keeps a copy of the file aside and leaves the file itself where it was', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    expect(new RouteStore(path).unreadable()).toBe(true)
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{ not json')
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('is unreadable again at the next start, because nothing replaced the file', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    new RouteStore(path).origins()
    expect(new RouteStore(path).unreadable()).toBe(true)
  })

  it('never writes over the file, and refuses to switch an app off, because the apps that were routed are not known', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    const store = new RouteStore(path)
    const heard = vi.fn()
    store.onChange(heard)

    expect(store.setEntry(APP, 'nym'), 'on changes nothing the hub does not already do').toBe(false)
    expect(() => store.setEntry(APP, undefined)).toThrow(/could not be read/)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(heard).not.toHaveBeenCalled()
  })

  it('is never unreadable in a private session', () => {
    expect(new RouteStore(null).unreadable()).toBe(false)
  })
})

describe('saving the routed apps', () => {
  const unwritable = (): string => join(fileIn(), 'missing-directory', 'routes.json')

  it('reports a write that failed, and nothing changes: the app is not shown as routed when it is not saved', () => {
    const store = new RouteStore(unwritable())
    const heard = vi.fn()
    store.onChange(heard)

    expect(() => store.setEntry(APP, 'nym')).toThrow(/could not be saved/)

    expect(store.has(APP)).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })

  it('reports a failed switch-off the same way, and the app stays routed', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry(APP, 'nym')
    rmSync(path)
    mkdirSync(path)

    expect(() => store.setEntry(APP, undefined)).toThrow(/could not be saved/)

    expect(store.has(APP)).toBe(true)
  })

  it('leaves no temporary file behind', () => {
    const path = fileIn()
    new RouteStore(path).setEntry(APP, 'nym')
    expect(readdirSync(join(path, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})

describe('website origins in the store', () => {
  const SITE = 'https://news.example'

  it('keeps an on and an off entry for any web origin, beside the apps', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry(SITE, 'nym')
    store.setEntry('https://other.example', 'off')
    store.setEntry(APP, 'nym')
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.stateOf('https://other.example')).toBe('off')
    expect(store.stateOf('https://none.example')).toBeUndefined()
    expect(store.origins().sort()).toEqual([APP, SITE].sort())
    expect(store.entries()).toHaveLength(3)

    const again = new RouteStore(path)
    expect(again.stateOf(SITE)).toBe('nym')
    expect(again.stateOf('https://other.example')).toBe('off')
  })

  it('tells listeners the entry and the one it replaced, and nothing for a repeat', () => {
    const store = new RouteStore(null)
    const heard = vi.fn()
    store.onChange(heard)
    expect(store.setEntry(SITE, 'nym')).toBe(true)
    expect(store.setEntry(SITE, 'nym')).toBe(false)
    expect(store.setEntry(SITE, 'off')).toBe(true)
    expect(store.setEntry(SITE, undefined)).toBe(true)
    expect(store.setEntry(SITE, undefined)).toBe(false)
    expect(heard.mock.calls).toEqual([[SITE, 'nym', undefined], [SITE, 'off', 'nym'], [SITE, undefined, 'off']])
  })

  it('keeps a record of the websites that have storage in each profile, apart from their entry', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry(SITE, 'nym')
    store.keepApart(SITE, 'nym')
    store.setEntry(SITE, undefined)
    expect(store.isApart(SITE, 'nym')).toBe(true)
    expect(store.isApart(SITE, 'direct')).toBe(false)
    expect(new RouteStore(path).apart('nym')).toEqual([SITE])
    store.keepApart(SITE, 'direct')
    expect(new RouteStore(path).apart('direct')).toEqual([SITE])
    expect(store.isApartAnywhere(SITE)).toBe(true)
    store.dropApart(SITE, 'nym')
    store.dropApart(SITE, 'direct')
    expect(new RouteStore(path).apart('nym')).toEqual([])
    expect(store.isApartAnywhere(SITE)).toBe(false)
  })

  it('migrates a file written before the profiles: the old sessions are named, then the record moves to the profile each entry names', () => {
    const path = fileIn()
    const kept = 'https://kept.example'
    const gone = 'https://gone.example'
    writeFileSync(path, JSON.stringify({ version: 1, origins: [SITE, APP], off: [kept], apart: [SITE, kept, gone] }))
    const store = new RouteStore(path)
    expect(store.needsMigration()).toBe(true)
    expect(store.legacySites().sort()).toEqual([SITE, kept, gone].sort())
    store.migrateToProfiles()
    expect(store.needsMigration()).toBe(false)
    expect(store.legacySites()).toEqual([])
    expect(store.apart('nym')).toEqual([SITE])
    expect(store.apart('direct')).toEqual([kept])
    expect(store.stateOf(SITE)).toBe('nym')
    expect(new RouteStore(path).needsMigration()).toBe(false)
  })

  it('has nothing to migrate for a new profile, a private session or a file already written with profiles', () => {
    expect(new RouteStore(null).needsMigration()).toBe(false)
    expect(new RouteStore(fileIn()).needsMigration()).toBe(false)
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry(SITE, 'nym')
    expect(new RouteStore(path).needsMigration()).toBe(false)
  })

  it('refuses an entry for an origin that is not canonical', () => {
    const store = new RouteStore(null)
    expect(store.setEntry('https://news.example/path', 'off')).toBe(false)
    expect(store.entries()).toEqual([])
  })

  it('keeps an on entry when an origin is listed both ways, and ignores an entry that is not an origin', () => {
    const raw = JSON.stringify({ version: 1, origins: [SITE], off: [SITE, 'nonsense', 4], apart: ['https://x.example'] })
    const parsed = parseRoutes(raw)
    expect([...(parsed?.entries ?? [])]).toEqual([[SITE, 'nym']])
    expect([...(parsed?.apart.nym ?? [])]).toEqual(['https://x.example'])
    expect(parsed?.profiles).toBe(false)
  })

  it('reads a file written before off and apart existed', () => {
    const parsed = parseRoutes(JSON.stringify({ version: 1, origins: [APP] }))
    expect([...(parsed?.entries ?? [])]).toEqual([[APP, 'nym']])
    expect(parsed?.apart.nym.size).toBe(0)
  })

  it('treats a file whose off or apart is not a list as not a routes file', () => {
    expect(parseRoutes(JSON.stringify({ version: 1, origins: [], off: SITE }))).toBeUndefined()
    expect(parseRoutes(JSON.stringify({ version: 1, origins: [], apart: {} }))).toBeUndefined()
  })

  it('keeps a plain-http website out of the file, and in memory for the run', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry('http://news.example', 'nym')
    store.keepApart('http://news.example', 'nym')
    expect(store.stateOf('http://news.example')).toBe('nym')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ origins: [], via: {}, apart: [], apartProxy: [], apartDirect: [] })
  })

  it('does not write over an unreadable file when the record of storage changes', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    const store = new RouteStore(path)
    store.keepApart(SITE, 'nym')
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(() => store.setEntry(SITE, 'off')).toThrow(/could not be read/)
  })
})

describe('parseRoutes', () => {
  it('keeps only the entries that are canonical origins, because the file is user-writable', () => {
    const raw = JSON.stringify({ version: 1, origins: [APP, 'https://x.example/path', 7, null, 'https://y.example', 'javascript:alert(1)'] })
    expect([...(parseRoutes(raw)?.entries.keys() ?? [])]).toEqual([APP, 'https://y.example'])
  })

  it('reads nothing from a file of another version or shape', () => {
    expect(parseRoutes(JSON.stringify({ version: 2, origins: [APP] }))).toBeUndefined()
    expect(parseRoutes(JSON.stringify({ version: 1, origins: APP }))).toBeUndefined()
    expect(parseRoutes(JSON.stringify([APP]))).toBeUndefined()
    expect(parseRoutes('null')).toBeUndefined()
    expect(parseRoutes('{ not json')).toBeUndefined()
  })
})

describe('each origin names its own tunnel', () => {
  const SITE = 'https://news.example'
  const OTHER = 'https://other.example'

  it('keeps Nym for one origin and the proxy for another across a restart, and lists both as going through a tunnel for an older build', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.setEntry(SITE, 'nym')
    store.setEntry(OTHER, 'socks5')
    store.setEntry(APP, 'off')
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toEqual({ version: 1, profiles: 1, kinds: 1, origins: [SITE, OTHER], via: { [OTHER]: 'socks5' }, off: [APP], apart: [], apartProxy: [], apartDirect: [] })
    const again = new RouteStore(path)
    expect([again.stateOf(SITE), again.stateOf(OTHER), again.stateOf(APP)]).toEqual(['nym', 'socks5', 'off'])
    expect(again.has(OTHER)).toBe(true)
    expect(again.has(APP)).toBe(false)
    expect(again.origins().sort()).toEqual([SITE, OTHER].sort())
  })

  it('tells listeners when an origin moves from one tunnel to the other', () => {
    const store = new RouteStore(null)
    const heard = vi.fn()
    store.setEntry(SITE, 'nym')
    store.onChange(heard)
    expect(store.setEntry(SITE, 'socks5')).toBe(true)
    expect(heard.mock.calls).toEqual([[SITE, 'socks5', 'nym']])
  })

  it('keeps a record of the websites with storage in the proxy profile, apart from the other two', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.keepApart(SITE, 'socks5')
    expect(store.isApart(SITE, 'socks5')).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(false)
    expect(store.isApartAnywhere(SITE)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).apartProxy).toEqual([SITE])
    expect(new RouteStore(path).apart('socks5')).toEqual([SITE])
  })

  it('reads an origin as going through Nym unless via names the proxy for it, and ignores a via for an origin not listed', () => {
    const raw = `{ "version": 1, "profiles": 1, "kinds": 1, "origins": ["${SITE}", "${OTHER}"], "via": { "${OTHER}": "socks5", "${SITE}": "tor", "https://unlisted.example": "socks5", "__proto__": "socks5" } }`
    const parsed = parseRoutes(raw)
    expect([...(parsed?.entries ?? [])]).toEqual([[SITE, 'nym'], [OTHER, 'socks5']])
  })

  it('gives an origin an unmarked file lists the tunnel that was the choice, and an origin off stays off', () => {
    const raw = JSON.stringify({ version: 1, profiles: 1, origins: [SITE], off: [OTHER] })
    expect([...(parseRoutes(raw, 'socks5')?.entries ?? [])]).toEqual([[OTHER, 'off'], [SITE, 'socks5']])
    expect(parseRoutes(raw, 'socks5')?.kinds).toBe(false)
    expect(parseRoutes(raw)?.entries.get(SITE)).toBe('nym')
  })

  it('does not apply via to a file without the marker: a socks5 writer that dropped the marker is read at the choice it was', () => {
    const raw = JSON.stringify({ version: 1, profiles: 1, origins: [SITE], via: { [SITE]: 'socks5' } })
    expect(parseRoutes(raw, 'nym')?.entries.get(SITE)).toBe('nym')
  })
})

describe('migrating a file written before each origin named its own tunnel', () => {
  const SITE = 'https://news.example'
  const KEPT = 'https://kept.example'
  const written = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))
  const unmarked = (path: string): void => { writeFileSync(path, JSON.stringify({ version: 1, profiles: 1, origins: [SITE, APP], off: [KEPT], apart: [SITE], apartDirect: [KEPT] })) }

  it('is needed for an unmarked file only, and never for no file, a private session or a marked file', () => {
    const path = fileIn()
    unmarked(path)
    expect(new RouteStore(path).needsKinds()).toBe(true)
    expect(new RouteStore(fileIn()).needsKinds()).toBe(false)
    expect(new RouteStore(null).needsKinds()).toBe(false)
    new RouteStore(path).migrateToKinds(true)
    expect(new RouteStore(path).needsKinds()).toBe(false)
  })

  it('leaves everything where it was when the choice was Nym, and marks the file', () => {
    const path = fileIn()
    unmarked(path)
    const store = new RouteStore(path, { legacyKind: 'nym' })
    expect(store.stateOf(SITE)).toBe('nym')
    store.migrateToKinds(true)
    expect(written(path)).toEqual({ version: 1, profiles: 1, kinds: 1, origins: [SITE, APP], via: {}, off: [KEPT], apart: [SITE], apartProxy: [], apartDirect: [KEPT] })
  })

  it('puts every origin on the proxy and moves the record of storage with its folder when the choice was the proxy', () => {
    const path = fileIn()
    unmarked(path)
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    expect(store.stateOf(SITE)).toBe('socks5')
    store.migrateToKinds(true)
    expect(written(path)).toEqual({ version: 1, profiles: 1, kinds: 1, origins: [SITE, APP], via: { [SITE]: 'socks5', [APP]: 'socks5' }, off: [KEPT], apart: [], apartProxy: [SITE], apartDirect: [KEPT] })
    const again = new RouteStore(path, { legacyKind: 'nym' })
    expect([again.stateOf(SITE), again.stateOf(APP)]).toEqual(['socks5', 'socks5'])
    expect(again.apart('socks5')).toEqual([SITE])
  })

  it('keeps the record of storage in the Nym profile when its folder could not be moved, so the person can remove it', () => {
    const path = fileIn()
    unmarked(path)
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    store.migrateToKinds(false)
    expect(store.apart('nym')).toEqual([SITE])
    expect(store.apart('socks5')).toEqual([])
    expect(store.stateOf(SITE)).toBe('socks5')
  })

  it('is not run again once the file is marked, whatever the choice is now', () => {
    const path = fileIn()
    unmarked(path)
    new RouteStore(path, { legacyKind: 'nym' }).migrateToKinds(true)
    const later = new RouteStore(path, { legacyKind: 'socks5' })
    expect(later.stateOf(SITE)).toBe('nym')
    later.migrateToKinds(true)
    expect(later.stateOf(SITE)).toBe('nym')
  })

  it('reports a save that failed and is run again at the next start', () => {
    const path = fileIn()
    unmarked(path)
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    store.stateOf(SITE)
    rmSync(path)
    mkdirSync(path)
    expect(() => store.migrateToKinds(true)).toThrow(/could not be saved/)
    expect(store.needsKinds()).toBe(true)
  })

  it('runs after the migration to profiles for a file older than both, sending each website\'s record to the profile of its tunnel', () => {
    const path = fileIn()
    writeFileSync(path, JSON.stringify({ version: 1, origins: [SITE], off: [KEPT], apart: [SITE, KEPT] }))
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    store.migrateToKinds(true)
    store.migrateToProfiles()
    expect(store.apart('socks5')).toEqual([SITE])
    expect(store.apart('direct')).toEqual([KEPT])
    expect(store.apart('nym')).toEqual([])
    expect(store.needsKinds()).toBe(false)
  })

  it('does nothing for an unreadable file', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    const store = new RouteStore(path, { legacyKind: 'socks5' })
    expect(store.needsKinds()).toBe(false)
    store.migrateToKinds(true)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})
