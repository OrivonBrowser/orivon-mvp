import { afterEach, describe, expect, it, vi } from 'vitest'

const { served, contents, DEFAULT_SESSION, sessions } = vi.hoisted(() => ({
  served: new Set<string>(),
  contents: [] as Array<{ id: number, session: unknown, url: string, isDestroyed: () => boolean, getURL: () => string }>,
  DEFAULT_SESSION: { name: 'default' },
  sessions: new Map<string, { name: string }>()
}))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => served.has(origin) }))
vi.mock('electron', () => ({
  session: {
    defaultSession: DEFAULT_SESSION,
    fromPartition: (name: string) => { let found = sessions.get(name); if (found === undefined) sessions.set(name, found = { name }); return found }
  },
  webContents: { getAllWebContents: () => contents }
}))

const { pagesOfOrigin } = await import('../pages-of-origin.js')
const { partitionFor } = await import('../../../broker/grants/origin-hash.js')
const { session } = await import('electron')

const KEPT = 'https://kept.eth'
const PLAIN = 'https://app.example'

function page (id: number, home: unknown, url: string, destroyed = false): number {
  contents.push({ id, session: home, url, isDestroyed: () => destroyed, getURL: () => url })
  return id
}
const ids = (origin: string): number[] => pagesOfOrigin(origin).map((found) => (found as unknown as { id: number }).id)

afterEach(() => { contents.length = 0; served.clear(); sessions.clear() })

describe('the pages of an allowed app a block must stop', () => {
  it('are, for an app that runs where websites run, every page at the origin in any session', () => {
    served.add(KEPT)
    page(1, DEFAULT_SESSION, `${KEPT}/a`)
    page(2, session.fromPartition('persist:tunnel-profile'), `${KEPT}/popup`)
    page(3, session.fromPartition(partitionFor(KEPT)), `${KEPT}/old`)
    page(4, DEFAULT_SESSION, 'https://other.eth/')
    page(5, DEFAULT_SESSION, `${KEPT}/gone`, true)
    page(6, DEFAULT_SESSION, 'about:blank')
    expect(ids(KEPT)).toEqual([1, 2, 3])
  })

  it('are, for an app with a partition of its own, the pages in it whatever they show, and the pages at the origin elsewhere', () => {
    served.add(PLAIN)
    page(1, session.fromPartition(partitionFor(PLAIN)), 'about:blank')
    page(2, DEFAULT_SESSION, `${PLAIN}/x`)
    page(3, DEFAULT_SESSION, 'https://other.example/')
    expect(ids(PLAIN)).toEqual([1, 2])
  })

  it('are the pages at the origin when it is no longer served, and never make a partition for an origin that has none', () => {
    page(1, DEFAULT_SESSION, `${PLAIN}/x`)
    expect(ids(PLAIN)).toEqual([1])
    expect(sessions.has(partitionFor(PLAIN))).toBe(false)
  })
})
