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
  block: [0x02, 0x40],
  loop: [0x03, 0x40],
  end: [0x0b],
  br: (depth: number): number[] => [0x0c, depth],
  brIf: (depth: number): number[] => [0x0d, depth],
  i32Eqz: [0x45],
  unreachable: [0x00],
  /** Copies the i32 at `from` to `to`. */
  copy: (to: number, from: number): number[] => [0x41, ...sleb(BigInt(to)), 0x41, ...sleb(BigInt(from)), 0x28, 2, 0, 0x36, 2, 0],
  localGet: (index: number): number[] => [0x20, ...uleb(index)],
  localSet: (index: number): number[] => [0x21, ...uleb(index)],
  i32Add: [0x6a],
  i32And: [0x71],
  /** i32.load and i32.store with the address already on the stack. */
  loadAt: [0x28, 2, 0],
  storeAt: [0x36, 2, 0]
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

/** An import from any namespace, with its i32/i64 parameter and result types. */
export interface ImportSpec {
  readonly module: string
  readonly name: string
  readonly params: readonly number[]
  readonly results: readonly number[]
}

export interface ModuleSpec {
  readonly imports: readonly ImportSpec[]
  /** The one exported function, beside `memory`. */
  readonly exportName: string
  readonly params: readonly number[]
  readonly results: readonly number[]
  readonly locals?: number
  readonly body: (call: (name: string) => number[]) => number[][]
  readonly data?: ReadonlyArray<{ readonly offset: number, readonly text: string }>
  /** Exports an empty `__indirect_function_table`, which emnapi requires of every Node-API build. */
  readonly table?: boolean
  /** Bytes of a custom section, to make a module as large as a real build without changing it. */
  readonly padding?: number
  /** More exported functions, after the main one. */
  readonly extra?: ReadonlyArray<{ readonly name: string, readonly params: readonly number[], readonly results: readonly number[], readonly locals?: number, readonly body: number[][] }>
}

export const TYPE = { I32, I64 } as const

function signature (params: readonly number[], results: readonly number[]): number[] {
  return [0x60, ...vector(params.map((type) => [type])), ...vector(results.map((type) => [type]))]
}

/** A module exporting `memory` (one page) and one function, importing from any namespace. */
export function buildModule (spec: ModuleSpec): Uint8Array<ArrayBuffer> {
  const extra = spec.extra ?? []
  const types = spec.imports.map((entry) => signature(entry.params, entry.results))
  types.push(signature(spec.params, spec.results))
  for (const fn of extra) types.push(signature(fn.params, fn.results))
  const imports = spec.imports.map((entry, index) => [...bytes(entry.module), ...bytes(entry.name), 0x00, ...uleb(index)])
  const call = (name: string): number[] => {
    const index = spec.imports.findIndex((entry) => entry.name === name)
    if (index === -1) throw new Error(`${name} is not among the module's imports`)
    return [0x10, ...uleb(index)]
  }
  const localsOf = (count: number | undefined): number[] => (count ?? 0) > 0 ? vector([[...uleb(count ?? 0), I32]]) : [0]
  const bodies = [[...localsOf(spec.locals), ...spec.body(call).flat(), 0x0b], ...extra.map((fn) => [...localsOf(fn.locals), ...fn.body.flat(), 0x0b])]
  const firstType = spec.imports.length
  const data = (spec.data ?? []).map(({ offset, text }) => [0x00, ...op.i32(offset), 0x0b, ...bytes(text)])
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector(types)),
    ...section(2, vector(imports)),
    ...section(3, vector(bodies.map((_body, index) => uleb(firstType + index)))),
    ...(spec.table === true ? section(4, vector([[0x70, 0x00, 0x00]])) : []),
    ...section(5, vector([[0x00, 0x01]])),
    ...section(7, vector([
      [...bytes('memory'), 0x02, 0x00],
      [...bytes(spec.exportName), 0x00, ...uleb(spec.imports.length)],
      ...extra.map((fn, index) => [...bytes(fn.name), 0x00, ...uleb(spec.imports.length + 1 + index)]),
      ...(spec.table === true ? [[...bytes('__indirect_function_table'), 0x01, 0x00]] : [])
    ])),
    ...section(10, vector(bodies.map((body) => [...uleb(body.length), ...body]))),
    ...section(11, vector(data)),
    ...((spec.padding ?? 0) > 0 ? section(0, [...bytes('padding'), ...new Uint8Array(spec.padding ?? 0)]) : [])
  ])
}

/** A WASI command: its imports named from preview1, exporting `memory` and its entry, `_start` by default. */
export function wasiModule (program: WasiProgram): Uint8Array<ArrayBuffer> {
  return buildModule({
    imports: program.imports.map((name) => {
      const known = SIGNATURES[name]
      if (known === undefined) throw new Error(`wasm-module.ts has no signature for ${name}`)
      return { module: 'wasi_snapshot_preview1', name, params: known.params, results: known.returns ? [I32] : [] }
    }),
    exportName: program.entry ?? '_start',
    params: [],
    results: [],
    body: program.body,
    ...(program.data === undefined ? {} : { data: program.data }),
    ...(program.locals === undefined ? {} : { locals: program.locals })
  })
}
