import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRoutes, RouteStore } from '../route-store.js'

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
    new RouteStore(path).set(APP, true)
    expect(new RouteStore(path).has(APP)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, origins: [APP] })
  })

  it('turns a route off, says whether anything changed, and tells listeners only when something did', () => {
    const store = new RouteStore(fileIn())
    const heard = vi.fn()
    store.onChange(heard)

    expect(store.set(APP, true)).toBe(true)
    expect(store.set(APP, true)).toBe(false)
    expect(store.set(APP, false)).toBe(true)
    expect(store.set(APP, false)).toBe(false)
    expect(heard.mock.calls).toEqual([[APP, true], [APP, false]])
  })

  it('stops telling a listener that unsubscribed', () => {
    const store = new RouteStore(null)
    const heard = vi.fn()
    store.onChange(heard)()
    store.set(APP, true)
    expect(heard).not.toHaveBeenCalled()
  })

  it('refuses an origin that is not canonical', () => {
    const store = new RouteStore(null)
    for (const bad of ['https://torrent.example/path', 'torrent.example', 'not an origin', 'file:///etc/passwd', '']) {
      expect(store.set(bad, true), bad).toBe(false)
    }
    expect(store.origins()).toEqual([])
  })

  it('keeps a plain-http or loopback origin out of the file', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.set('http://127.0.0.1:8080', true)
    expect(store.has('http://127.0.0.1:8080')).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).origins).toEqual([])
  })

  it('starts empty, and not unreadable, when there is no file yet', () => {
    const store = new RouteStore(fileIn())
    expect(store.origins()).toEqual([])
    expect(store.unreadable()).toBe(false)
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

    expect(store.set(APP, true), 'on changes nothing the hub does not already do').toBe(false)
    expect(() => store.set(APP, false)).toThrow(/could not be read/)
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

    expect(() => store.set(APP, true)).toThrow(/could not be saved/)

    expect(store.has(APP)).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })

  it('reports a failed switch-off the same way, and the app stays routed', () => {
    const path = fileIn()
    const store = new RouteStore(path)
    store.set(APP, true)
    rmSync(path)
    mkdirSync(path)

    expect(() => store.set(APP, false)).toThrow(/could not be saved/)

    expect(store.has(APP)).toBe(true)
  })

  it('leaves no temporary file behind', () => {
    const path = fileIn()
    new RouteStore(path).set(APP, true)
    expect(readdirSync(join(path, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})

describe('parseRoutes', () => {
  it('keeps only the entries that are canonical origins, because the file is user-writable', () => {
    const raw = JSON.stringify({ version: 1, origins: [APP, 'https://x.example/path', 7, null, 'https://y.example', 'javascript:alert(1)'] })
    expect([...(parseRoutes(raw) ?? [])]).toEqual([APP, 'https://y.example'])
  })

  it('reads nothing from a file of another version or shape', () => {
    expect(parseRoutes(JSON.stringify({ version: 2, origins: [APP] }))).toBeUndefined()
    expect(parseRoutes(JSON.stringify({ version: 1, origins: APP }))).toBeUndefined()
    expect(parseRoutes(JSON.stringify([APP]))).toBeUndefined()
    expect(parseRoutes('null')).toBeUndefined()
    expect(parseRoutes('{ not json')).toBeUndefined()
  })
})
