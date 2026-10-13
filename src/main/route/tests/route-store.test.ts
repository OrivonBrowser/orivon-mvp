import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('starts empty over a damaged file', () => {
    const path = fileIn()
    writeFileSync(path, '{ not json')
    expect(new RouteStore(path).origins()).toEqual([])
  })
})

describe('parseRoutes', () => {
  it('keeps only the entries that are canonical origins, because the file is user-writable', () => {
    const raw = JSON.stringify({ version: 1, origins: [APP, 'https://x.example/path', 7, null, 'https://y.example', 'javascript:alert(1)'] })
    expect([...parseRoutes(raw)]).toEqual([APP, 'https://y.example'])
  })

  it('reads nothing from a file of another version or shape', () => {
    expect(parseRoutes(JSON.stringify({ version: 2, origins: [APP] })).size).toBe(0)
    expect(parseRoutes(JSON.stringify({ version: 1, origins: APP })).size).toBe(0)
    expect(parseRoutes(JSON.stringify([APP])).size).toBe(0)
    expect(parseRoutes('null').size).toBe(0)
  })
})
