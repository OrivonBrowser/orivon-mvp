// Drives the host's import functions directly, the way a program's calls
// reach them, against a real temporary directory standing in for the
// broker (../../../tests/support/real-disk-fs.ts). No WebAssembly module and
// no JSPI: an async import is simply awaited.

import { createRealDiskFs, type RealDiskFs } from '../../../tests/support/real-disk-fs.js'
import { createWasiHost, type WasiHost, type WasiHostOptions } from '../../host.js'

type Call = (...args: Array<number | bigint>) => number | Promise<number>

export interface HostHarness {
  readonly host: WasiHost
  readonly disk: RealDiskFs
  readonly memory: WebAssembly.Memory
  /** Calls one import by name; resolves with its errno. */
  call (name: string, ...args: Array<number | bigint>): Promise<number>
  /** Writes `text` at `ptr` and returns its byte length. */
  put (ptr: number, text: string): number
  /** An iovec at `ptr` naming `len` bytes at `buf`. */
  iovec (ptr: number, buf: number, len: number): void
  u32 (ptr: number): number
  u64 (ptr: number): bigint
  text (ptr: number, len: number): string
  cleanup (): Promise<void>
}

export async function createHostHarness (options: Omit<WasiHostOptions, 'fs'> = {}): Promise<HostHarness> {
  const disk = await createRealDiskFs()
  const host = createWasiHost({ fs: disk.orivon.fs, ...options })
  const memory = new WebAssembly.Memory({ initial: 2 })
  host.bindMemory(memory)
  const view = (): DataView => new DataView(memory.buffer)
  return {
    host,
    disk,
    memory,
    call: async (name, ...args) => {
      const fn = (host.functions as unknown as Record<string, Call | undefined>)[name]
      if (fn === undefined) throw new Error(`the host has no import named ${name}`)
      return await fn(...args)
    },
    put: (ptr, text) => {
      const bytes = new TextEncoder().encode(text)
      new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes)
      return bytes.length
    },
    iovec: (ptr, buf, len) => {
      view().setUint32(ptr, buf, true)
      view().setUint32(ptr + 4, len, true)
    },
    u32: (ptr) => view().getUint32(ptr, true),
    u64: (ptr) => view().getBigUint64(ptr, true),
    text: (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)),
    cleanup: async () => {
      await host.finish()
      await disk.cleanup()
    }
  }
}
