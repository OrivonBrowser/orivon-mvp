import { afterEach, describe, expect, it, vi } from 'vitest'
import bufferPackage from 'buffer/'
import { installPageBuffer } from '../page-buffer.js'
import { reserialised } from '../routed/tests/routed.test-helpers.js'
import { BUFFER_PACKAGE_PLACEHOLDER, pageBufferPackage } from '../../../electron.vite.config.js'

const PAGE_BUFFER_SOURCE = new URL('../page-buffer.ts', import.meta.url).pathname

type Target = Record<string, unknown>

/** The plugin's transform, called the way the preload build calls it on page-buffer.ts. */
async function inlined (code: string, id = PAGE_BUFFER_SOURCE): Promise<string | undefined> {
  const transform = pageBufferPackage().transform as (code: string, id: string) => Promise<{ code: string } | null>
  return (await transform(code, id))?.code
}

afterEach(() => { vi.unstubAllGlobals() })

describe('installPageBuffer', () => {
  it('installs the package\'s Buffer with Node\'s own descriptor: replaceable, not enumerable', () => {
    vi.stubGlobal(BUFFER_PACKAGE_PLACEHOLDER, bufferPackage)
    const target: Target = {}
    reserialised(installPageBuffer)(target)

    expect(target.Buffer).toBe(bufferPackage.Buffer)
    expect(Object.getOwnPropertyDescriptor(target, 'Buffer')).toEqual({
      value: bufferPackage.Buffer, writable: true, configurable: true, enumerable: false
    })
  })

  it('leaves an app free to replace, shadow and delete it (ADR-0021)', () => {
    vi.stubGlobal(BUFFER_PACKAGE_PLACEHOLDER, bufferPackage)
    const target: Target = {}
    reserialised(installPageBuffer)(target)

    // The surrogate-global pattern, in strict mode: an own property shadowing an inherited one.
    const Surrogate = function (this: Target) {} as unknown as new () => Target
    Surrogate.prototype = target
    const surrogate = new Surrogate()
    expect(() => { 'use strict'; surrogate.Buffer = 'shadow' }).not.toThrow()
    expect(surrogate.Buffer).toBe('shadow')

    target.Buffer = 'replaced'
    expect(target.Buffer).toBe('replaced')
    expect(delete target.Buffer).toBe(true)
  })
})

describe('the preload build\'s pageBufferPackage plugin', () => {
  it('inlines the buffer package, so the serialised installer names nothing outside itself', async () => {
    const code = await inlined(String(installPageBuffer))
    expect(code).toBeDefined()
    expect(code).not.toContain(BUFFER_PACKAGE_PLACEHOLDER)

    // Rebuilt from its text alone with no placeholder global, as executeInMainWorld runs it:
    // sloppy, since the preload bundle drops a nested 'use strict'.
    const install = new Function(`${code ?? ''}\nreturn installPageBuffer`)() as (target: Target) => void // eslint-disable-line no-new-func
    const target: Target = {}
    install(target)

    const PageBuffer = target.Buffer as typeof bufferPackage.Buffer
    expect(typeof PageBuffer).toBe('function')
    expect(PageBuffer).not.toBe(bufferPackage.Buffer)
    expect(PageBuffer).not.toBe(globalThis.Buffer)
    expect(PageBuffer.from('hi').toString('hex')).toBe('6869')
    expect(PageBuffer.isBuffer(PageBuffer.alloc(2))).toBe(true)
    expect(PageBuffer.alloc(1)).toBeInstanceOf(Uint8Array)
  })

  it('leaves every other module alone', async () => {
    expect(await inlined(`const x = ${BUFFER_PACKAGE_PLACEHOLDER}`, '/elsewhere/other.ts')).toBeUndefined()
  })

  it('fails the build when page-buffer.ts no longer names the placeholder exactly once', async () => {
    await expect(inlined('export function installPageBuffer () {}')).rejects.toThrow(BUFFER_PACKAGE_PLACEHOLDER)
    await expect(inlined(`${BUFFER_PACKAGE_PLACEHOLDER}; ${BUFFER_PACKAGE_PLACEHOLDER}`)).rejects.toThrow(BUFFER_PACKAGE_PLACEHOLDER)
  })

  it('inlines the package text literally, `$` patterns included', async () => {
    const code = await inlined(`const p = ${BUFFER_PACKAGE_PLACEHOLDER}`)
    expect(code?.startsWith('const p = (function () {')).toBe(true)
    // Buffer.prototype.inspect's own `.replace(/(.{2})/g, '$1 ')`.
    expect(code).toContain('$1 ')
  })
})
