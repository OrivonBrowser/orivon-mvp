import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

  it('drops the oldest origin to make room past its bound, so the newest refusal is always kept', () => {
    const path = file()
    // A record already at its bound, as a profile that has refused that many apps would hold it.
    writeFileSync(path, JSON.stringify({ version: 1, origins: Array.from({ length: MAX_DECLINED_APPS }, (_, i) => `https://site${String(i)}.ipfs.orivon`) }))
    const apps = new DeclinedApps(path)
    expect(apps.list()).toHaveLength(MAX_DECLINED_APPS)
    expect(apps.add(A)).toBe(true)
    expect(apps.has(A)).toBe(true)
    expect(apps.has('https://site0.ipfs.orivon')).toBe(false)
    expect(apps.has('https://site1.ipfs.orivon')).toBe(true)
    expect(apps.list()).toHaveLength(MAX_DECLINED_APPS)
    expect(new DeclinedApps(path).has(A)).toBe(true)
    expect(apps.add('https://site1.ipfs.orivon')).toBe(true)
    expect(apps.has('https://site1.ipfs.orivon')).toBe(true)
  })

  it('keeps a refusal in memory for the run when the disk refuses it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocker = file()
    writeFileSync(blocker, 'a file, where a folder is needed')
    const apps = new DeclinedApps(join(blocker, 'inside', 'declined-apps.json'))
    expect(apps.add(A)).toBe(true)
    expect(apps.has(A)).toBe(true)
    error.mockRestore()
  })

  it('writes the file atomically in its own shape', () => {
    const path = file()
    new DeclinedApps(path).add(A)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, origins: [A] })
  })
})
