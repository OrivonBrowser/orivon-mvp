// The program's linear memory, and the preview1 structs the host reads from
// and writes into it (field offsets from wasi_snapshot_preview1.witx).
//
// Every accessor builds a fresh view over `memory.buffer`. Never hold a view
// across an `await`: while a program is suspended another export may grow
// its memory, which detaches the old buffer.

export interface Iovec {
  readonly ptr: number
  readonly len: number
}

export const Filetype = {
  UNKNOWN: 0,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4
} as const

export interface Filestat {
  readonly ino: bigint
  readonly filetype: number
  readonly size: bigint
  readonly mtimNs: bigint
}

export interface Fdstat {
  readonly filetype: number
  readonly flags: number
  readonly rightsBase: bigint
  readonly rightsInheriting: bigint
}

const IOVEC_SIZE = 8
export const DIRENT_SIZE = 24

const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

export class InvalidUtf8 extends Error {}

/**
 * WebAssembly hands an i32 to JavaScript as a signed number, so a pointer
 * or length above 2 GiB arrives negative. Every one is read through this.
 */
export function unsigned (value: number): number {
  return value >>> 0
}

export class GuestMemory {
  #memory: WebAssembly.Memory | undefined

  bind (memory: WebAssembly.Memory): void {
    this.#memory = memory
  }

  get view (): DataView {
    if (this.#memory === undefined) throw new Error('WASI host used before bindMemory(): pass the instance to start() or initialize() first')
    return new DataView(this.#memory.buffer)
  }

  /** A fresh window onto guest memory; RangeError when out of bounds, which the host reports as FAULT. */
  bytes (ptr: number, len: number): Uint8Array {
    const { buffer } = this.view
    const start = unsigned(ptr)
    const length = unsigned(len)
    if (start + length > buffer.byteLength) throw new RangeError('guest pointer out of bounds')
    return new Uint8Array(buffer, start, length)
  }

  string (ptr: number, len: number): string {
    try {
      return utf8.decode(this.bytes(ptr, len))
    } catch (error) {
      if (error instanceof RangeError) throw error
      throw new InvalidUtf8('path is not valid UTF-8')
    }
  }

  u8 (ptr: number, value: number): void { this.view.setUint8(unsigned(ptr), value) }
  u16 (ptr: number, value: number): void { this.view.setUint16(unsigned(ptr), value, true) }
  u32 (ptr: number, value: number): void { this.view.setUint32(unsigned(ptr), value, true) }
  u64 (ptr: number, value: bigint): void { this.view.setBigUint64(unsigned(ptr), value, true) }
  readU32 (ptr: number): number { return this.view.getUint32(unsigned(ptr), true) }
  readU64 (ptr: number): bigint { return this.view.getBigUint64(unsigned(ptr), true) }
  readU16 (ptr: number): number { return this.view.getUint16(unsigned(ptr), true) }
  readU8 (ptr: number): number { return this.view.getUint8(unsigned(ptr)) }

  iovecs (ptr: number, count: number): Iovec[] {
    const view = this.view
    const out: Iovec[] = []
    for (let i = 0; i < unsigned(count); i++) {
      const at = unsigned(ptr) + i * IOVEC_SIZE
      out.push({ ptr: view.getUint32(at, true), len: view.getUint32(at + 4, true) })
    }
    return out
  }

  /** Copies the bytes the iovecs name out of guest memory, so the copy survives an await. */
  gather (iovecs: readonly Iovec[]): Uint8Array {
    const total = iovecs.reduce((sum, iov) => sum + iov.len, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const iov of iovecs) {
      out.set(this.bytes(iov.ptr, iov.len), offset)
      offset += iov.len
    }
    return out
  }

  /** Writes `data` across the iovecs in order; returns how many bytes fit. */
  scatter (iovecs: readonly Iovec[], data: Uint8Array): number {
    let offset = 0
    for (const iov of iovecs) {
      if (offset >= data.length) break
      const chunk = data.subarray(offset, offset + iov.len)
      this.bytes(iov.ptr, chunk.length).set(chunk)
      offset += chunk.length
    }
    return offset
  }

  filestat (ptr: number, stat: Filestat): void {
    this.bytes(ptr, 64).fill(0)
    this.u64(ptr + 8, stat.ino)
    this.u8(ptr + 16, stat.filetype)
    this.u64(ptr + 24, 1n)
    this.u64(ptr + 32, stat.size)
    this.u64(ptr + 40, stat.mtimNs)
    this.u64(ptr + 48, stat.mtimNs)
    this.u64(ptr + 56, stat.mtimNs)
  }

  fdstat (ptr: number, stat: Fdstat): void {
    this.bytes(ptr, 24).fill(0)
    this.u8(ptr, stat.filetype)
    this.u16(ptr + 2, stat.flags)
    this.u64(ptr + 8, stat.rightsBase)
    this.u64(ptr + 16, stat.rightsInheriting)
  }
}

export function encodeUtf8 (text: string): Uint8Array {
  return utf8Encoder.encode(text)
}

/** One `dirent` header followed by its name, as fd_readdir packs them. */
export function encodeDirent (next: bigint, ino: bigint, name: Uint8Array, filetype: number): Uint8Array {
  const out = new Uint8Array(DIRENT_SIZE + name.length)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, next, true)
  view.setBigUint64(8, ino, true)
  view.setUint32(16, name.length, true)
  view.setUint8(20, filetype)
  out.set(name, DIRENT_SIZE)
  return out
}
