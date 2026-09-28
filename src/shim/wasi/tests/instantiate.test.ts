// Real modules through JSPI: the program's stack suspends on each file
// call and resumes with the result.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { createWasiHost, type WasiHost, type WasiHostOptions } from '../host.js'
import { WasiJspiUnavailable, initializeReactor, runCommand, suspendingImports } from '../instantiate.js'
import { WasiTerminated } from '../termination.js'
import { hasJspi, jspiWebAssembly } from './support/jspi.js'
import { op, wasiModule } from './support/wasm-module.js'

const READ_WRITE = (1n << 1n) | (1n << 6n)
const CREAT_TRUNC = 1 | 8

let disk: RealDiskFs | undefined

afterEach(async () => {
  await disk?.cleanup()
  disk = undefined
})

async function start (bytes: Uint8Array<ArrayBuffer>, options: Omit<WasiHostOptions, 'fs'> = {}): Promise<{ host: WasiHost, run: Promise<number> }> {
  disk = await createRealDiskFs()
  const host = createWasiHost({ fs: disk.orivon.fs, ...options })
  const module = new jspiWebAssembly.Module(bytes)
  const instance = new jspiWebAssembly.Instance(module, { wasi_snapshot_preview1: suspendingImports(host, jspiWebAssembly) } as WebAssembly.Imports)
  return { host, run: runCommand(instance, host, jspiWebAssembly) }
}

/** Writes `text` (placed at 100) to fd 1, then exits with `code`. */
function hello (text: string, code: number): Uint8Array<ArrayBuffer> {
  return wasiModule({
    imports: ['fd_write', 'proc_exit'],
    data: [{ offset: 100, text }],
    body: (call) => [
      op.store(0, 100), op.store(4, text.length),
      op.i32(1), op.i32(0), op.i32(1), op.i32(16), call('fd_write'), op.drop,
      op.i32(code), call('proc_exit')
    ]
  })
}

describe.skipIf(!hasJspi)('runCommand and initializeReactor, with JSPI', () => {
  it('runs a command to proc_exit and resolves with its code, stdout delivered', async () => {
    const out: string[] = []
    const { run } = await start(hello('hello\n', 7), { stdout: (bytes) => { out.push(new TextDecoder().decode(bytes)) } })
    expect(await run).toBe(7)
    expect(out.join('')).toBe('hello\n')
  })

  it('resolves 0 when _start returns without calling proc_exit', async () => {
    const { run } = await start(wasiModule({ imports: [], body: () => [] }))
    expect(await run).toBe(0)
  })

  it('suspends on path_open and fd_write, which reach a real file through orivon.fs', async () => {
    const text = 'written by wasm'
    const bytes = wasiModule({
      imports: ['path_open', 'fd_write', 'fd_close', 'proc_exit'],
      data: [{ offset: 200, text: 'out.txt' }, { offset: 300, text }],
      body: (call) => [
        op.i32(3), op.i32(0), op.i32(200), op.i32(7), op.i32(CREAT_TRUNC), op.i64(READ_WRITE), op.i64(0n), op.i32(0), op.i32(16),
        call('path_open'), op.localSet(0),
        op.store(0, 300), op.store(4, text.length),
        op.load(16), op.i32(0), op.i32(1), op.i32(20), call('fd_write'), op.localGet(0), op.i32Add, op.localSet(0),
        op.load(16), call('fd_close'), op.localGet(0), op.i32Add,
        call('proc_exit')
      ],
      locals: 1
    })
    const { run } = await start(bytes)
    expect(await run).toBe(0)
    expect(await disk?.readRealFile('out.txt')).toBe(text)
  })

  it('hands a path above the preopen NOTCAPABLE, before orivon.fs is asked', async () => {
    const bytes = wasiModule({
      imports: ['path_open', 'proc_exit'],
      data: [{ offset: 200, text: '../escape' }],
      body: (call) => [
        op.i32(3), op.i32(0), op.i32(200), op.i32(9), op.i32(CREAT_TRUNC), op.i64(READ_WRITE), op.i64(0n), op.i32(0), op.i32(16),
        call('path_open'), call('proc_exit')
      ]
    })
    const { run } = await start(bytes)
    expect(await run).toBe(76)
  })

  it('rejects with WasiTerminated when killed while suspended', async () => {
    let release: () => void = () => {}
    const { host, run } = await start(hello('x', 0), { stdout: async () => { await new Promise<void>((resolve) => { release = resolve }) } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.kill()
    release()
    await expect(run).rejects.toEqual(new WasiTerminated('killed'))
  })

  it('ends a program suspended on a stdin read that never delivers, when killed', async () => {
    const bytes = wasiModule({
      imports: ['fd_read', 'proc_exit'],
      body: (call) => [op.store(0, 100), op.store(4, 8), op.i32(0), op.i32(0), op.i32(1), op.i32(16), call('fd_read'), call('proc_exit')]
    })
    const { host, run } = await start(bytes, { stdin: { read: async () => await new Promise<Uint8Array>(() => {}) } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.kill()
    await expect(run).rejects.toEqual(new WasiTerminated('killed'))
  })

  it('names a command with no _start', async () => {
    disk = await createRealDiskFs()
    const host = createWasiHost({ fs: disk.orivon.fs })
    const reactor = wasiModule({ imports: [], body: () => [], entry: '_initialize' })
    const instance = new jspiWebAssembly.Instance(new jspiWebAssembly.Module(reactor), { wasi_snapshot_preview1: suspendingImports(host, jspiWebAssembly) } as WebAssembly.Imports)
    await expect(runCommand(instance, host, jspiWebAssembly)).rejects.toThrow(/does not export "_start"/)
  })

  it('initializes a reactor, binding its memory even with no _initialize, and leaves its files open', async () => {
    disk = await createRealDiskFs()
    const host = createWasiHost({ fs: disk.orivon.fs })
    const finish = vi.spyOn(host, 'finish')
    const library = wasiModule({ imports: [], body: () => [], entry: 'compute' })
    const instance = new jspiWebAssembly.Instance(new jspiWebAssembly.Module(library), { wasi_snapshot_preview1: suspendingImports(host, jspiWebAssembly) } as WebAssembly.Imports)
    await initializeReactor(instance, host, jspiWebAssembly)
    const argsSizes = host.functions.args_sizes_get as unknown as (count: number, size: number) => number
    expect(argsSizes(0, 4)).toBe(0)
    expect(finish).not.toHaveBeenCalled()
  })
})

describe('without JSPI', () => {
  it('refuses with a named error instead of installing imports that would trap', async () => {
    disk = await createRealDiskFs()
    const host = createWasiHost({ fs: disk.orivon.fs })
    expect(() => suspendingImports(host, {})).toThrow(WasiJspiUnavailable)
  })
})
