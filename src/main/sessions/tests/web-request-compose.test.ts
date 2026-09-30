import { describe, expect, it, vi } from 'vitest'
import { composeWebRequest } from '../web-request-compose.js'
import type { OrderedHandler } from '../web-request-compose.js'

interface Details { readonly url: string }
interface Result { readonly cancel?: boolean; readonly log: readonly string[] }

const SEED: Result = { log: [] }
const cancelled = (result: Result): boolean => result.cancel === true
const matchAll = (): boolean => true

function handler (name: string, order: number, extra: Partial<OrderedHandler<Details, Result>> = {}): OrderedHandler<Details, Result> {
  return {
    order,
    matches: matchAll,
    run: (_details, soFar) => ({ log: [...soFar.log, name] }),
    ...extra
  }
}

describe('composeWebRequest', () => {
  it('returns the seed unchanged when nothing matches', async () => {
    const onError = vi.fn()
    const result = await composeWebRequest([], { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result).toEqual(SEED)
    expect(onError).not.toHaveBeenCalled()
  })

  it('runs handlers in ORDER, lowest first, regardless of registration order', async () => {
    const onError = vi.fn()
    const handlers = [handler('third', 30), handler('first', 10), handler('second', 20)]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result.log).toEqual(['first', 'second', 'third'])
  })

  it('each handler receives what the previous one left, not the seed again', async () => {
    const onError = vi.fn()
    const seenByThird: string[][] = []
    const handlers = [
      handler('one', 1),
      handler('two', 2),
      { order: 3, matches: matchAll, run: (_d: Details, soFar: Result) => { seenByThird.push([...soFar.log]); return { log: [...soFar.log, 'three'] } } }
    ]
    await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(seenByThird).toEqual([['one', 'two']])
  })

  it('only asks handlers whose predicate matches this URL', async () => {
    const onError = vi.fn()
    const handlers = [
      handler('everyone', 1),
      handler('only-b', 2, { matches: (url) => url.includes('b.example') })
    ]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result.log).toEqual(['everyone'])
  })

  it('stops at the first handler whose result is terminal, never asking a later one', async () => {
    const onError = vi.fn()
    const later = vi.fn(() => ({ log: ['later'] }))
    const handlers: Array<OrderedHandler<Details, Result>> = [
      { order: 1, matches: matchAll, run: () => ({ cancel: true, log: ['stopper'] }) },
      { order: 2, matches: matchAll, run: later }
    ]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result).toEqual({ cancel: true, log: ['stopper'] })
    expect(later).not.toHaveBeenCalled()
  })

  it('a handler that throws synchronously is logged and skipped -- the chain continues from the PREVIOUS result', async () => {
    const onError = vi.fn()
    const handlers: Array<OrderedHandler<Details, Result>> = [
      handler('kept', 1),
      { order: 2, matches: matchAll, run: () => { throw new Error('boom') } },
      handler('after', 3)
    ]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result.log).toEqual(['kept', 'after'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 2)
  })

  it('a handler whose promise rejects is logged and skipped the same way', async () => {
    const onError = vi.fn()
    const handlers: Array<OrderedHandler<Details, Result>> = [
      handler('kept', 1),
      { order: 2, matches: matchAll, run: async () => { throw new Error('async boom') } },
      handler('after', 3)
    ]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result.log).toEqual(['kept', 'after'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('two handlers tied at the same order run in their registration order (stable sort)', async () => {
    const onError = vi.fn()
    const handlers = [handler('registered-first', 5), handler('registered-second', 5)]
    const result = await composeWebRequest(handlers, { url: 'https://a.example/' }, 'https://a.example/', SEED, cancelled, onError)
    expect(result.log).toEqual(['registered-first', 'registered-second'])
  })
})
