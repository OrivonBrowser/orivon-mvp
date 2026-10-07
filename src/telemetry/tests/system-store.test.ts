import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNDECIDED, recordChoice } from '../consent.js'
import { SystemStore } from '../system-store.js'

describe('SystemStore', () => {
  let dir: string
  let home: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-telemetry-home-'))
    home = join(dir, 'orivon-telemetry')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads no choice from a folder that does not exist yet, and makes the folder on the first write', async () => {
    const store = new SystemStore(home)
    expect(await store.readConsent()).toEqual(UNDECIDED)
    const record = recordChoice('accepted', 123, 'welcome')
    await store.writeConsent(record)
    expect(await store.readConsent()).toEqual(record)
    expect(JSON.parse(await readFile(join(home, 'consent.json'), 'utf8'))).toEqual({ state: 'accepted', atMs: 123, noticeVersion: 4, source: 'welcome', everAccepted: true })
  })

  it('is shared: a second store on the same folder, the way another profile is, sees the choice at once', async () => {
    const one = new SystemStore(home)
    const other = new SystemStore(home)
    await one.writeConsent(recordChoice('declined', 5, 'settings'))
    expect((await other.readConsent()).state).toBe('declined')
    await other.writeConsent(recordChoice('accepted', 9, 'settings'))
    expect((await one.readConsent()).state).toBe('accepted')
  })

  it('reads a damaged consent.json as no choice, and leaves no temporary file behind after a write', async () => {
    const store = new SystemStore(home)
    await store.writeConsent(recordChoice('accepted', 1, 'welcome'))
    await writeFile(join(home, 'consent.json'), '{broken', 'utf8')
    expect(await store.readConsent()).toEqual(UNDECIDED)
    await store.writeConsent(recordChoice('declined', 2, 'welcome'))
    expect(await readdir(home)).toEqual(['consent.json'])
  })

  it('keeps a fallback install ID in its own file', async () => {
    const store = new SystemStore(home)
    expect(await store.readFallbackId()).toBeUndefined()
    await store.writeFallbackId('ab'.repeat(16))
    expect(await store.readFallbackId()).toBe('ab'.repeat(16))
  })
})
