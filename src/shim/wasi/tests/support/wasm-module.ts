// A minimal WebAssembly binary encoder for the WASI host's tests: enough to
// write a `_start` that calls preview1 imports, with no toolchain and no
// source in another language (ADR-0002). Under tests/support/ because
// vitest's `include` matches only `*.test.ts`.

const I32 = 0x7f
const I64 = 0x7e

/** The preview1 signatures the tests call: parameter types, and whether an i32 errno comes back. */
const SIGNATURES: Readonly<Record<string, { params: readonly number[], returns: boolean }>> = {
  fd_write: { params: [I32, I32, I32, I32], returns: true },
  fd_read: { params: [I32, I32, I32, I32], returns: true },
  fd_close: { params: [I32], returns: true },
  fd_seek: { params: [I32, I64, I32, I32], returns: true },
  path_open: { params: [I32, I32, I32, I32, I32, I64, I64, I32, I32], returns: true },
  clock_time_get: { params: [I32, I64, I32], returns: true },
  random_get: { params: [I32, I32], returns: true },
  proc_exit: { params: [I32], returns: false }
}

function uleb (value: number): number[] {
  const out: number[] = []
  let rest = value >>> 0
  do {
    const byte = rest & 0x7f
    rest >>>= 7
    out.push(rest === 0 ? byte : byte | 0x80)
  } while (rest !== 0)
  return out
}

function sleb (value: bigint): number[] {
  const out: number[] = []
  let rest = value
  for (;;) {
    const byte = Number(rest & 0x7fn)
    rest >>= 7n
    const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0)
    out.push(done ? byte : byte | 0x80)
    if (done) return out
  }
}

/** A name or byte string: its length, then its UTF-8 bytes. */
function bytes (text: string): number[] {
  const encoded = [...new TextEncoder().encode(text)]
  return [...uleb(encoded.length), ...encoded]
}

function vector (items: readonly number[][]): number[] {
  return [...uleb(items.length), ...items.flat()]
}

function section (id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body]
}

/** Instructions, as byte arrays to concatenate into a body. */
export const op = {
  i32: (value: number): number[] => [0x41, ...sleb(BigInt(value))],
  i64: (value: bigint): number[] => [0x42, ...sleb(value)],
  /** i32.load from a constant address. */
  load: (address: number): number[] => [0x41, ...sleb(BigInt(address)), 0x28, 2, 0],
  /** i32.store of a constant at a constant address: how a program lays out an iovec. */
  store: (address: number, value: number): number[] => [0x41, ...sleb(BigInt(address)), 0x41, ...sleb(BigInt(value)), 0x36, 2, 0],
  drop: [0x1a],
  localGet: (index: number): number[] => [0x20, ...uleb(index)],
  localSet: (index: number): number[] => [0x21, ...uleb(index)],
  i32Add: [0x6a]
}

export interface WasiProgram {
  /** preview1 imports, in the order `call` indexes them. */
  readonly imports: readonly string[]
  /** Builds `_start`'s body; `call(name)` emits a call to that import. */
  readonly body: (call: (name: string) => number[]) => number[][]
  /** Constant bytes placed in memory before `_start` runs. */
  readonly data?: ReadonlyArray<{ readonly offset: number, readonly text: string }>
  /** i32 locals `_start` declares. */
  readonly locals?: number
  /** The entry's export name, `_start` unless a test needs a reactor's `_initialize`. */
  readonly entry?: string
}

/** A module exporting `memory` (one page) and its entry, `_start` by default. */
export function wasiModule (program: WasiProgram): Uint8Array<ArrayBuffer> {
  const types: number[][] = program.imports.map((name) => {
    const signature = SIGNATURES[name]
    if (signature === undefined) throw new Error(`wasm-module.ts has no signature for ${name}`)
    return [0x60, ...vector(signature.params.map((type) => [type])), ...vector(signature.returns ? [[I32]] : [])]
  })
  types.push([0x60, 0, 0])
  const startType = types.length - 1
  const imports = program.imports.map((name, index) => [...bytes('wasi_snapshot_preview1'), ...bytes(name), 0x00, ...uleb(index)])
  const call = (name: string): number[] => {
    const index = program.imports.indexOf(name)
    if (index === -1) throw new Error(`${name} is not among the program's imports`)
    return [0x10, ...uleb(index)]
  }
  const locals = (program.locals ?? 0) > 0 ? vector([[...uleb(program.locals ?? 0), I32]]) : [0]
  const code = [...locals, ...program.body(call).flat(), 0x0b]
  const startIndex = program.imports.length
  const data = (program.data ?? []).map(({ offset, text }) => [0x00, ...op.i32(offset), 0x0b, ...bytes(text)])
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector(types)),
    ...section(2, vector(imports)),
    ...section(3, vector([uleb(startType)])),
    ...section(5, vector([[0x00, 0x01]])),
    ...section(7, vector([
      [...bytes('memory'), 0x02, 0x00],
      [...bytes(program.entry ?? '_start'), 0x00, ...uleb(startIndex)]
    ])),
    ...section(10, vector([[...uleb(code.length), ...code]])),
    ...section(11, vector(data))
  ])
}
