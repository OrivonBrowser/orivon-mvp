// The memory an addon's build imports, read from its binary: a napi-rs build
// imports `env.memory` rather than exporting one, and WebAssembly.Module
// reports an import's name but not the limits the memory must meet. Read
// only once the binary has compiled, so its sections are well formed.

export interface MemoryLimits { readonly initial: number, readonly maximum?: number, readonly shared: boolean, readonly memory64: boolean }

const IMPORT_SECTION = 2
const MEMORY = 2

class Reader {
  offset = 8
  readonly #bytes: Uint8Array

  constructor (bytes: Uint8Array) {
    this.#bytes = bytes
  }

  byte (): number {
    const value = this.#bytes[this.offset++]
    if (value === undefined) throw new RangeError('truncated WebAssembly binary')
    return value
  }

  u32 (): number {
    let result = 0
    for (let shift = 0; ; shift += 7) {
      const byte = this.byte()
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
    }
  }

  name (): string {
    const length = this.u32()
    const text = new TextDecoder().decode(this.#bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return text
  }

  limits (): MemoryLimits {
    const flags = this.byte()
    const initial = this.u32()
    return { initial, ...((flags & 1) !== 0 ? { maximum: this.u32() } : {}), shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 }
  }
}

/** The limits of the memory `bytes` imports as `module`.`name`, or undefined when it imports none. */
export function importedMemory (bytes: Uint8Array, module = 'env', name = 'memory'): MemoryLimits | undefined {
  const reader = new Reader(bytes)
  while (reader.offset < bytes.length) {
    const id = reader.byte()
    const size = reader.u32()
    const end = reader.offset + size
    if (id !== IMPORT_SECTION) { reader.offset = end; continue }
    for (let count = reader.u32(); count > 0; count--) {
      const from = reader.name()
      const field = reader.name()
      const kind = reader.byte()
      if (kind === MEMORY) {
        const limits = reader.limits()
        if (from === module && field === name) return limits
      } else if (kind === 0) reader.u32()
      else if (kind === 1) { reader.byte(); reader.limits() }
      else if (kind === 3) { reader.byte(); reader.byte() }
      else if (kind === 4) { reader.byte(); reader.u32() }
      else throw new RangeError(`unknown import kind ${kind}`)
    }
    return undefined
  }
  return undefined
}
