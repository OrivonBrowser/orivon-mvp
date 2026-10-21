import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { thisSiteOf, web3ScoreOverlay } from '../web3-score-overlay.js'

function attach () {
  const createTab = vi.fn(() => 'tab-1')
  const openInternal = vi.fn()
  const close = vi.fn()
  const handler = web3ScoreOverlay.attach({ window: { tabs: { createTab, openInternal } }, close } as unknown as OverlayWindow)
  return { handler, createTab, openInternal, close }
}

describe('the Web3 Score card', () => {
  it('is kept fresh, so a mark on another tab never shows the last tab\'s level', () => {
    expect(web3ScoreOverlay.keep).toBe('fresh')
  })

  it('marks no level when the shield opens it on a new tab', () => {
    expect(attach().handler.show?.(undefined)).toEqual({ site: undefined })
  })

  it('marks the level a mark sends, and only a real one', () => {
    const { handler } = attach()
    expect(handler.show?.({ level: 3, unscored: false })).toEqual({ site: { level: 3, unscored: false } })
    expect(handler.show?.({ level: 2, unscored: true })).toEqual({ site: { level: 2, unscored: true } })
    for (const bad of [{ level: 9 }, { level: '2' }, 'x', null, []]) expect(thisSiteOf(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('opens the official docs at the .eth name for "How scores work", and closes', () => {
    const { handler, createTab, close } = attach()
    handler.request({ type: 'learn' })
    expect(createTab).toHaveBeenCalledExactlyOnceWith('https://docs.orivonstack.eth/docs/using/web3-score')
    expect(close).toHaveBeenCalledOnce()
  })

  it('opens the provider setting for "Choose a score provider"', () => {
    const { handler, openInternal } = attach()
    handler.request({ type: 'provider' })
    expect(openInternal).toHaveBeenCalledExactlyOnceWith('settings', '/web3')
  })

  it('does nothing for a request it does not list', () => {
    const { handler, createTab, openInternal } = attach()
    handler.request({ type: 'other' })
    expect(createTab).not.toHaveBeenCalled()
    expect(openInternal).not.toHaveBeenCalled()
  })
})
