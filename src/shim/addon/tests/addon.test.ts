// A native addon's WebAssembly build, loaded through emnapi: a hand-assembled
// Node-API module (no toolchain, ADR-0002) whose napi_register_wasm_v1 sets
// two exports and prints through WASI.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import { createRequire } from '../../polyfills/module.js'
import { napiAddon, threadedAddon } from './support/napi-addons.js'
import { dlopen, loadAddon, preloadAddon } from '../index.js'
import { addonUrls } from '../resolve.js'

const ORIGIN = 'https://app.test'
/** A synchronous XMLHttpRequest over a map of paths, as a Worker's (responseType 'arraybuffer'). */
function serveSync (files: Record<string, Uint8Array>): string[] {
  const requested: string[] = []
  class FakeRequest {
    status = 0
    response: ArrayBuffer | null = null
    responseType = ''
    #url = ''
    open (_method: string, url: string): void { this.#url = url }
    overrideMimeType (): void {}
    send (): void {
      requested.push(new URL(this.#url).pathname)
      const bytes = files[new URL(this.#url).pathname]
      this.status = bytes === undefined ? 404 : 200
      this.response = bytes === undefined ? null : bytes.slice().buffer
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  vi.stubGlobal('location', { origin: ORIGIN })
  return requested
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('addonUrls', () => {
  it('names the three places a build tool puts a WebAssembly build beside the .node path', () => {
    expect(addonUrls('/native/addon.node', ORIGIN)).toEqual([
      `${ORIGIN}/native/addon.node.wasm`, `${ORIGIN}/native/addon.wasm`, `${ORIGIN}/native/addon.wasm32-wasi.wasm`
    ])
    expect(addonUrls('//elsewhere.test/addon.node', ORIGIN)).toEqual([])
  })
})

describe('loadAddon', () => {
  it('loads the WebAssembly build through Node-API: its exports, and its stdout on the console', () => {
    serveSync({ '/lib/answer.wasm': napiAddon() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exports = loadAddon('/lib/answer.node') as { answer: number, greet: string }
    expect(exports.answer).toBe(42)
    expect(exports.greet).toBe('hello from wasm')
    expect(log).toHaveBeenCalledWith('loaded')
  })

  it('loads each addon once, as Node caches a dlopen', () => {
    const requested = serveSync({ '/lib/once.node.wasm': napiAddon() })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(loadAddon('/lib/once.node')).toBe(loadAddon('/lib/once.node'))
    expect(requested.filter((path) => path === '/lib/once.node.wasm')).toHaveLength(1)
  })

  it('is ERR_DLOPEN_FAILED, naming where it looked, when there is no WebAssembly build', () => {
    serveSync({})
    expect(() => loadAddon('/lib/missing.node')).toThrow(expect.objectContaining({ code: 'ERR_DLOPEN_FAILED', reason: 'excluded' }))
    expect(() => loadAddon('/lib/missing.node')).toThrow(/missing\.wasm32-wasi\.wasm/)
  })

  it('refuses a threaded build by name, since it needs Workers sharing its memory', () => {
    serveSync({ '/lib/threaded.wasm': threadedAddon() })
    expect(() => loadAddon('/lib/threaded.node')).toThrow(OrivonShimError)
  })
})

describe('the routes in', () => {
  it('process.dlopen sets module.exports, as Node\'s does', () => {
    serveSync({ '/lib/dl.wasm': napiAddon() })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const module = { exports: {} as unknown }
    dlopen(module, '/lib/dl.node')
    expect((module.exports as { answer: number }).answer).toBe(42)
  })

  it('createRequire loads a .node path relative to its module, and refuses any other run-time require', () => {
    const requested = serveSync({ '/app/native/rel.wasm': napiAddon() })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const require = createRequire('/app/main.js')
    expect((require('./native/rel.node') as { answer: number }).answer).toBe(42)
    expect(requested).toContain('/app/native/rel.node.wasm')
    expect(require.resolve('./native/rel.node')).toBe('/app/native/rel.node')
    expect(() => require('lodash')).toThrow(OrivonShimError)
  })

  it('preloadAddon loads asynchronously, and a later synchronous load finds it without fetching', async () => {
    const requested = serveSync({})
    vi.stubGlobal('fetch', async (url: string) => new URL(url).pathname === '/lib/big.wasm' ? new Response(napiAddon()) : new Response(null, { status: 404 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await preloadAddon('/lib/big.node')
    expect((loadAddon('/lib/big.node') as { answer: number }).answer).toBe(42)
    expect(requested).toHaveLength(0)
  })
})
