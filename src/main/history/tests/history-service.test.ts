import { describe, expect, it, vi } from 'vitest'
import { HistoryService } from '../history-service.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const DAY = 24 * 60 * 60 * 1000

function setup (values: { 'history.remember'?: boolean, 'history.retentionDays'?: string } = {}, problem: string | null = null): {
  service: HistoryService, store: SqliteHistoryStore, set: (key: string, value: boolean | string) => void, clock: { now: number }
} {
  const settings: Record<string, boolean | string> = { 'history.remember': true, 'history.retentionDays': '90', ...values }
  const listeners = new Set<(change: { key: string }) => void>()
  const clock = { now: 1000 * DAY }
  const store = new SqliteHistoryStore(':memory:')
  const service = new HistoryService(store, {
    get: ((key: string) => settings[key]) as never,
    onChange: (listener: (change: { key: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  } as never, problem, () => clock.now)
  return { service, store, clock, set: (key, value) => { settings[key] = value; for (const listener of listeners) listener({ key }) } }
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const GIF = 'data:image/gif;base64,R0lGODlhAQAB'

describe('the history service', () => {
  describe('site icons', () => {
    it('keeps what a tab offers, and offers the store an icon again only when it changed', () => {
      const { service, store } = setup()
      const setFavicon = vi.spyOn(store, 'setFavicon')
      service.setFavicon('a.example', PNG)
      service.setFavicon('a.example', PNG)
      service.setFavicon('a.example', GIF)
      expect(setFavicon).toHaveBeenCalledTimes(2)
      expect(service.faviconsFor(['a.example'])).toEqual({ 'a.example': GIF })
    })

    it('does not throw into the state push that offered it when the store fails, and offers the icon again next time', () => {
      const { service, store } = setup()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const setFavicon = vi.spyOn(store, 'setFavicon').mockImplementationOnce(() => { throw new Error('disk full') })
      expect(() => { service.setFavicon('a.example', PNG) }).not.toThrow()
      service.setFavicon('a.example', PNG)
      expect(setFavicon).toHaveBeenCalledTimes(2)
      expect(service.faviconsFor(['a.example'])).toEqual({ 'a.example': PNG })
      error.mockRestore()
    })

    it('keeps nothing while history is off', () => {
      const { service } = setup({ 'history.remember': false })
      service.setFavicon('a.example', PNG)
      expect(service.faviconsFor(['a.example'])).toEqual({})
    })

    it('are offered afresh after pages are forgotten, so a site visited again gets its icon back', () => {
      const { service, store } = setup()
      const setFavicon = vi.spyOn(store, 'setFavicon')
      service.visit('https://a.example/', 'A')
      service.setFavicon('a.example', PNG)
      service.clear()
      service.visit('https://a.example/', 'A')
      service.setFavicon('a.example', PNG)
      expect(setFavicon).toHaveBeenCalledTimes(2)
      expect(service.faviconsFor(['a.example'])).toEqual({ 'a.example': PNG })
    })
  })

  it('forgets several pages in one change, and finds pages by id', () => {
    const { service } = setup()
    service.visit('https://a.example/', 'A')
    service.visit('https://b.example/', 'B')
    service.visit('https://c.example/', 'C')
    const changes: string[] = []
    service.onChange((change) => { changes.push(change) })
    const ids = service.list().map((entry) => entry.id)
    expect(service.pagesByIds([ids[0] as number]).map((entry) => entry.title)).toEqual(['C'])
    service.removeMany([ids[0] as number, ids[2] as number])
    expect(service.list().map((entry) => entry.title)).toEqual(['B'])
    expect(changes).toEqual(['entries'])
  })

  it('writes down a visit at the time it happens, and a title later', () => {
    const { service, store, clock } = setup()
    service.visit('https://a.example/', '')
    service.titled('https://a.example/', 'A')
    expect(store.list()).toEqual([expect.objectContaining({ url: 'https://a.example/', title: 'A', lastVisit: clock.now })])
  })

  it('writes down nothing while history is off, and starts again when it is turned on', () => {
    const { service, store, set } = setup({ 'history.remember': false })
    service.visit('https://a.example/', 'A')
    service.titled('https://a.example/', 'A')
    expect(store.count()).toBe(0)
    expect(service.status()).toMatchObject({ remembering: false })

    set('history.remember', true)
    service.visit('https://a.example/', 'A')
    expect(store.count()).toBe(1)
  })

  it('forgets what is older than the person chose to keep, at start and when the choice changes', () => {
    const { service, store, clock, set } = setup({ 'history.retentionDays': '30' })
    store.record('https://old.example/', 'Old', clock.now - 40 * DAY)
    store.record('https://week.example/', 'Week', clock.now - 8 * DAY)
    store.record('https://new.example/', 'New', clock.now - 1 * DAY)
    service.prune()
    expect(store.list().map((entry) => entry.title)).toEqual(['New', 'Week'])

    set('history.retentionDays', '7')
    expect(store.list().map((entry) => entry.title)).toEqual(['New'])
  })

  it('does not let a store that cannot prune end the browser at start', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, store } = setup()
    vi.spyOn(store, 'removeRange').mockImplementation(() => { throw new Error('database or disk is full') })

    expect(() => { service.prune() }).not.toThrow()
    expect(complaint).toHaveBeenCalled()
    complaint.mockRestore()
  })

  it('keeps everything when the person chose forever', () => {
    const { service, store, clock } = setup({ 'history.retentionDays': 'forever' })
    store.record('https://ancient.example/', 'Ancient', clock.now - 4000 * DAY)
    service.prune()
    expect(store.count()).toBe(1)
  })

  it('says why nothing is being kept when the file could not be used', () => {
    const { service } = setup({}, 'the file is damaged')
    expect(service.status()).toEqual({ remembering: true, problem: 'the file is damaged', count: 0 })
  })

  it('forgets a page, a range and everything, on request', () => {
    const { service, store } = setup()
    store.record('https://a.example/', 'A', 1000)
    store.record('https://b.example/', 'B', 2000)
    store.record('https://c.example/', 'C', 3000)
    service.removeRange(1500, 2500)
    expect(store.count()).toBe(2)
    service.remove(service.list()[0]?.id ?? -1)
    expect(store.count()).toBe(1)
    service.clear()
    expect(store.count()).toBe(0)
  })

  describe('onChange', () => {
    it('fires for a visit, a title, a removal, a range and a clear', () => {
      const { service } = setup()
      let calls = 0
      service.onChange(() => { calls += 1 })

      service.visit('https://a.example/', '')
      service.titled('https://a.example/', 'A')
      service.remove(1)
      service.removeRange(0, 1)
      service.clear()

      expect(calls).toBe(5)
    })

    it('never fires for a visit or a title while history is off', () => {
      const { service } = setup({ 'history.remember': false })
      let calls = 0
      service.onChange(() => { calls += 1 })

      service.visit('https://a.example/', '')
      service.titled('https://a.example/', 'A')

      expect(calls).toBe(0)
    })

    it('fires once prune() actually removes something older than the retention window', () => {
      const { service, store, clock } = setup({ 'history.retentionDays': '30' })
      store.record('https://old.example/', 'Old', clock.now - 40 * DAY)
      let calls = 0
      service.onChange(() => { calls += 1 })

      service.prune()

      expect(calls).toBe(1)
    })

    it('stops firing once the listener unsubscribes', () => {
      const { service } = setup()
      let calls = 0
      const off = service.onChange(() => { calls += 1 })
      off()

      service.visit('https://a.example/', '')

      expect(calls).toBe(0)
    })
  })
})
