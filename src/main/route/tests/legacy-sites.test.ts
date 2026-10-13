import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { legacySitePartition, migrateLegacySites } from '../legacy-sites.js'

const hash = (origin: string): string => createHash('sha256').update(origin, 'utf8').digest('hex')

describe('the sessions websites had of their own', () => {
  it('are named as they were, on disk for an origin that may be written there and in memory for the rest', () => {
    expect(legacySitePartition('https://news.example')).toBe(`persist:site-${hash('https://news.example')}`)
    expect(legacySitePartition('http://news.example')).toBe(`site-${hash('http://news.example')}`)
  })
})

describe('clearing them once', () => {
  function store (needs: boolean, sites: string[], failSave = false) {
    return {
      needsMigration: () => needs,
      legacySites: () => sites,
      migrateToProfiles: vi.fn(() => { if (failSave) throw new Error('read-only') })
    }
  }

  it('clears the session of every website the old file listed, then records that it is done', async () => {
    const cleared: string[] = []
    const routes = store(true, ['https://a.example', 'http://b.example'])
    await migrateLegacySites(routes, { clear: async (partition) => { cleared.push(partition) } })
    expect(cleared).toEqual([legacySitePartition('https://a.example'), legacySitePartition('http://b.example')])
    expect(routes.migrateToProfiles).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a profile that never had them', async () => {
    const clear = vi.fn(async () => {})
    const routes = store(false, ['https://a.example'])
    await migrateLegacySites(routes, { clear })
    expect(clear).not.toHaveBeenCalled()
    expect(routes.migrateToProfiles).not.toHaveBeenCalled()
  })

  it('does not record it as done when a session could not be cleared, so the next start tries again, and does not throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const routes = store(true, ['https://a.example'])
    await migrateLegacySites(routes, { clear: async () => { throw new Error('locked') } })
    expect(routes.migrateToProfiles).not.toHaveBeenCalled()
  })
})
