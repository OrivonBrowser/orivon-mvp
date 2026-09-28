// The `wasi` module target: Node's WASI class, over window.orivon.fs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { OrivonShimError } from '../../errors.js'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { WasiJspiUnavailable } from '../instantiate.js'
import nodeWasi, { WASI, type WASIOptions } from '../node-wasi.js'
import { hasJspi, jspiWebAssembly } from './support/jspi.js'
import { op, wasiModule } from './support/wasm-module.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

let disk: RealDiskFs
const realWebAssembly = globalThis.WebAssembly

beforeEach(async () => {
  disk = await createRealDiskFs()
  ;(globalThis as GlobalWithOrivon).orivon = disk.orivon
})

afterEach(async () => {
  delete (globalThis as GlobalWithOrivon).orivon
  globalThis.WebAssembly = realWebAssembly
  await disk.cleanup()
})

/** Opens `name` under fd 3 and exits with path_open's errno. */
function openAndExit (name: string): Uint8Array<ArrayBuffer> {
  return wasiModule({
    imports: ['path_open', 'proc_exit'],
    data: [{ offset: 200, text: name }],
    body: (call) => [
      op.i32(3), op.i32(0), op.i32(200), op.i32(name.length), op.i32(1), op.i64((1n << 1n) | (1n << 6n)), op.i64(0n), op.i32(0), op.i32(16),
      call('path_open'), call('proc_exit')
    ]
  })
}

function instantiate (wasi: WASI, bytes: Uint8Array<ArrayBuffer>): WebAssembly.Instance {
  return new jspiWebAssembly.Instance(new jspiWebAssembly.Module(bytes), wasi.getImportObject() as unknown as WebAssembly.Imports)
}

describe('options Node validates, and the ones an app tab cannot honour', () => {
  it('requires version, as Node does', () => {
    expect(() => new WASI({} as WASIOptions)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(() => new WASI({ version: 'preview1', args: 'x' as unknown as string[] })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it('refuses by name what needs a host process: version unstable, returnOnExit false, host fds', () => {
    for (const options of [
      { version: 'unstable' },
      { version: 'preview1', returnOnExit: false },
      { version: 'preview1', stdout: 5 }
    ] as WASIOptions[]) {
      expect(() => new WASI(options)).toThrow(OrivonShimError)
    }
  })

  it('names the missing engine feature rather than building imports that would trap', () => {
    globalThis.WebAssembly = { ...realWebAssembly } as typeof WebAssembly
    expect(() => new WASI({ version: 'preview1' })).toThrow(WasiJspiUnavailable)
  })

  it('refuses an unbuilt member of the module by name', () => {
    expect(() => (nodeWasi as unknown as { somethingElse: () => void }).somethingElse()).toThrow(OrivonShimError)
  })
})

describe.skipIf(!hasJspi)('start() and initialize(), with JSPI', () => {
  beforeEach(() => { globalThis.WebAssembly = jspiWebAssembly })

  it('runs a command against the preopens it was given, and resolves with the exit code', async () => {
    const wasi = new WASI({ version: 'preview1', preopens: { '/': '/orivon/app' } })
    expect(wasi.getImportObject().wasi_snapshot_preview1).toBe(wasi.wasiImport)
    expect(await wasi.start(instantiate(wasi, openAndExit('made.txt')))).toBe(0)
    expect(await disk.existsOnDisk('made.txt')).toBe(true)
  })

  it('has no preopens unless given some, as in Node, so fd 3 is BADF', async () => {
    const wasi = new WASI({ version: 'preview1' })
    expect(await wasi.start(instantiate(wasi, openAndExit('x')))).toBe(8)
  })

  it('starts once, and refuses a reactor in start() and a command in initialize()', async () => {
    const wasi = new WASI({ version: 'preview1' })
    const command = instantiate(wasi, openAndExit('x'))
    await wasi.start(command)
    await expect(wasi.start(command)).rejects.toMatchObject({ code: 'ERR_WASI_ALREADY_STARTED' })
    const other = new WASI({ version: 'preview1' })
    await expect(other.initialize(instantiate(other, openAndExit('x')))).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
  })
})
