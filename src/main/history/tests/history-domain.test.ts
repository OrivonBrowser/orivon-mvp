import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { historyDomain } from '../history-domain.js'
import type { HistoryService } from '../history-service.js'

const CALLER = {} as InternalCaller

function setup (): { call: (command: unknown) => unknown, service: Record<'list' | 'listOrdered' | 'remove' | 'removeMany' | 'removeRange' | 'clear' | 'status', ReturnType<typeof vi.fn>> } {
  const service = { list: vi.fn(() => []), listOrdered: vi.fn(() => []), remove: vi.fn(), removeMany: vi.fn(), removeRange: vi.fn(), clear: vi.fn(), status: vi.fn(() => ({ remembering: true, problem: null, count: 0 })) }
  const domain = historyDomain(service as unknown as HistoryService)
  return { call: (command) => domain.handle(command, CALLER), service }
}

describe('the history domain', () => {
  it('is for the History page only', () => {
    expect(historyDomain({} as HistoryService).pages).toEqual(['history'])
  })

  it('lists with a search and a cursor, each checked', () => {
    const { call, service } = setup()
    call({ type: 'list', search: 'guide', after: { lastVisit: 10, id: 3 } })
    expect(service.list).toHaveBeenLastCalledWith({ search: 'guide', after: { lastVisit: 10, id: 3 } })
    call({ type: 'list', search: 5, after: { lastVisit: 'x', id: 1.5 } })
    expect(service.list).toHaveBeenLastCalledWith({})
    call({ type: 'list', search: 'x'.repeat(1000) })
    expect(service.list).toHaveBeenLastCalledWith({ search: 'x'.repeat(200) })
  })

  it('forwards a numeric limit, truncated, so a page can ask for more than one default page at once', () => {
    const { call, service } = setup()
    call({ type: 'list', limit: 250 })
    expect(service.list).toHaveBeenLastCalledWith({ limit: 250 })
    call({ type: 'list', limit: 250.9 })
    expect(service.list).toHaveBeenLastCalledWith({ limit: 250 })
    call({ type: 'list', limit: 'lots' })
    expect(service.list).toHaveBeenLastCalledWith({})
    call({ type: 'list', limit: Number.NaN })
    expect(service.list).toHaveBeenLastCalledWith({})
  })

  it('lists most visited and by title from an offset, each checked, and most recent through the cursor', () => {
    const { call, service } = setup()
    call({ type: 'list', order: 'visits', offset: 100, search: 'x', limit: 50 })
    expect(service.listOrdered).toHaveBeenLastCalledWith({ order: 'visits', offset: 100, search: 'x', limit: 50 })
    call({ type: 'list', order: 'title', offset: 'lots' })
    expect(service.listOrdered).toHaveBeenLastCalledWith({ order: 'title' })
    call({ type: 'list', order: 'recent', after: { lastVisit: 4, id: 2 } })
    expect(service.list).toHaveBeenLastCalledWith({ after: { lastVisit: 4, id: 2 } })
    call({ type: 'list', order: 'DROP TABLE pages' })
    expect(service.list).toHaveBeenLastCalledWith({})
    expect(service.listOrdered).toHaveBeenCalledTimes(2)
  })

  it('forgets several pages at once, only for whole-number ids and at most 500', () => {
    const { call, service } = setup()
    expect(call({ type: 'removeMany', ids: [1, 2, 3] })).toEqual(expect.objectContaining({ ok: true }))
    expect(service.removeMany).toHaveBeenLastCalledWith([1, 2, 3])
    expect(call({ type: 'removeMany', ids: [1, 2.5] })).toBeUndefined()
    expect(call({ type: 'removeMany', ids: ['1'] })).toBeUndefined()
    expect(call({ type: 'removeMany', ids: 'all' })).toBeUndefined()
    expect(call({ type: 'removeMany', ids: Array.from({ length: 501 }, (_, n) => n) })).toBeUndefined()
    expect(call({ type: 'removeMany', ids: Array.from({ length: 500 }, (_, n) => n) })).toEqual(expect.objectContaining({ ok: true }))
    expect(call({ type: 'removeMany', ids: [] })).toEqual(expect.objectContaining({ ok: true }))
    expect(service.removeMany).toHaveBeenCalledTimes(2)
  })

  it('forgets a page by a whole-number id only', () => {
    const { call, service } = setup()
    call({ type: 'remove', id: 4 })
    call({ type: 'remove', id: 4.5 })
    call({ type: 'remove', id: '4' })
    call({ type: 'remove' })
    expect(service.remove).toHaveBeenCalledExactlyOnceWith(4)
  })

  it('forgets a range only when both ends are numbers and it runs forwards', () => {
    const { call, service } = setup()
    call({ type: 'removeRange', from: 1, to: 2 })
    call({ type: 'removeRange', from: 5, to: 2 })
    call({ type: 'removeRange', from: 'a', to: 2 })
    call({ type: 'removeRange', from: Number.NaN, to: 2 })
    call({ type: 'removeRange', from: 1 })
    expect(service.removeRange).toHaveBeenCalledExactlyOnceWith(1, 2)
  })

  it('clears everything, and answers nothing to what it does not know', () => {
    const { call, service } = setup()
    call({ type: 'clear' })
    expect(service.clear).toHaveBeenCalledTimes(1)
    expect(call({ type: 'wipe-the-disk' })).toBeUndefined()
    expect(call('nonsense')).toBeUndefined()
    expect(call(null)).toBeUndefined()
  })
})
