import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { storeOverridesScript } from '../../../../vendor/electron-chrome-web-store/src/renderer/store-overrides.js'

interface Page { readonly context: vm.Context, run: (code: string) => unknown }

/** A page's main world with the objects the preload's context bridge exposes, and a `chrome` the way
 * the renderer leaves it. */
function page (chromeSource: string): Page {
  const context = vm.createContext({})
  const run = (code: string): unknown => vm.runInContext(code, context)
  run(`globalThis.electronWebstore = { tag: 'webstore' };
    globalThis.electronManagement = { tag: 'management', getAll () { return 'ours' } };
    globalThis.electronRuntime = { lastError: null, getManifest () { return {} } };
    ${chromeSource}`)
  return { context, run }
}

describe('storeOverridesScript', () => {
  it('puts the store API on chrome.webstorePrivate', () => {
    const p = page("globalThis.chrome = { runtime: { id: 'x' } }")
    p.run(storeOverridesScript())
    expect(p.run('chrome.webstorePrivate === electronWebstore')).toBe(true)
  })

  it('keeps both overrides when the bindings rebuild redefines them', () => {
    const p = page("globalThis.chrome = { runtime: { id: 'x' }, management: { native: true, getAll () { return 'native' } } }")
    p.run(storeOverridesScript())
    const rebuilt = p.run(`[
      Reflect.defineProperty(chrome, 'webstorePrivate', { value: { tag: 'native' }, configurable: true }),
      Reflect.defineProperty(chrome, 'management', { value: { tag: 'native' }, configurable: true }),
      chrome.webstorePrivate === electronWebstore,
      chrome.management.tag,
      chrome.management.getAll()
    ]`) as unknown[]
    expect(rebuilt).toEqual([false, false, true, 'management', 'ours'])
  })

  it('merges the native management object with ours', () => {
    const p = page("globalThis.chrome = { management: { native: true, getAll () { return 'native' }, onEnabled: 'kept' } }")
    p.run(storeOverridesScript())
    expect(p.run('[chrome.management.native, chrome.management.onEnabled, chrome.management.getAll()]')).toEqual([true, 'kept', 'ours'])
  })

  it('a plain assignment to either leaves ours in place', () => {
    const p = page("globalThis.chrome = { runtime: {} }")
    p.run(storeOverridesScript())
    expect(p.run(`(() => { try { chrome.webstorePrivate = {} ; chrome.management = {} } catch (e) {} return [chrome.webstorePrivate === electronWebstore, chrome.management.tag] })()`)).toEqual([true, 'management'])
  })

  it('works with no chrome.runtime, and merges ours into it when there is one', () => {
    const bare = page('globalThis.chrome = {}')
    expect(() => bare.run(storeOverridesScript())).not.toThrow()
    expect(bare.run('chrome.webstorePrivate === electronWebstore && chrome.management.tag')).toBe('management')
    const withRuntime = page("globalThis.chrome = { runtime: { id: 'x' } }")
    withRuntime.run(storeOverridesScript())
    expect(withRuntime.run('[chrome.runtime.id, typeof chrome.runtime.getManifest]')).toEqual(['x', 'function'])
  })

  it('throws nothing when a property is already locked, and still sets the others', () => {
    const p = page("globalThis.chrome = {}; Object.defineProperty(chrome, 'management', { value: { locked: true }, configurable: false })")
    expect(() => p.run(storeOverridesScript())).not.toThrow()
    expect(p.run('chrome.webstorePrivate === electronWebstore')).toBe(true)
  })

  it('does nothing and throws nothing when the page has no chrome object', () => {
    const p = page('')
    expect(() => p.run(storeOverridesScript())).not.toThrow()
  })
})
