import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import type { SettingChange } from '../../settings/settings-store.js'
import { installShellStyle } from '../shell-style-runner.js'
import type { ShellStylePart } from '../shell-style.js'

const shell = { id: 'shell' } as unknown as Session
const other = { id: 'other' } as unknown as Session
const env = { shellSession: shell, internalSession: () => undefined, dashboardUrl: 'file:///newtab.html' }

class FakeSurface extends EventEmitter {
  destroyed = false
  inserted: string[] = []
  removed: string[] = []
  constructor (readonly session: Session, private readonly url = 'file:///chrome.html') { super() }
  getURL (): string { return this.url }
  isDestroyed (): boolean { return this.destroyed }
  insertCSS = vi.fn((css: string): Promise<string> => { this.inserted.push(css); return Promise.resolve(`key-${String(this.inserted.length)}`) })
  removeInsertedCSS = vi.fn((key: string): Promise<void> => { this.removed.push(key); return Promise.resolve() })
}

interface Harness { app: EventEmitter, surfaces: FakeSurface[], change: (key: string) => void, tint: { value: string }, stop: () => void }

function start (parts?: readonly ShellStylePart[]): Harness {
  const app = new EventEmitter()
  const listeners = new Set<(change: SettingChange) => void>()
  const tint = { value: 'red' }
  const settings = { get: () => tint.value, onChange: (listener: (change: SettingChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as never
  const accent: ShellStylePart = { name: 'accent', keys: ['appearance.theme'], css: () => `:root:root{--waccent:${tint.value}}` }
  const stop = installShellStyle(app as never, settings, env, parts ?? [accent])
  return { app, surfaces: [], tint, change: (key) => { for (const listener of listeners) listener({ key: key as never, value: 'x' }) }, stop }
}

const make = (h: Harness, session: Session, url?: string): FakeSurface => {
  const surface = new FakeSurface(session, url)
  h.surfaces.push(surface)
  h.app.emit('web-contents-created', {}, surface)
  return surface
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks() })

describe('installShellStyle', () => {
  it('inserts the stylesheet once a shell surface has its document', async () => {
    const h = start()
    const chrome = make(h, shell)
    await settle()
    expect(chrome.inserted).toEqual([])

    chrome.emit('dom-ready')
    await settle()

    expect(chrome.inserted).toEqual([':root:root{--waccent:red}'])
  })

  it('never styles a site\'s tab', async () => {
    const h = start()
    const site = make(h, other, 'https://example.com/')
    site.emit('dom-ready')
    await settle()

    expect(site.insertCSS).not.toHaveBeenCalled()
  })

  it('styles the new-tab page by its address', async () => {
    const h = start()
    const newTab = make(h, other, 'file:///newtab.html')
    newTab.emit('dom-ready')
    await settle()

    expect(newTab.inserted).toHaveLength(1)
  })

  it('inserts nothing while every part is off', async () => {
    const h = start([{ name: 'off', keys: [], css: () => '' }])
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()

    expect(chrome.insertCSS).not.toHaveBeenCalled()
  })

  it('inserts again for a new document without taking the old sheet out, which went with its document', async () => {
    const h = start()
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()
    chrome.emit('dom-ready')
    await settle()

    expect(chrome.inserted).toHaveLength(2)
    expect(chrome.removeInsertedCSS).not.toHaveBeenCalled()
  })

  it('takes the old sheet out and inserts the new one when a setting a part reads changes', async () => {
    const h = start()
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()

    h.tint.value = 'blue'
    h.change('appearance.theme')
    await settle()

    expect(chrome.removed).toEqual(['key-1'])
    expect(chrome.inserted.at(-1)).toBe(':root:root{--waccent:blue}')
  })

  it('leaves the surfaces alone when an unrelated setting changes', async () => {
    const h = start()
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()

    h.change('search.engine')
    await settle()

    expect(chrome.removeInsertedCSS).not.toHaveBeenCalled()
    expect(chrome.inserted).toHaveLength(1)
  })

  it('takes the sheet out and inserts none when the last part turns off', async () => {
    const tint = { value: 'red' }
    const part: ShellStylePart = { name: 'toggle', keys: ['appearance.theme'], css: () => tint.value === '' ? '' : ':root:root{--x:1}' }
    const h = start([part])
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()

    tint.value = ''
    h.change('appearance.theme')
    await settle()

    expect(chrome.removed).toEqual(['key-1'])
    expect(chrome.inserted).toHaveLength(1)
  })

  it('reaches every live surface, and forgets one that was destroyed', async () => {
    const h = start()
    const one = make(h, shell)
    const two = make(h, shell)
    one.emit('dom-ready')
    two.emit('dom-ready')
    await settle()

    one.destroyed = true
    one.emit('destroyed')
    h.change('appearance.theme')
    await settle()

    expect(one.removeInsertedCSS).not.toHaveBeenCalled()
    expect(two.removeInsertedCSS).toHaveBeenCalledOnce()
  })

  it('logs a failed insert and keeps serving later changes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = start()
    const chrome = make(h, shell)
    chrome.insertCSS.mockRejectedValueOnce(new Error('gone'))
    chrome.emit('dom-ready')
    await settle()
    expect(error).toHaveBeenCalled()

    h.change('appearance.theme')
    await settle()

    expect(chrome.inserted.at(-1)).toBe(':root:root{--waccent:red}')
  })

  it('stops listening to settings when told to', async () => {
    const h = start()
    const chrome = make(h, shell)
    chrome.emit('dom-ready')
    await settle()

    h.stop()
    h.change('appearance.theme')
    await settle()

    expect(chrome.removeInsertedCSS).not.toHaveBeenCalled()
  })
})
