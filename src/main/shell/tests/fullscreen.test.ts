import { describe, expect, it, vi } from 'vitest'
import { HtmlFullscreen, type FullscreenEffects } from '../fullscreen.js'

function effects () {
  return {
    relayout: vi.fn<FullscreenEffects['relayout']>(),
    exitTab: vi.fn<FullscreenEffects['exitTab']>(),
    leaveWindowFullscreen: vi.fn<FullscreenEffects['leaveWindowFullscreen']>(),
    showNotice: vi.fn<FullscreenEffects['showNotice']>(),
    hideNotice: vi.fn<FullscreenEffects['hideNotice']>()
  } satisfies FullscreenEffects
}

const live = (): boolean => true
const gone = (): boolean => false

describe('HtmlFullscreen -- which tab, if any, fills the window', () => {
  it('lets the active tab take the whole window, and says how to leave', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)

    fullscreen.changed('tab-1', true, 'tab-1')

    expect(fullscreen.tabId).toBe('tab-1')
    expect(fx.relayout).toHaveBeenCalledTimes(1)
    expect(fx.showNotice).toHaveBeenCalledTimes(1)
  })

  it('gives the window back to the chrome when that tab leaves', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')

    fullscreen.changed('tab-1', false, 'tab-1')

    expect(fullscreen.tabId).toBeNull()
    expect(fx.hideNotice).toHaveBeenCalledTimes(1)
    expect(fx.relayout).toHaveBeenCalledTimes(2)
  })

  it('sends a tab that is not on screen straight back out, rather than filling the window with a different tab', () => {
    // A click grants a few seconds of activation, so a page can ask after
    // the person has already switched away from it.
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)

    fullscreen.changed('tab-2', true, 'tab-1')

    expect(fullscreen.tabId).toBeNull()
    expect(fx.exitTab).toHaveBeenCalledWith('tab-2')
    expect(fx.relayout).not.toHaveBeenCalled()
  })

  it('ignores a leave from a tab that is not the fullscreen one', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')

    fullscreen.changed('tab-2', false, 'tab-1')

    expect(fullscreen.tabId).toBe('tab-1')
    expect(fx.relayout).toHaveBeenCalledTimes(1)
  })

  it('asks the page to leave when another tab becomes active, and restores the chrome at once', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')

    fullscreen.tabsChanged('tab-2', live)

    expect(fx.exitTab).toHaveBeenCalledWith('tab-1')
    expect(fx.leaveWindowFullscreen).not.toHaveBeenCalled()
    expect(fullscreen.tabId).toBeNull()
    expect(fx.hideNotice).toHaveBeenCalledTimes(1)
    expect(fx.relayout).toHaveBeenCalledTimes(2)
  })

  it('takes the window out of fullscreen itself when the fullscreen tab is gone, since no page is left to do it', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')

    fullscreen.tabsChanged('tab-2', gone)

    expect(fx.exitTab).not.toHaveBeenCalled()
    expect(fx.leaveWindowFullscreen).toHaveBeenCalledTimes(1)
    expect(fullscreen.tabId).toBeNull()
  })

  it('does nothing on a state push that leaves the fullscreen tab active', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')

    fullscreen.tabsChanged('tab-1', live)
    fullscreen.tabsChanged('tab-1', live)

    expect(fullscreen.tabId).toBe('tab-1')
    expect(fx.exitTab).not.toHaveBeenCalled()
    expect(fx.relayout).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a state push when no tab is fullscreen', () => {
    const fx = effects()
    new HtmlFullscreen(fx).tabsChanged('tab-1', gone)
    expect(fx.relayout).not.toHaveBeenCalled()
    expect(fx.leaveWindowFullscreen).not.toHaveBeenCalled()
  })

  it('the leave that follows its own exit request changes nothing further', () => {
    const fx = effects()
    const fullscreen = new HtmlFullscreen(fx)
    fullscreen.changed('tab-1', true, 'tab-1')
    fullscreen.tabsChanged('tab-2', live)

    fullscreen.changed('tab-1', false, 'tab-2')

    expect(fx.relayout).toHaveBeenCalledTimes(2)
    expect(fx.hideNotice).toHaveBeenCalledTimes(1)
  })
})
