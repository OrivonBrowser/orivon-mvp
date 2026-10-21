import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { addressBarStatePart } from '../state/address-bar.js'
import type { WindowContext } from '../window-context.js'

function context (on: boolean, values: Record<string, string> = {}): { ctx: WindowContext, change: (key: string) => void, removed: ReturnType<typeof vi.fn> } {
  let listener: (change: { key: string }) => void = () => {}
  const removed = vi.fn()
  const settings = {
    get: (key: string) => (key === 'addressBar.showFullUrl' ? on : { 'search.mode': 'web3', 'search.web3Engine': 'explore', 'search.engine': 'duckduckgo', 'search.customUrl': '', ...values }[key]),
    onChange: (next: typeof listener) => { listener = next; return removed }
  }
  return { ctx: { services: { settings, searchEngines: { all: () => [{ id: 'duckduckgo', name: 'DuckDuckGo', keyword: 'ddg', template: 'https://duckduckgo.com/?q=%s', kind: 'builtin' }] } } } as unknown as WindowContext, change: (key) => { listener({ key }) }, removed }
}

describe('the address bar state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(addressBarStatePart)
  })

  it('reads whether the bar shows full addresses', () => {
    const tabs = { tabs: [], activeTabId: null }
    expect(addressBarStatePart.read(context(true).ctx, tabs)).toMatchObject({ showFullUrl: true })
    expect(addressBarStatePart.read(context(false).ctx, tabs)).toMatchObject({ showFullUrl: false })
  })

  it('reads which engine the address bar searches with, for the chip beside the address', () => {
    const tabs = { tabs: [], activeTabId: null }
    expect(addressBarStatePart.read(context(false).ctx, tabs)).toMatchObject({ searchMode: 'web3', searchWeb3Name: 'Explore', searchWeb2Name: 'DuckDuckGo' })
    expect(addressBarStatePart.read(context(false, { 'search.mode': 'web2' }).ctx, tabs)).toMatchObject({ searchMode: 'web2', searchWeb3Name: 'Explore', searchWeb2Name: 'DuckDuckGo' })
  })

  it('pushes when one of the settings it shows changes, and for no other', () => {
    const { ctx, change, removed } = context(false)
    const push = vi.fn()
    const stop = addressBarStatePart.watch?.(ctx, push)
    change('search.suggestions')
    expect(push).not.toHaveBeenCalled()
    change('addressBar.showFullUrl')
    expect(push).toHaveBeenCalledTimes(1)
    for (const key of ['search.mode', 'search.engine', 'search.web3Engine', 'search.customUrl']) change(key)
    expect(push).toHaveBeenCalledTimes(5)
    stop?.()
    expect(removed).toHaveBeenCalled()
  })
})
