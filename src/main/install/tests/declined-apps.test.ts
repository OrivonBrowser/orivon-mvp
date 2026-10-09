import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeclinedApps, MAX_DECLINED_APPS } from '../declined-apps.js'

const A = 'https://abc.ipfs.orivon'
const B = 'https://def.ipfs.orivon'

function file (): string {
  return join(mkdtempSync(join(tmpdir(), 'declined-apps-')), 'declined-apps.json')
}

describe('DeclinedApps', () => {
  it('remembers an origin across a restart, and forgets it when asked to', () => {
    const path = file()
    const first = new DeclinedApps(path)
    expect(first.add(A)).toBe(true)
    expect(new DeclinedApps(path).has(A)).toBe(true)
    expect(new DeclinedApps(path).list()).toEqual([A])
    expect(first.remove(A)).toBe(true)
    expect(new DeclinedApps(path).has(A)).toBe(false)
    expect(first.remove(A)).toBe(false)
  })

  it('lists origins in order, and keeps none for a private session on disk', () => {
    const priv = new DeclinedApps()
    priv.add(B)
    priv.add(A)
    expect(priv.list()).toEqual([A, B])
  })

  it('takes only an origin, never a path or another string', () => {
    const apps = new DeclinedApps(file())
    for (const bad of ['', 'abc', `${A}/page`, 'file:///etc/passwd', 'https://']) expect(apps.add(bad), bad).toBe(false)
    expect(apps.list()).toEqual([])
  })

  it('reads a damaged or foreign file as an empty record, and drops entries that are not origins', () => {
    const path = file()
    writeFileSync(path, '{ not json')
    expect(new DeclinedApps(path).list()).toEqual([])
    writeFileSync(path, JSON.stringify({ version: 2, origins: [A] }))
    expect(new DeclinedApps(path).list()).toEqual([])
    writeFileSync(path, JSON.stringify({ version: 1, origins: [A, 7, `${B}/x`, 'nope'] }))
    expect(new DeclinedApps(path).list()).toEqual([A])
  })

  it('refuses a new origin past its bound, but keeps one it already holds', () => {
    const apps = new DeclinedApps()
    for (let i = 0; i < MAX_DECLINED_APPS; i += 1) apps.add(`https://site${String(i)}.ipfs.orivon`)
    expect(apps.add(A)).toBe(false)
    expect(apps.add('https://site0.ipfs.orivon')).toBe(true)
  })

  it('writes the file atomically in its own shape', () => {
    const path = file()
    new DeclinedApps(path).add(A)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, origins: [A] })
  })
})
