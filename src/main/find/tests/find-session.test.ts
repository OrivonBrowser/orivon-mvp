import { describe, expect, it } from 'vitest'
import { acceptResult, beginCall, invalidate, newSession, stepCall } from '../find-session.js'

const found = (requestId: number, active: number, matches: number, finalUpdate = true): { requestId: number, activeMatchOrdinal: number, matches: number, finalUpdate: boolean } =>
  ({ requestId, activeMatchOrdinal: active, matches, finalUpdate })

describe('beginCall', () => {
  it('starts a session on the first match and remembers the query and the case', () => {
    const session = newSession()

    const call = beginCall(session, 'orivon', true)

    expect(call).toEqual({ text: 'orivon', options: { findNext: true, forward: true, matchCase: true } })
    expect(session).toMatchObject({ query: 'orivon', matchCase: true, started: true, active: 0, total: 0 })
  })

  it('restarts when the case toggles: the same text begins a new session', () => {
    const session = newSession('orivon', false)
    beginCall(session, 'orivon', false)
    session.active = 3

    const call = beginCall(session, 'orivon', true)

    expect(call.options).toMatchObject({ findNext: true, matchCase: true })
    expect(session.active).toBe(0)
  })

  it('drops a step that was waiting for the answer to an older search', () => {
    const session = newSession()
    session.pendingStep = true

    beginCall(session, 'x', false)

    expect(session.pendingStep).toBeNull()
  })
})

describe('stepCall', () => {
  it('follows up an open search with findNext off, in the asked direction', () => {
    const session = newSession()
    beginCall(session, 'orivon', false)

    expect(stepCall(session, true)?.options).toEqual({ findNext: false, forward: true, matchCase: false })
    expect(stepCall(session, false)?.options).toEqual({ findNext: false, forward: false, matchCase: false })
  })

  it('does nothing without a query', () => {
    expect(stepCall(newSession(), true)).toBeNull()
  })

  it('begins a search on a page that has none yet, still going the asked way', () => {
    const session = newSession('orivon', true)

    const call = stepCall(session, false)

    expect(call).toEqual({ text: 'orivon', options: { findNext: true, forward: false, matchCase: true } })
    expect(session.started).toBe(true)
  })

  it('begins again after a navigation', () => {
    const session = newSession()
    beginCall(session, 'orivon', false)
    invalidate(session)

    expect(stepCall(session, true)?.options.findNext).toBe(true)
  })
})

describe('acceptResult', () => {
  it('takes the answer to the newest request and keeps the numbers', () => {
    const session = newSession()
    session.requestId = 7

    expect(acceptResult(session, found(7, 2, 5))).toEqual({ active: 2, total: 5 })
    expect(session).toMatchObject({ active: 2, total: 5 })
  })

  it('ignores an answer to an older request', () => {
    const session = newSession()
    session.requestId = 8

    expect(acceptResult(session, found(7, 2, 5))).toBeNull()
    expect(session.total).toBe(0)
  })

  it('ignores a count that is still being updated', () => {
    const session = newSession()
    session.requestId = 7

    expect(acceptResult(session, found(7, 1, 3, false))).toBeNull()
  })

  it('reports no matches as zero of zero', () => {
    const session = newSession()
    session.requestId = 1

    expect(acceptResult(session, found(1, 0, 0))).toEqual({ active: 0, total: 0 })
  })
})
