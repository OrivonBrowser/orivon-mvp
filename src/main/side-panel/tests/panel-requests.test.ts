import { describe, expect, it } from 'vitest'
import { asRequest } from '../panel-requests.js'

describe('asRequest', () => {
  it('accepts each listed request', () => {
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: 'a', open: ['bar'] })).toEqual({ type: 'rows', view: 'bookmarks', query: 'a', open: ['bar'] })
    expect(asRequest({ type: 'open', view: 'history', id: '4', how: 'window' })).toEqual({ type: 'open', view: 'history', id: '4', how: 'window' })
    expect(asRequest({ type: 'remove', view: 'history', id: '4' })).toEqual({ type: 'remove', view: 'history', id: '4' })
    expect(asRequest({ type: 'menu', view: 'history', id: '4' })).toEqual({ type: 'menu', view: 'history', id: '4' })
    expect(asRequest({ type: 'view', view: 'ext:abc' })).toEqual({ type: 'view', view: 'ext:abc' })
    expect(asRequest({ type: 'page', view: 'history' })).toEqual({ type: 'page', view: 'history' })
    expect(asRequest({ type: 'picker', open: true })).toEqual({ type: 'picker', open: true })
    expect(asRequest({ type: 'resize', width: 400 })).toEqual({ type: 'resize', width: 400 })
    expect(asRequest({ type: 'focus-page' })).toEqual({ type: 'focus-page' })
    expect(asRequest({ type: 'close' })).toEqual({ type: 'close' })
  })

  it('refuses anything that is not an object, or names no known type', () => {
    for (const bad of [undefined, null, 'close', 5, [], {}, { type: 'navigate', url: 'https://x.example/' }, { type: 'setGuest', view: 'a' }]) expect(asRequest(bad)).toBeUndefined()
  })

  it('refuses a field of the wrong type, and drops fields it does not list', () => {
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: 1, open: [] })).toBeUndefined()
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: '', open: 'bar' })).toBeUndefined()
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: '', open: [4] })).toBeUndefined()
    expect(asRequest({ type: 'open', view: 'history', id: '4', how: 'tab' })).toBeUndefined()
    expect(asRequest({ type: 'open', view: 'history', id: 4, how: 'current' })).toBeUndefined()
    expect(asRequest({ type: 'picker', open: 'yes' })).toBeUndefined()
    expect(asRequest({ type: 'picker' })).toBeUndefined()
    expect(asRequest({ type: 'resize', width: Number.NaN })).toBeUndefined()
    expect(asRequest({ type: 'resize', width: '400' })).toBeUndefined()
    expect(asRequest({ type: 'close', url: 'https://x.example/' })).toEqual({ type: 'close' })
  })

  it('refuses an oversized field', () => {
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: 'q'.repeat(201), open: [] })).toBeUndefined()
    expect(asRequest({ type: 'rows', view: 'bookmarks', query: '', open: Array.from({ length: 501 }, () => 'a') })).toBeUndefined()
    expect(asRequest({ type: 'open', view: 'history', id: 'i'.repeat(201), how: 'current' })).toBeUndefined()
    expect(asRequest({ type: 'view', view: 'v'.repeat(41) })).toBeUndefined()
  })
})
