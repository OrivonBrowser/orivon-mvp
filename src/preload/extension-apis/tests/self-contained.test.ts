import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSION_MAIN_WORLD_APIS } from '../apis.js'

// The library runs an entry in the page with only the function's source text,
// so each entry is rebuilt here from `toString()` in a scope that sees nothing
// of this module, against a fake `__crx`.
interface FakeCrx {
  extensionId: string
  manifest: Record<string, unknown>
  context: 'page'
  declares: (permission: string) => boolean
  call: (name: string) => () => Promise<unknown>
  event: (name: string) => object
  define: (ns: string, build: (base: unknown) => object) => void
}

function fakeCrx (defined: string[], declared: () => boolean): FakeCrx {
  return {
    extensionId: 'a'.repeat(32),
    manifest: { manifest_version: 3, action: {}, permissions: [], optional_permissions: [] },
    context: 'page',
    declares: declared,
    call: () => async () => undefined,
    event: () => ({ addListener: () => {}, removeListener: () => {} }),
    define: (ns, build) => { build(undefined); defined.push(ns) }
  }
}

function runRebuilt (fn: () => void, crx: FakeCrx): void {
  const rebuilt = new Function(`return (${fn.toString()})`)() as () => void
  ;(globalThis as { __crx?: FakeCrx }).__crx = crx
  try { rebuilt() } finally { delete (globalThis as { __crx?: FakeCrx }).__crx }
}

afterEach(() => { delete (globalThis as { __crx?: FakeCrx }).__crx })

describe('EXTENSION_MAIN_WORLD_APIS', () => {
  it('has only functions', () => {
    for (const entry of EXTENSION_MAIN_WORLD_APIS) expect(typeof entry).toBe('function')
  })

  for (const [index, fn] of EXTENSION_MAIN_WORLD_APIS.entries()) {
    const name = fn.name === '' ? `entry ${index}` : fn.name

    it(`${name} runs from its own source text, without a ReferenceError, and defines a namespace`, () => {
      const defined: string[] = []
      expect(() => { runRebuilt(fn, fakeCrx(defined, () => true)) }).not.toThrow()
      expect(defined.length).toBeGreaterThanOrEqual(1)
    })
  }
})

describe('the harness', () => {
  const OUTSIDE = 'outer'

  it('accepts a function that uses only __crx', () => {
    const entry = (): void => {
      const crx = (globalThis as unknown as { __crx: FakeCrx }).__crx
      if (!crx.declares('history')) return
      crx.define('history', () => ({ search: crx.call('history.search'), onVisited: crx.event('history.onVisited') }))
    }
    const defined: string[] = []
    runRebuilt(entry, fakeCrx(defined, () => true))
    expect(defined).toEqual(['history'])
  })

  it('catches an entry that reaches for an identifier outside its own body', () => {
    const entry = (): void => {
      const crx = (globalThis as unknown as { __crx: FakeCrx }).__crx
      crx.define(OUTSIDE, () => ({}))
    }
    expect(() => { runRebuilt(entry, fakeCrx([], () => true)) }).toThrow(ReferenceError)
  })
})
