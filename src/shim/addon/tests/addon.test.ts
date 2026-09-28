// A native addon's WebAssembly build, loaded through emnapi: a hand-assembled
// Node-API module (no toolchain, ADR-0002) whose napi_register_wasm_v1 sets
// two exports and prints through WASI.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import { createRequire } from '../../polyfills/module.js'
import { commandAddon, napiAddon, threadedAddon } from './support/napi-addons.js'
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
  it('loads the WebAssembly build through Node-API: its exports, and its stdout on process.stdout, as Node\'s', () => {
    serveSync({ '/lib/answer.wasm': napiAddon() })
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(new TextDecoder().decode(chunk as Uint8Array)); return true })
    const exports = loadAddon('/lib/answer.node') as { answer: number, greet: string }
    expect(exports.answer).toBe(42)
    expect(exports.greet).toBe('hello from wasm')
    expect(written.join('')).toBe('loaded\n')
  })

  it('keys an addon by its path however it is spelled: a URL, a file: URL, or with . segments', () => {
    const requested = serveSync({ '/lib/spelled.wasm': napiAddon() })
    const first = loadAddon('/lib/spelled.node')
    expect(loadAddon(`${ORIGIN}/lib/spelled.node`)).toBe(first)
    expect(loadAddon('file:///lib/spelled.node')).toBe(first)
    expect(loadAddon('/lib/./x/../spelled.node')).toBe(first)
    expect(requested.filter((path) => path === '/lib/spelled.wasm')).toHaveLength(1)
  })

  it('refuses a command build, one exporting _start, by name rather than crashing inside emnapi', () => {
    serveSync({ '/lib/command.wasm': commandAddon() })
    expect(() => loadAddon('/lib/command.node')).toThrow(expect.objectContaining({ code: 'ERR_DLOPEN_FAILED', message: expect.stringMatching(/reactor/) }))
  })

  it('loads each addon once, as Node caches a dlopen', () => {
    const requested = serveSync({ '/lib/once.node.wasm': napiAddon() })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const module = { exports: {} as unknown }
    dlopen(module, '/lib/dl.node')
    expect((module.exports as { answer: number }).answer).toBe(42)
  })

  it('createRequire takes import.meta.url as a page\'s bundle gives it, an https URL', () => {
    const requested = serveSync({ '/app/native/meta.wasm': napiAddon() })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect((createRequire(`${ORIGIN}/app/main.js`)('./native/meta.node') as { answer: number }).answer).toBe(42)
    expect(requested).toContain('/app/native/meta.node.wasm')
  })

  it('createRequire loads a .node path relative to its module, and refuses any other run-time require', () => {
    const requested = serveSync({ '/app/native/rel.wasm': napiAddon() })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const require = createRequire('/app/main.js')
    expect((require('./native/rel.node') as { answer: number }).answer).toBe(42)
    expect(requested).toContain('/app/native/rel.node.wasm')
    expect(require.resolve('./native/rel.node')).toBe('/app/native/rel.node')
    expect(() => require('lodash')).toThrow(OrivonShimError)
  })

  it('shares one preload between concurrent callers, so the addon is instantiated once', async () => {
    serveSync({})
    let fetches = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (new URL(url).pathname !== '/lib/shared.wasm') return new Response(null, { status: 404 })
      fetches++
      return new Response(napiAddon())
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await Promise.all([preloadAddon('/lib/shared.node'), preloadAddon('/lib/shared.node')])
    expect(fetches).toBe(1)
  })

  it('wraps a preload\'s invalid build in ERR_DLOPEN_FAILED, and names the paths it tried when there is none', async () => {
    serveSync({})
    vi.stubGlobal('fetch', async (url: string) => new URL(url).pathname === '/lib/corrupt.wasm'
      ? new Response(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 9, 9, 9, 9]))
      : new Response(null, { status: 404 }))
    await expect(preloadAddon('/lib/corrupt.node')).rejects.toMatchObject({ code: 'ERR_DLOPEN_FAILED' })
    await expect(preloadAddon('/lib/absent.node')).rejects.toThrow(/absent\.wasm32-wasi\.wasm/)
  })

  it('preloadAddon loads asynchronously, and a later synchronous load finds it without fetching', async () => {
    const requested = serveSync({})
    vi.stubGlobal('fetch', async (url: string) => new URL(url).pathname === '/lib/big.wasm' ? new Response(napiAddon()) : new Response(null, { status: 404 }))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await preloadAddon('/lib/big.node')
    expect((loadAddon('/lib/big.node') as { answer: number }).answer).toBe(42)
    expect(requested).toHaveLength(0)
  })
})
