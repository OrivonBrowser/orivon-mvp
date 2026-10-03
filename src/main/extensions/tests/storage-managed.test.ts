import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'

// UPSTREAM.md patch 63: chrome.storage.managed is an empty, read-only store,
// never an alias of chrome.storage.local. The harness is renderer-seam.test.ts's:
// injectExtensionAPIs runs as source text in a fresh vm context standing in for
// the extension's own realm.
let page: any

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => { page[name] = value },
    executeInMainWorld: ({ func }: { func: () => unknown }) => runInContext(`(${func.toString()})()`, page)
  },
  webFrame: {}
}))

const { injectExtensionAPIs } = await import('../../../../vendor/electron-chrome-extensions/src/renderer/index.js')

const ID = 'b'.repeat(32)

/** A local area holding `items`, as Electron's native one does, with promise and callback forms. */
function fakeLocal (items: Record<string, unknown>): any {
  return {
    get: vi.fn(async () => ({ ...items })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(items, values) })
  }
}

function inject (local: unknown): any {
  page = createContext({ console, Object, Array, Error, Promise, Function, JSON })
  page.chrome = { runtime: { id: ID, getManifest: () => ({ manifest_version: 2, permissions: ['storage'] }) }, i18n: { getMessage: () => '' }, storage: { local } }
  page.location = { href: `chrome-extension://${ID}/background.html`, pathname: '/background.html' }
  page.document = {}
  page.globalThis = page
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  injectExtensionAPIs([])
  return page
}

beforeEach(() => {
  ;(globalThis as any).location = { href: 'test' }
})

describe('chrome.storage.managed', () => {
  it('stays the same size when an extension caches managed storage into local on every start', async () => {
    const items: Record<string, unknown> = { selectedFilterLists: ['easylist'], version: '1.0' }
    const local = fakeLocal(items)
    const g = inject(local)
    // What uBlock Origin's vAPI.adminStorage does each time it is read.
    for (let start = 0; start < 5; start++) {
      const store = await g.chrome.storage.managed.get()
      await g.chrome.storage.local.set({ cachedManagedStorage: store ?? {} })
    }
    expect(items['cachedManagedStorage']).toEqual({})
    expect(JSON.stringify(items).length).toBeLessThan(100)
    expect(local.get).not.toHaveBeenCalled()
  })

  it('answers a callback with an empty object and returns nothing, as Chrome does', () => {
    const g = inject(fakeLocal({ a: 1 }))
    const seen: unknown[] = []
    expect(g.chrome.storage.managed.get(null, (value: unknown) => { seen.push(value) })).toBeUndefined()
    expect(seen).toEqual([{}])
  })

  it('refuses a write, through the promise or the callback', async () => {
    const local = fakeLocal({})
    const g = inject(local)
    await expect(g.chrome.storage.managed.set({ a: 1 })).rejects.toThrow('read-only')
    const seen: unknown[] = []
    expect(g.chrome.storage.managed.remove('a', () => { seen.push(g.chrome.runtime.lastError?.message) })).toBeUndefined()
    expect(seen).toEqual(['This is a read-only store.'])
    expect(g.chrome.runtime.lastError).toBeUndefined()
    expect(local.set).not.toHaveBeenCalled()
  })

  it('keeps sync on the local store', () => {
    const local = fakeLocal({})
    const g = inject(local)
    expect(g.chrome.storage.sync).toBe(g.chrome.storage.local)
  })
})
