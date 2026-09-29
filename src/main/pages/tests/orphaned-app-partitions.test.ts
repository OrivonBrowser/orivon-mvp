import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanOrphanedAppPartitions, orphanedGrantOrigins } from '../orphaned-app-partitions.js'

describe('orphanedGrantOrigins (pure selection)', () => {
  const apps = [{ origin: 'https://granted.example' }, { origin: 'https://cache-served.example' }, { origin: 'https://also-granted.example' }]
  const cacheServed = new Set(['https://cache-served.example'])
  const isCacheServed = (origin: string): boolean => cacheServed.has(origin)
  const NO_PINS = new Set<string>()

  it('keeps every held-grant origin that is NOT cache-served, in order', () => {
    expect(orphanedGrantOrigins(apps, isCacheServed, NO_PINS)).toEqual(['https://granted.example', 'https://also-granted.example'])
  })

  it('never includes a cache-served origin, even though it also holds a grant', () => {
    expect(orphanedGrantOrigins(apps, isCacheServed, NO_PINS)).not.toContain('https://cache-served.example')
  })

  it('is empty when there are no apps, or every app is cache-served', () => {
    expect(orphanedGrantOrigins([], isCacheServed, NO_PINS)).toEqual([])
    expect(orphanedGrantOrigins([{ origin: 'https://cache-served.example' }], isCacheServed, NO_PINS)).toEqual([])
  })

  // The selection is built ONLY from the given origin list -- it never
  // scans a directory, so an `app-*` partition whose origin is unknown
  // (not in `apps` at all) can never appear here, matching the finding's
  // "never touch an app-* directory whose origin is unknown."
  it('names only origins actually present in the given list -- nothing is inferred', () => {
    expect(orphanedGrantOrigins([{ origin: 'https://only-this-one.example' }], () => false, NO_PINS)).toEqual(['https://only-this-one.example'])
  })

  // A pin can exist on disk for an origin `isCacheServed` reports false for
  // -- its serving simply failed to restore on this run. Treating it as
  // orphaned would clear a cache-served app's own data and leave a marker
  // that prevents any later run from retrying the restore.
  it('excludes a pinned origin even when isCacheServed is false for it -- a pin whose serving failed to restore this run', () => {
    const pinned = new Set(['https://granted.example'])
    expect(orphanedGrantOrigins(apps, isCacheServed, pinned)).toEqual(['https://also-granted.example'])
  })
})

describe('cleanOrphanedAppPartitions', () => {
  let dir: string
  const NO_PINS = new Set<string>()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-orphaned-partitions-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('calls clearData() on the session for every held-grant, non-cache-served origin, and no other', async () => {
    const apps = [{ origin: 'https://granted.example' }, { origin: 'https://cache-served.example' }]
    const isCacheServed = (origin: string): boolean => origin === 'https://cache-served.example'
    const cleared: string[] = []
    const sessionFor = vi.fn((partition: string) => {
      cleared.push(partition)
      return { clearData: async () => {} }
    })

    await cleanOrphanedAppPartitions(dir, apps, isCacheServed, NO_PINS, sessionFor)

    expect(cleared).toHaveLength(1)
    expect(sessionFor).toHaveBeenCalledTimes(1)
  })

  it('never touches a cache-served origin\'s partition', async () => {
    const apps = [{ origin: 'https://cache-served.example' }]
    const sessionFor = vi.fn(() => ({ clearData: async () => {} }))

    await cleanOrphanedAppPartitions(dir, apps, () => true, NO_PINS, sessionFor)

    expect(sessionFor).not.toHaveBeenCalled()
  })

  // A pin on disk means this origin's serving may simply have failed to
  // restore ON THIS RUN (isCacheServed reads live registration state, not
  // disk) -- orphaned-app-partitions.ts's own header. Clearing it anyway,
  // and recording the marker, would strand the app: no later run retries
  // the restore once the marker says "done".
  it('never touches a pinned origin\'s partition, even though isCacheServed reports it as NOT cache-served', async () => {
    const apps = [{ origin: 'https://granted.example' }]
    const sessionFor = vi.fn(() => ({ clearData: async () => {} }))

    await cleanOrphanedAppPartitions(dir, apps, () => false, new Set(['https://granted.example']), sessionFor)

    expect(sessionFor).not.toHaveBeenCalled()
  })

  it('records completion, so a second run touches no session at all', async () => {
    const apps = [{ origin: 'https://granted.example' }]
    const sessionFor = vi.fn(() => ({ clearData: async () => {} }))

    await cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, sessionFor)
    expect(sessionFor).toHaveBeenCalledTimes(1)

    await cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, sessionFor)
    expect(sessionFor).toHaveBeenCalledTimes(1)
  })

  it('the marker survives a restart: a fresh call reads the same marker file left by an earlier one', async () => {
    const apps = [{ origin: 'https://granted.example' }]
    const first = vi.fn(() => ({ clearData: async () => {} }))
    await cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, first)

    const second = vi.fn(() => ({ clearData: async () => {} }))
    await cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, second)

    expect(second).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(dir, 'orphaned-app-partitions-cleaned.json'), 'utf8'))).toMatchObject({ done: true })
  })

  it('does not record completion if a clearData() call rejects, so a later run can retry', async () => {
    const apps = [{ origin: 'https://granted.example' }]
    const failing = vi.fn(() => ({ clearData: async () => { throw new Error('locked') } }))

    await expect(cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, failing)).rejects.toThrow('locked')

    const retry = vi.fn(() => ({ clearData: async () => {} }))
    await cleanOrphanedAppPartitions(dir, apps, () => false, NO_PINS, retry)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
