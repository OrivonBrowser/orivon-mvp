import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
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
  service: DevToolsService, values: Values, change: (key: keyof Values, value: boolean | string) => void, confirm: ReturnType<typeof vi.fn<(contents: WebContents, label: string) => Promise<boolean>>>
} {
  const values: Values = { 'developer.tools': true, 'developer.dock': 'right', ...initial }
  const listeners = new Set<(change: { key: string }) => void>()
  const settings = {
    get: (key: keyof Values) => values[key],
    onChange: (listener: (change: { key: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const confirm = vi.fn(async (_contents: WebContents, _label: string) => true)
  const service = new DevToolsService(settings as never, { appOf: () => null, isShellPage: () => false, developerMode: () => false, confirm, ...deps })
  return { service, values, confirm, change: (key, value) => { Object.assign(values, { [key]: value }); for (const listener of listeners) listener({ key }) } }
}

const page = (url = 'https://site.example/'): FakeContents => new FakeContents(url)
const as = (contents: FakeContents): WebContents => contents as unknown as WebContents

describe('developer tools', () => {
  it('open where the setting says, and close on the next toggle', async () => {
    const { service } = setup({}, { 'developer.dock': 'bottom' })
    const contents = page()
    await service.toggle(as(contents))
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'bottom' })
    await service.toggle(as(contents))
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
  })

  it('do nothing for no page, a destroyed one, or when the setting is off', async () => {
    const { service } = setup({}, { 'developer.tools': false })
    await service.toggle(undefined)
    const gone = page()
    gone.destroyed = true
    await service.toggle(as(gone))
    const contents = page()
    await service.toggle(as(contents))
    await service.inspect(as(contents), 1, 2)
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(contents.inspectElement).not.toHaveBeenCalled()
    expect(service.allowed(as(contents))).toBe(false)
  })

  it('close the ones already open when the setting is turned off', async () => {
    const { service, change } = setup()
    const contents = page()
    await service.toggle(as(contents))
    change('developer.tools', false)
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
  })

  it('open at a point for Inspect, opening first when they are closed', async () => {
    const { service } = setup()
    const contents = page()
    await service.inspect(as(contents), 10, 20)
    expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    expect(contents.inspectElement).toHaveBeenCalledWith(10, 20)
    await service.inspect(as(contents), 3, 4)
    expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    expect(contents.inspectElement).toHaveBeenLastCalledWith(3, 4)
  })

  it('ask once for each app, and open only when the answer is yes', async () => {
    const { service, confirm } = setup({ appOf: (contents) => ({ key: `partition-of-${new URL((contents as unknown as FakeContents).url).origin}`, label: new URL((contents as unknown as FakeContents).url).origin }) })
    confirm.mockResolvedValueOnce(false)
    const first = page('https://app.example/index.html')
    await service.toggle(as(first))
    expect(first.openDevTools).not.toHaveBeenCalled()

    await service.toggle(as(first))
    expect(first.openDevTools).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledWith(first, 'https://app.example')

    const second = page('https://app.example/other')
    await service.toggle(as(second))
    expect(second.openDevTools).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(2)

    const another = page('https://other-app.example/')
    await service.toggle(as(another))
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('ask about a page by the app it runs as, whatever its address: a popup an app opened has none', async () => {
    const { service, confirm } = setup({ appOf: () => ({ key: 'persist:app-1', label: 'this app' }) })
    const popup = page('about:blank')
    await service.toggle(as(popup))
    expect(confirm).toHaveBeenCalledExactlyOnceWith(popup, 'this app')
    expect(popup.openDevTools).toHaveBeenCalledTimes(1)

    const sameApp = page('blob:https://app.example/1234')
    await service.toggle(as(sameApp))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sameApp.openDevTools).toHaveBeenCalledTimes(1)
  })

  it('never ask for a plain website', async () => {
    const { service, confirm } = setup()
    await service.toggle(as(page()))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('keep the shell\'s own pages closed to them, except in developer mode', async () => {
    const shell = page('orivon://settings/')
    const closed = setup({ isShellPage: () => true })
    await closed.service.toggle(as(shell))
    expect(shell.openDevTools).not.toHaveBeenCalled()
    expect(closed.service.allowed(as(shell))).toBe(false)

    const open = setup({ isShellPage: () => true, developerMode: () => true })
    await open.service.toggle(as(shell))
    expect(shell.openDevTools).toHaveBeenCalledTimes(1)
  })

  it('close on a page that is no longer the tab\'s, and forget one that is already gone', async () => {
    const { service } = setup()
    const contents = page()
    await service.toggle(as(contents))
    service.closeFor(as(contents))
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1)
    const gone = page()
    gone.destroyed = true
    expect(() => { service.closeFor(as(gone)) }).not.toThrow()
  })

  it('take a view whose page is already gone, and forget a page destroyed with its tools open', async () => {
    const { service, change } = setup()
    expect(() => { service.closeFor(undefined) }).not.toThrow()
    const contents = page()
    await service.toggle(as(contents))
    contents.destroyed = true
    contents.emit('destroyed')
    contents.closeDevTools.mockClear()
    change('developer.tools', false)
    expect(contents.closeDevTools).not.toHaveBeenCalled()
  })
  describe('while the question is open', () => {
    const app = (contents: unknown): { key: string, label: string } => ({ key: `app:${(contents as FakeContents).url}`, label: 'the app' })

    it('does not ask twice when asked again before the first is answered', async () => {
      let answer: (yes: boolean) => void = () => {}
      const { service, confirm } = setup({ appOf: app })
      confirm.mockImplementation(async () => await new Promise<boolean>((resolve) => { answer = resolve }))
      const contents = page('https://app.example/')
      const first = service.toggle(as(contents))
      const second = service.toggle(as(contents))
      await second
      expect(confirm).toHaveBeenCalledTimes(1)
      answer(true)
      await first
      expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    })

    it('opens nothing when the page was destroyed while the question was open', async () => {
      const { service, confirm } = setup({ appOf: app })
      const contents = page('https://app.example/')
      confirm.mockImplementation(async () => { contents.destroyed = true; return true })
      await service.toggle(as(contents))
      expect(contents.openDevTools).not.toHaveBeenCalled()
    })

    it('opens nothing, and remembers no yes, when the tab moved to another app while the question was open', async () => {
      const { service, confirm } = setup({ appOf: app })
      const contents = page('https://app.example/')
      confirm.mockImplementation(async () => { contents.url = 'https://other.example/'; return true })
      await service.toggle(as(contents))
      expect(contents.openDevTools).not.toHaveBeenCalled()
      contents.url = 'https://app.example/'
      confirm.mockImplementation(async () => true)
      await service.toggle(as(contents))
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(contents.openDevTools).toHaveBeenCalledTimes(1)
    })

    it('opens nothing when the setting was turned off while the question was open', async () => {
      const { service, confirm, change } = setup({ appOf: app })
      const contents = page('https://app.example/')
      confirm.mockImplementation(async () => { change('developer.tools', false); return true })
      await service.toggle(as(contents))
      expect(contents.openDevTools).not.toHaveBeenCalled()
    })
  })
})
