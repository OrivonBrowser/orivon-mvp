import { describe, expect, it } from 'vitest'
import { screenEvent } from './kind-screening.js'

function event (kind: number, tags: readonly (readonly string[])[] = []) {
  return { kind, tags }
}

describe('screenEvent -- the exhaustive table (README.md, brief scope item 3)', () => {
  it.each([1, 6, 7])('kind %i signs silently', (kind) => {
    expect(screenEvent(event(kind))).toBe('silent')
  })

  it.each([0, 3, 5, 22242])('kind %i prompts every time', (kind) => {
    expect(screenEvent(event(kind))).toBe('prompt')
  })

  it('an unscreened kind defaults to prompt, never silent (acceptance criterion 3)', () => {
    expect(screenEvent(event(2))).toBe('prompt')
    expect(screenEvent(event(9999))).toBe('prompt')
    expect(screenEvent(event(30023))).toBe('prompt')
  })

  it('a delegation tag forces prompt even on an otherwise-silent kind (NIP-26)', () => {
    const delegated = event(1, [['delegation', 'somepubkey', 'kind=1', 'sometoken']])
    expect(screenEvent(delegated)).toBe('prompt')
  })

  it('a delegation tag anywhere in the tag list still forces prompt, not just when first', () => {
    const delegated = event(6, [['e', 'abc'], ['delegation', 'somepubkey', 'kind=6', 'sometoken']])
    expect(screenEvent(delegated)).toBe('prompt')
  })

  it('a tag that merely mentions "delegation" as a non-first element does not trigger it', () => {
    const notDelegation = event(1, [['p', 'delegation']])
    expect(screenEvent(notDelegation)).toBe('silent')
  })

  it('an empty tag array cannot crash the delegation check', () => {
    expect(screenEvent(event(1, [[]]))).toBe('silent')
  })
})
