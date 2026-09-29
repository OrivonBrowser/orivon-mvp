import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageBuffer } from '../../tests/support/page-buffer.js'

/** Stands for the page's `Buffer` global: a separate evaluation of the `buffer` package, so a class of its own. */
class GlobalBuffer extends Uint8Array {
  static TYPED_ARRAY_SUPPORT = true
  static alloc (size: number): GlobalBuffer { return new GlobalBuffer(size) }
}

async function freshBufferModule (): Promise<typeof import('../buffer.js')> {
  vi.resetModules()
  return await import('../buffer.js')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the shim\'s `buffer` module and the page\'s Buffer global', () => {
  it('is the page global when that is the buffer package\'s class, so instanceof agrees across the two', async () => {
    vi.stubGlobal('Buffer', GlobalBuffer)
    const buffer = await freshBufferModule()

    expect(buffer.Buffer).toBe(GlobalBuffer)
    expect(buffer.default.Buffer).toBe(GlobalBuffer)
    expect((buffer.SlowBuffer as (size: number) => unknown)(2)).toBeInstanceOf(GlobalBuffer)
    expect((buffer.SlowBuffer as (size: string) => Uint8Array)('not a size')).toHaveLength(0)
  })

  it('keeps the package\'s own class when the global is some other Buffer', async () => {
    const buffer = await freshBufferModule()

    expect(globalThis.Buffer).not.toBe(PageBuffer)
    expect(buffer.Buffer).toBe(PageBuffer)
  })
})

// A287: Node's buffer.File is the platform's own File class, same as Blob --
// not a gap this shim leaves open, so it must be the real class, both named
// and on the default export, never the generic "unimplemented" refusal.
describe('buffer.File', () => {
  it('is the platform\'s File class, both named and on the default export', async () => {
    const buffer = await freshBufferModule()

    expect(buffer.File).toBe(globalThis.File)
    expect(buffer.default.File).toBe(globalThis.File)
  })
})
