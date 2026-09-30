import { describe, expect, it } from 'vitest'
import { asFindRequest, asShowStep, MAX_QUERY_LENGTH } from '../find-events.js'

describe('asFindRequest', () => {
  it('accepts a query and a step, as the page sends them', () => {
    expect(asFindRequest({ type: 'query', text: 'orivon', matchCase: false })).toEqual({ type: 'query', text: 'orivon', matchCase: false })
    expect(asFindRequest({ type: 'step', forward: false })).toEqual({ type: 'step', forward: false })
  })

  it('accepts an empty query: it clears the search', () => {
    expect(asFindRequest({ type: 'query', text: '', matchCase: true })).toEqual({ type: 'query', text: '', matchCase: true })
  })

  it('refuses a query longer than the limit, without cutting it', () => {
    expect(asFindRequest({ type: 'query', text: 'a'.repeat(MAX_QUERY_LENGTH), matchCase: false })).toBeDefined()
    expect(asFindRequest({ type: 'query', text: 'a'.repeat(MAX_QUERY_LENGTH + 1), matchCase: false })).toBeUndefined()
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'query'],
    ['an unknown type', { type: 'run', id: 'app.quit' }],
    ['a query with a number for text', { type: 'query', text: 5, matchCase: false }],
    ['a query without the case', { type: 'query', text: 'a' }],
    ['a query with a truthy string for the case', { type: 'query', text: 'a', matchCase: 'yes' }],
    ['a step without a direction', { type: 'step' }],
    ['a step with a number for the direction', { type: 'step', forward: 1 }]
  ])('ignores %s', (_name, command) => {
    expect(asFindRequest(command)).toBeUndefined()
  })
})

describe('asShowStep', () => {
  it('reads a boolean step and nothing else', () => {
    expect(asShowStep({ step: true })).toBe(true)
    expect(asShowStep({ step: false })).toBe(false)
    expect(asShowStep({ step: 'yes' })).toBeUndefined()
    expect(asShowStep(undefined)).toBeUndefined()
    expect(asShowStep(null)).toBeUndefined()
  })
})
