import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BaseWindow, WebContents } from 'electron'
import { DevToolsService } from '../devtools-service.js'
import type { DevToolsDeps } from '../devtools-service.js'

class FakeContents extends EventEmitter {
  opened = false
  destroyed = false
  constructor (public url: string) { super() }
  getURL (): string { return this.url }
  isDestroyed (): boolean { return this.destroyed }
  isDevToolsOpened (): boolean { return this.opened }
  readonly openDevTools = vi.fn((_options: { mode: string }) => { this.opened = true })
  readonly closeDevTools = vi.fn(() => { this.opened = false; this.emit('devtools-closed') })
  readonly inspectElement = vi.fn()
}

interface Values { 'developer.tools': boolean, 'developer.dock': string }

function setup (deps: Partial<DevToolsDeps> = {}, initial: Partial<Values> = {}): {
  service: DevToolsService, values: Values, change: (key: keyof Values, value: boolean | string) => void, confirm: ReturnType<typeof vi.fn>
} {
  const values: Values = { 'developer.tools': true, 'developer.dock': 'right', ...initial }
  const listeners = new Set<(change: { key: string }) => void>()
  const settings = {
    get: (key: keyof Values) => values[key],
    onChange: (listener: (change: { key: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const confirm = vi.fn(() => true)
  const service = new DevToolsService(settings as never, { appOf: () => null, isShellPage: () => false, developerMode: () => false, confirm, ...deps })
  return { service, values, confirm, change: (key, value) => { Object.assign(values, { [key]: value }); for (const listener of listeners) listener({ key }) } }
}

const WINDOW = {} as BaseWindow
const page = (url = 'https://site.example/'): FakeContents => new FakeContents(url)
const as = (contents: FakeContents): WebContents => contents as unknown as WebContents

describe('developer tools', () => {
  it('open where the setting says, and close on the next toggle', () => {
    const { service } = setup({}, { 'developer.dock': 'bottom' })
    const contents = page()
    service.toggle(as(contents), WINDOW)
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'bottom' })
    service.toggle(as(contents), WINDOW)
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
  })

  it('do nothing for no page, a destroyed one, or when the setting is off', () => {
    const { service } = setup({}, { 'developer.tools': false })
    service.toggle(undefined, WINDOW)
    const gone = page()
    gone.destroyed = true
    service.toggle(as(gone), WINDOW)
    const contents = page()
    service.toggle(as(contents), WINDOW)
    service.inspect(as(contents), WINDOW, 1, 2)
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(contents.inspectElement).not.toHaveBeenCalled()
    expect(service.allowed(as(contents))).toBe(false)
  })

  it('close the ones already open when the setting is turned off', () => {
    const { service, change } = setup()
    const contents = page()
    service.toggle(as(contents), WINDOW)
    change('developer.tools', false)
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
  })

  it('open at a point for Inspect, opening first when they are closed', () => {
    const { service } = setup()
    const contents = page()
    service.inspect(as(contents), WINDOW, 10, 20)
    expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    expect(contents.inspectElement).toHaveBeenCalledWith(10, 20)
    service.inspect(as(contents), WINDOW, 3, 4)
    expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    expect(contents.inspectElement).toHaveBeenLastCalledWith(3, 4)
  })

  it('ask once for each app, and open only when the answer is yes', () => {
    const { service, confirm } = setup({ appOf: (contents) => ({ key: `partition-of-${new URL((contents as unknown as FakeContents).url).origin}`, label: new URL((contents as unknown as FakeContents).url).origin }) })
    confirm.mockReturnValueOnce(false)
    const first = page('https://app.example/index.html')
    service.toggle(as(first), WINDOW)
    expect(first.openDevTools).not.toHaveBeenCalled()

    service.toggle(as(first), WINDOW)
    expect(first.openDevTools).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledWith(WINDOW, 'https://app.example')

    const second = page('https://app.example/other')
    service.toggle(as(second), WINDOW)
    expect(second.openDevTools).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(2)

    const another = page('https://other-app.example/')
    service.toggle(as(another), WINDOW)
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('ask about a page by the app it runs as, whatever its address: a popup an app opened has none', () => {
    const { service, confirm } = setup({ appOf: () => ({ key: 'persist:app-1', label: 'this app' }) })
    const popup = page('about:blank')
    service.toggle(as(popup), WINDOW)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(WINDOW, 'this app')
    expect(popup.openDevTools).toHaveBeenCalledTimes(1)

    const sameApp = page('blob:https://app.example/1234')
    service.toggle(as(sameApp), WINDOW)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sameApp.openDevTools).toHaveBeenCalledTimes(1)
  })

  it('never ask for a plain website', () => {
    const { service, confirm } = setup()
    service.toggle(as(page()), WINDOW)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('keep the shell\'s own pages closed to them, except in developer mode', () => {
    const shell = page('orivon://settings/')
    const closed = setup({ isShellPage: () => true })
    closed.service.toggle(as(shell), WINDOW)
    expect(shell.openDevTools).not.toHaveBeenCalled()
    expect(closed.service.allowed(as(shell))).toBe(false)

    const open = setup({ isShellPage: () => true, developerMode: () => true })
    open.service.toggle(as(shell), WINDOW)
    expect(shell.openDevTools).toHaveBeenCalledTimes(1)
  })

  it('close on a page that is no longer the tab\'s, and forget one that is already gone', () => {
    const { service } = setup()
    const contents = page()
    service.toggle(as(contents), WINDOW)
    service.closeFor(as(contents))
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
    const gone = page()
    gone.destroyed = true
    expect(() => { service.closeFor(as(gone)) }).not.toThrow()
  })

  it('take a view whose page is already gone, and forget a page destroyed with its tools open', () => {
    const { service, change } = setup()
    expect(() => { service.closeFor(undefined) }).not.toThrow()
    const contents = page()
    service.toggle(as(contents), WINDOW)
    contents.destroyed = true
    contents.emit('destroyed')
    contents.closeDevTools.mockClear()
    change('developer.tools', false)
    expect(contents.closeDevTools).not.toHaveBeenCalled()
  })

  it('leave no listener behind on a page whose tools were opened and closed again', () => {
    const { service } = setup()
    const contents = page()
    for (let i = 0; i < 30; i++) {
      service.toggle(as(contents), WINDOW)
      service.toggle(as(contents), WINDOW)
    }
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(contents.listenerCount('devtools-closed')).toBe(0)
  })
})
