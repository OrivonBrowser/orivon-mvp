import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'

// UPSTREAM.md patch 45: injectExtensionAPIs runs mainWorldScript, then each
// extra, then finalizeScript, each as source text in the page's own realm
// (here a fresh vm context, so a closure variable would be a ReferenceError).
// `electron` in the page is the bridge object the preload exposes.
const invoke = vi.fn()
let page: any

vi.mock('electron', () => ({
  ipcRenderer: { invoke, send: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => { page[name] = value },
    executeInMainWorld: ({ func }: { func: () => unknown }) => runInContext(`(${func.toString()})()`, page)
  },
  webFrame: {}
}))

const { injectExtensionAPIs } = await import('../../../../vendor/electron-chrome-extensions/src/renderer/index.js')

const ID = 'a'.repeat(32)

function newPage (manifest: Record<string, unknown>, opts: { worker?: boolean, path?: string } = {}): any {
  const g: any = createContext({ console, Object, Array, Error, Promise, Function })
  g.chrome = { runtime: { id: ID, getManifest: () => manifest }, i18n: { getMessage: () => '' } }
  g.location = { href: `chrome-extension://${ID}${opts.path ?? '/page.html'}`, pathname: opts.path ?? '/page.html' }
  if (opts.worker !== true) g.document = {}
  g.globalThis = g
  return g
}

function inject (manifest: Record<string, unknown>, extras: Array<() => void> = [], opts: { worker?: boolean, path?: string } = {}): any {
  page = newPage(manifest, opts)
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  injectExtensionAPIs(extras)
  return page
}

beforeEach(() => {
  invoke.mockReset()
  ;(globalThis as any).location = { href: 'test' }
})

describe('injectExtensionAPIs with extras', () => {
  it('runs the extras after the library namespaces and before the lock, with __crx in reach', () => {
    const extra = (): void => {
      const g = globalThis as any
      const crx = g.__crx
      g.__seen = [typeof crx, typeof g.electron, Object.isFrozen(g.chrome), typeof g.chrome.tabs, crx.extensionId.length, crx.context]
      crx.define('orivonNs', (base: unknown) => ({ base: base === undefined, perm: crx.declares('history'), granted: crx.declares('tabs') }))
    }
    const g = inject({ manifest_version: 3, permissions: ['tabs'], optional_permissions: ['history'] }, [extra])
    expect(g.__seen).toEqual(['object', 'object', false, 'object', 32, 'page'])
    expect(g.chrome.orivonNs).toEqual({ base: true, perm: true, granted: true })
    expect(Object.keys(g.chrome)).not.toContain('orivonNs')
  })

  it('removes __crx and the electron bridge, locks chrome and freezes it afterwards', () => {
    const g = inject({ manifest_version: 3 }, [() => { (globalThis as any).__crx.define('x', () => ({})) }])
    expect(g.__crx).toBeUndefined()
    expect(g.electron).toBeUndefined()
    expect(Object.isFrozen(g.chrome)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(g, 'chrome')).toMatchObject({ configurable: false, writable: false })
  })

  it('reports a worker as the context of a document-less realm', () => {
    const g = inject({ manifest_version: 3 }, [() => { (globalThis as any).__seen = (globalThis as any).__crx.context }], { worker: true })
    expect(g.__seen).toBe('worker')
  })

  it('still locks the page when an extra throws, and the other extras still run', () => {
    const g = inject({ manifest_version: 3 }, [
      () => { throw new Error('boom') },
      () => { (globalThis as any).__ran = true }
    ])
    expect(g.__ran).toBe(true)
    expect(g.__crx).toBeUndefined()
    expect(Object.isFrozen(g.chrome)).toBe(true)
  })

  it('works with no extras at all, as the library alone always did', () => {
    const g = inject({ manifest_version: 3 })
    expect(g.__crx).toBeUndefined()
    expect(Object.isFrozen(g.chrome)).toBe(true)
  })
})

describe('the manifest.devtools_page document', () => {
  it('keeps chrome unfrozen so Electron can attach chrome.devtools afterwards', () => {
    const g = inject({ manifest_version: 3, devtools_page: 'devtools.html' }, [], { path: '/devtools.html' })
    expect(Object.isFrozen(g.chrome)).toBe(false)
    expect(g.__crx).toBeUndefined()
    expect(g.electron).toBeUndefined()
    g.chrome.devtools = { panels: {} }
    expect(typeof g.chrome.devtools).toBe('object')
  })

  it('freezes every other document of an extension that has a devtools page', () => {
    const g = inject({ manifest_version: 3, devtools_page: 'devtools.html' }, [], { path: '/popup.html' })
    expect(Object.isFrozen(g.chrome)).toBe(true)
  })
})

describe('__crx.call is strict', () => {
  const callFrom = (extra: () => void): any => inject({ manifest_version: 3 }, [extra])

  it('rejects with the handler message, the IPC prefix removed', async () => {
    invoke.mockRejectedValue(new Error("Error invoking remote method 'crx-msg': Error: history.search needs a query"))
    const g = callFrom(() => {
      const crx = (globalThis as any).__crx
      ;(globalThis as any).__call = crx.call('history.search')
    })
    await expect(g.__call({})).rejects.toThrow(/^history\.search needs a query$/)
    expect(invoke).toHaveBeenCalledWith('crx-msg', ID, 'history.search', {})
  })

  it('resolves the handler result', async () => {
    invoke.mockResolvedValue([1, 2])
    const g = callFrom(() => { (globalThis as any).__call = (globalThis as any).__crx.call('history.search') })
    await expect(g.__call({})).resolves.toEqual([1, 2])
  })

  it('with a trailing callback logs the error and calls back undefined, never rejecting', async () => {
    invoke.mockRejectedValue(new Error("Error invoking remote method 'crx-msg': Error: nope"))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = callFrom(() => { (globalThis as any).__call = (globalThis as any).__crx.call('history.search') })
    const callback = vi.fn()
    await g.__call({}, callback)
    expect(callback).toHaveBeenCalledWith(undefined)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('the library namespaces keep their old error handling', () => {
  it('an IPC error in a library call still resolves undefined', async () => {
    invoke.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = inject({ manifest_version: 3, permissions: ['tabs'] })
    await expect(g.chrome.tabs.query({})).resolves.toBeUndefined()
    error.mockRestore()
  })
})
