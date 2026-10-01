import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { certErrorOverlay } from '../cert-error-overlay.js'
import { certErrorText, isCertError } from '../cert-error-text.js'
import { hostOfFailure, watchCertErrors } from '../cert-error-watch.js'

describe('certificate error codes', () => {
  it('knows the certificate block of network errors and nothing else', () => {
    for (const code of [-200, -202, -207, -215, -220]) expect(isCertError(code), String(code)).toBe(true)
    for (const code of [-199, -221, -105, -3, 0, 200, -202.5, Number.NaN]) expect(isCertError(code), String(code)).toBe(false)
  })

  it('says one sentence for each, and a fallback for the rest of the block', () => {
    expect(certErrorText(-202)).toBe('The certificate was not issued by an authority this computer trusts.')
    expect(certErrorText(-201)).toContain('date and time')
    expect(certErrorText(-219)).toBe('The certificate could not be verified.')
  })
})

describe('the certificate-error overlay', () => {
  function setup (canGoBack = true): { handler: OverlayHandler, close: ReturnType<typeof vi.fn>, back: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn>, state: { active: string } } {
    const state = { active: 't1' }
    const back = vi.fn()
    const createTab = vi.fn()
    const window = { tabs: { getState: () => ({ activeTabId: state.active, tabs: [{ id: 't1', canGoBack, isNewTab: false }] }), back, createTab, navigate: vi.fn() } }
    const close = vi.fn()
    const services = { settings: { get: () => '' } }
    const handler = certErrorOverlay.attach({ window, services, send: vi.fn(), close } as unknown as OverlayWindow)
    return { handler, close, back, createTab, state }
  }

  it('is a centred bar sheet that a tab switch hides and a click elsewhere leaves alone', () => {
    expect(certErrorOverlay).toMatchObject({ name: 'cert-error', placement: { kind: 'area', at: 'center', width: 420 }, focus: 'take', layer: 'bar' })
    expect(certErrorOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
  })

  it('draws the host and the sentence for the code, and nothing a page could have written', () => {
    const s = setup()
    expect(s.handler.show?.({ host: 'bad.example', code: -202, text: 'Send money' })).toEqual({ host: 'bad.example', text: 'The certificate was not issued by an authority this computer trusts.' })
    for (const bad of [undefined, null, {}, { host: '', code: -202 }, { host: 'x'.repeat(300), code: -202 }, { host: 'a', code: -3 }, { host: 'a', code: '-202' }]) expect(s.handler.show?.(bad)).toBeUndefined()
  })

  it('goes back, when it can, and closes', () => {
    const s = setup()
    s.handler.show?.({ host: 'bad.example', code: -202 })
    s.handler.request({ type: 'back' })
    expect(s.close).toHaveBeenCalledOnce()
    expect(s.back).toHaveBeenCalledWith('t1')
  })

  it('goes to the home page when there is nowhere back', () => {
    const s = setup(false)
    s.handler.show?.({ host: 'bad.example', code: -202 })
    s.handler.request({ type: 'back' })
    expect(s.back).not.toHaveBeenCalled()
    expect(s.createTab).toHaveBeenCalled()
  })

  it('refuses every other command, extra fields, a tab that is not in front and a sheet never shown', () => {
    const s = setup()
    s.handler.request({ type: 'back' })
    s.handler.show?.({ host: 'bad.example', code: -202 })
    for (const bad of [undefined, null, 'back', {}, { type: 'proceed' }, { type: 'back', url: 'x' }]) s.handler.request(bad)
    s.state.active = 't2'
    s.handler.request({ type: 'back' })
    expect(s.close).not.toHaveBeenCalled()
    expect(s.back).not.toHaveBeenCalled()
  })
})

describe('watching a tab for a certificate failure', () => {
  const WINDOW = {} as ShellWindow
  function setup (): { contents: EventEmitter, asks: SlotAsk[], cancel: ReturnType<typeof vi.fn>, deps: Parameters<typeof watchCertErrors>[1] } {
    const contents = new EventEmitter()
    const asks: SlotAsk[] = []
    const cancel = vi.fn()
    return {
      contents, asks, cancel,
      deps: { findTab: (candidate) => candidate === (contents as unknown as WebContents) ? { window: WINDOW, tabId: 't1' } : null, ask: (ask) => { asks.push(ask); return { cancel } } }
    }
  }
  const fail = (contents: EventEmitter, code: number, url: string, main = true): void => { contents.emit('did-fail-load', {}, code, 'desc', url, main) }

  it('asks for the sheet when a main frame fails on its certificate', () => {
    const s = setup()
    watchCertErrors(s.contents as unknown as WebContents, s.deps)
    fail(s.contents, -202, 'https://bad.example/login')
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({ window: WINDOW, tabId: 't1', slot: 'center', overlay: 'cert-error', payload: { host: 'bad.example', code: -202 } })
  })

  it('stays out of a failure another sheet claims, such as an upgraded address that has no valid certificate', () => {
    const s = setup()
    const claimed = vi.fn((_id: number, url: string, _code: number) => url === 'https://upgraded.example/')
    watchCertErrors(s.contents as unknown as WebContents, { ...s.deps, claimed })
    fail(s.contents, -202, 'https://upgraded.example/')
    expect(s.asks).toHaveLength(0)
    fail(s.contents, -202, 'https://typed.example/')
    expect(s.asks).toHaveLength(1)
    expect(claimed).toHaveBeenCalledWith(expect.anything(), 'https://upgraded.example/', -202)
  })

  it('ignores other failures, a sub frame, an address that is not https and a web contents that is not a tab', () => {
    const s = setup()
    watchCertErrors(s.contents as unknown as WebContents, s.deps)
    fail(s.contents, -105, 'https://bad.example/')
    fail(s.contents, -202, 'https://bad.example/', false)
    fail(s.contents, -202, 'http://bad.example/')
    fail(s.contents, -202, 'nonsense')
    const other = setup()
    watchCertErrors(other.contents as unknown as WebContents, { ...other.deps, findTab: () => null })
    fail(other.contents, -202, 'https://bad.example/')
    expect(s.asks).toHaveLength(0)
    expect(other.asks).toHaveLength(0)
  })

  it('takes the sheet away when the tab navigates on, and replaces it when it fails again', () => {
    const s = setup()
    watchCertErrors(s.contents as unknown as WebContents, s.deps)
    fail(s.contents, -202, 'https://bad.example/')
    s.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    s.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(s.cancel).not.toHaveBeenCalled()
    s.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(s.cancel).toHaveBeenCalledOnce()
    fail(s.contents, -201, 'https://bad.example/')
    fail(s.contents, -201, 'https://bad.example/')
    expect(s.cancel).toHaveBeenCalledTimes(2)
    expect(s.asks).toHaveLength(3)
  })

  it('watches a web contents once', () => {
    const s = setup()
    watchCertErrors(s.contents as unknown as WebContents, s.deps)
    watchCertErrors(s.contents as unknown as WebContents, s.deps)
    fail(s.contents, -202, 'https://bad.example/')
    expect(s.asks).toHaveLength(1)
  })

  it('reads the host of an https address only', () => {
    expect(hostOfFailure('https://a.test:8443/x')).toBe('a.test:8443')
    for (const url of ['http://a.test/', 'ftp://a.test/', '', 'x']) expect(hostOfFailure(url)).toBeUndefined()
  })
})
