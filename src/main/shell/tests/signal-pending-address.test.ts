import { describe, expect, it, vi } from 'vitest'
import { pendingAddressSignal, pendingOf, setPendingAddress } from '../signals/pending-address.js'
import { signalState } from '../tab-signals.js'
import type { TabSignalContext } from '../tab-signals.js'

const wc = (): never => ({}) as never
const record = (): never => ({}) as never
const stateOf = (contents: never | undefined): Record<string, unknown> => signalState(record(), contents, [pendingAddressSignal]) as Record<string, unknown>

describe('the pending-address signal', () => {
  it('has nothing to say until an address is set, and then shows it as the page, not as a new tab', () => {
    const contents = wc()
    expect(stateOf(contents)).toEqual({})
    setPendingAddress(contents, 'http://127.0.0.1:8080/secret?a=1')
    expect(stateOf(contents)).toMatchObject({ isNewTab: false, title: '127.0.0.1:8080' })
    expect(String(stateOf(contents)['displayUrl'])).toContain('127.0.0.1:8080/secret')
    setPendingAddress(contents, null)
    expect(stateOf(contents)).toEqual({})
  })

  it('shows only a website\'s address, and keeps another tab\'s state alone', () => {
    const one = wc()
    const two = wc()
    setPendingAddress(one, 'javascript:alert(1)')
    setPendingAddress(two, 'https://site.example/')
    expect(stateOf(one)).toEqual({})
    expect(stateOf(two)).toMatchObject({ title: 'site.example' })
    expect(pendingOf('not a url')).toBeUndefined()
    expect(stateOf(undefined)).toEqual({})
  })

  it('tells the tab\'s window each time the address changes', () => {
    const contents = wc()
    const emitState = vi.fn()
    pendingAddressSignal.wire?.({ record: { host: { emitState } }, wc: contents } as unknown as TabSignalContext)
    setPendingAddress(contents, 'https://site.example/')
    setPendingAddress(contents, null)
    expect(emitState).toHaveBeenCalledTimes(2)
  })
})
