import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'

// The page's `electron` is a bridge: a callback it passes arrives in the preload as a fresh
// function on every call, so removal can only match through what the page holds.
const emitter = new EventEmitter()
const send = vi.fn()
let page: any

const crossBridge = (value: unknown): unknown =>
  typeof value === 'function' ? (...args: unknown[]) => value(...args) : value

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    send,
    addListener: (name: string, fn: (...a: unknown[]) => void) => emitter.addListener(name, fn),
    removeListener: (name: string, fn: (...a: unknown[]) => void) => emitter.removeListener(name, fn),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: Record<string, (...a: unknown[]) => unknown>) => {
      page[name] = name === 'electron'
        ? Object.fromEntries(Object.entries(value).map(([k, fn]) => [k, (...args: unknown[]) => fn(...args.map(crossBridge))]))
        : value
    },
    executeInMainWorld: ({ func }: { func: () => unknown }) => runInContext(`(${func.toString()})()`, page)
  },
  webFrame: {}
}))


const ID = 'a'.repeat(32)

function newPage (): any {
  const g: any = createContext({ console, Object, Array, Error, Promise, Function, Map, Set })
  g.chrome = { runtime: { id: ID, getManifest: () => ({ manifest_version: 3, permissions: ['tabs'] }) }, i18n: { getMessage: () => '' } }
  g.location = { href: `chrome-extension://${ID}/page.html`, pathname: '/page.html' }
  g.document = {}
  g.globalThis = g
  return g
}

const sentFor = (channel: string): unknown[][] => send.mock.calls.filter((c) => c[0] === channel)

beforeEach(async () => {
  // The registrations live in module state, one per realm; each test is a new realm.
  vi.resetModules()
  const { injectExtensionAPIs } = await import('../../../../vendor/electron-chrome-extensions/src/renderer/index.js')
  emitter.removeAllListeners()
  send.mockReset()
  page = newPage()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  injectExtensionAPIs([])
})

describe('a library event\'s listeners', () => {
  it('stops calling a listener once it is removed', () => {
    const l = vi.fn()
    page.chrome.tabs.onUpdated.addListener(l)
    emitter.emit('crx-tabs.onUpdated', {}, 1)
    page.chrome.tabs.onUpdated.removeListener(l)
    emitter.emit('crx-tabs.onUpdated', {}, 2)
    expect(l.mock.calls).toEqual([[1]])
  })

  it('keeps the other listeners and the subscription when a stale remove repeats', () => {
    const temporary = vi.fn()
    const permanent = vi.fn()
    page.chrome.tabs.onUpdated.addListener(permanent)
    page.chrome.tabs.onUpdated.addListener(temporary)
    page.chrome.tabs.onUpdated.removeListener(temporary)
    page.chrome.tabs.onUpdated.removeListener(temporary)
    page.chrome.tabs.onUpdated.removeListener(temporary)
    emitter.emit('crx-tabs.onUpdated', {}, 3)
    expect(permanent).toHaveBeenCalledWith(3)
    expect(sentFor('crx-remove-listener')).toEqual([])
  })

  it('subscribes once per event and unsubscribes when the last listener goes', () => {
    const a = vi.fn()
    const b = vi.fn()
    page.chrome.tabs.onUpdated.addListener(a)
    page.chrome.tabs.onUpdated.addListener(b)
    expect(sentFor('crx-add-listener')).toEqual([['crx-add-listener', ID, 'tabs.onUpdated']])
    page.chrome.tabs.onUpdated.removeListener(a)
    expect(sentFor('crx-remove-listener')).toEqual([])
    page.chrome.tabs.onUpdated.removeListener(b)
    expect(sentFor('crx-remove-listener')).toEqual([['crx-remove-listener', ID, 'tabs.onUpdated']])
  })

  it('registers the same callback once, as Chrome does', () => {
    const l = vi.fn()
    page.chrome.tabs.onUpdated.addListener(l)
    page.chrome.tabs.onUpdated.addListener(l)
    emitter.emit('crx-tabs.onUpdated', {}, 4)
    expect(l).toHaveBeenCalledTimes(1)
  })

  it('answers hasListener and hasListeners from what is registered', () => {
    const l = vi.fn()
    const event = page.chrome.tabs.onUpdated
    expect(event.hasListeners()).toBe(false)
    expect(event.hasListener(l)).toBe(false)
    event.addListener(l)
    expect(event.hasListeners()).toBe(true)
    expect(event.hasListener(l)).toBe(true)
    event.removeListener(l)
    expect(event.hasListener(l)).toBe(false)
    expect(event.hasListeners()).toBe(false)
  })
})
