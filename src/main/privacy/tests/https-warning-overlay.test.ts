import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { createHttpsWarning, httpsWarningOverlay } from '../https-warning-overlay.js'
import { createHttpsState } from '../https-state.js'

interface Rig {
  handler: ReturnType<typeof createHttpsWarning>
  state: ReturnType<typeof createHttpsState>
  navigate: ReturnType<typeof vi.fn>
  back: ReturnType<typeof vi.fn>
  closeTab: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function rig (canGoBack: boolean): Rig {
  const state = createHttpsState()
  state.failed.set('a', { from: 'http://site.example/page', host: 'site.example' })
  const navigate = vi.fn()
  const back = vi.fn()
  const closeTab = vi.fn()
  const close = vi.fn()
  const win = {
    window: { tabs: { getState: () => ({ tabs: [{ id: 'a', canGoBack }] }), navigate, back, closeTab } },
    close
  } as unknown as OverlayWindow
  return { handler: createHttpsWarning(win, state), state, navigate, back, closeTab, close }
}

describe('the https-warning overlay', () => {
  it('is a sheet over the tab that only a tab switch hides', () => {
    expect(httpsWarningOverlay.placement).toEqual({ kind: 'area', at: 'center', width: 440 })
    expect(httpsWarningOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
    expect(httpsWarningOverlay.layer).toBe('bar')
    expect(httpsWarningOverlay.focus).toBe('take')
    expect(httpsWarningOverlay.keep).toBe('fresh')
  })

  describe('show', () => {
    it('tells the page the host and whether there is a page to go back to', () => {
      expect(rig(true).handler.show?.({ tabId: 'a' })).toEqual({ host: 'site.example', canGoBack: true })
      expect(rig(false).handler.show?.({ tabId: 'a' })).toEqual({ host: 'site.example', canGoBack: false })
    })

    it('shows nothing for a tab with no failed upgrade, or a payload that is not a tab id', () => {
      const { handler } = rig(true)
      expect(handler.show?.({ tabId: 'b' })).toBeUndefined()
      expect(handler.show?.({ tabId: 7 })).toBeUndefined()
      expect(handler.show?.(null)).toBeUndefined()
      expect(handler.show?.(undefined)).toBeUndefined()
    })
  })

  describe('request', () => {
    it('proceed exempts the host, closes and opens the stored http address', () => {
      const r = rig(true)
      r.handler.show?.({ tabId: 'a' })
      r.handler.request({ type: 'proceed' })
      expect(r.state.exemptions.has('site.example')).toBe(true)
      expect(r.close).toHaveBeenCalledTimes(1)
      expect(r.navigate).toHaveBeenCalledWith('a', 'http://site.example/page')
    })

    it('proceed cannot be steered: an address or id in the command is refused', () => {
      const r = rig(true)
      r.handler.show?.({ tabId: 'a' })
      r.handler.request({ type: 'proceed', url: 'http://evil.example/' })
      r.handler.request({ type: 'proceed', tabId: 'b' })
      expect(r.navigate).not.toHaveBeenCalled()
      expect(r.state.exemptions.has('evil.example')).toBe(false)
    })

    it('back goes back when there is somewhere to go', () => {
      const r = rig(true)
      r.handler.show?.({ tabId: 'a' })
      r.handler.request({ type: 'back' })
      expect(r.back).toHaveBeenCalledWith('a')
      expect(r.closeTab).not.toHaveBeenCalled()
      expect(r.state.exemptions.has('site.example')).toBe(false)
    })

    it('back closes the tab when there is no history', () => {
      const r = rig(false)
      r.handler.show?.({ tabId: 'a' })
      r.handler.request({ type: 'back' })
      expect(r.closeTab).toHaveBeenCalledWith('a')
      expect(r.back).not.toHaveBeenCalled()
    })

    it('ignores a command before any show, an unknown word and non-objects', () => {
      const r = rig(true)
      r.handler.request({ type: 'proceed' })
      r.handler.show?.({ tabId: 'a' })
      for (const command of [{ type: 'other' }, null, 'proceed', 7, {}]) r.handler.request(command)
      expect(r.navigate).not.toHaveBeenCalled()
      expect(r.back).not.toHaveBeenCalled()
    })

    it('just closes when the failed upgrade is gone', () => {
      const r = rig(true)
      r.handler.show?.({ tabId: 'a' })
      r.state.failed.clear('a')
      r.handler.request({ type: 'proceed' })
      expect(r.close).toHaveBeenCalled()
      expect(r.navigate).not.toHaveBeenCalled()
    })
  })
})
