// Hand-assembled Node-API modules (no toolchain, ADR-0002) for the addon
// tests and the e2e: exports emnapi requires of any build (memory, a
// function table, malloc and free) and a napi_register_wasm_v1.

import { TYPE, buildModule, op } from '../../../wasi/tests/support/wasm-module.js'

const { I32 } = TYPE

/** The allocator emnapi needs from every build: a bump pointer at address 1000, starting at 4096. */
const HEAP_TOP = { offset: 1000, text: '\u0000\u0010\u0000\u0000' }
const ALLOCATOR = [
  {
    name: 'malloc', params: [TYPE.I32], results: [TYPE.I32], locals: 1,
    body: [
      op.i32(1000), op.loadAt, op.localSet(1),
      op.i32(1000), op.localGet(1), op.localGet(0), op.i32Add, op.i32(7), op.i32Add, op.i32(-8), op.i32And, op.storeAt,
      op.localGet(1)
    ]
  },
  { name: 'free', params: [TYPE.I32], results: [], body: [] }
]

const napi = (name: string, params: number): { module: string, name: string, params: number[], results: number[] } =>
  ({ module: 'napi', name, params: Array<number>(params).fill(I32), results: [I32] })

/** Sets `answer` = 42 and `greet` = "hello from wasm" on exports and writes "loaded\n" to stdout; `padding` grows it without changing it. */
export function napiAddon (padding = 0): Uint8Array<ArrayBuffer> {
  return buildModule({
    imports: [
      napi('napi_create_int32', 3),
      napi('napi_create_string_utf8', 4),
      napi('napi_set_named_property', 4),
      { module: 'wasi_snapshot_preview1', name: 'fd_write', params: [I32, I32, I32, I32], results: [I32] }
    ],
    exportName: 'napi_register_wasm_v1',
    params: [I32, I32],
    results: [I32],
    table: true,
    extra: ALLOCATOR,
    padding,
    data: [HEAP_TOP, { offset: 100, text: 'answer\0' }, { offset: 110, text: 'greet\0' }, { offset: 120, text: 'hello from wasm' }, { offset: 140, text: 'loaded\n' }],
    body: (call) => [
      op.localGet(0), op.i32(42), op.i32(200), call('napi_create_int32'), op.drop,
      op.localGet(0), op.localGet(1), op.i32(100), op.load(200), call('napi_set_named_property'), op.drop,
      op.localGet(0), op.i32(120), op.i32(15), op.i32(204), call('napi_create_string_utf8'), op.drop,
      op.localGet(0), op.localGet(1), op.i32(110), op.load(204), call('napi_set_named_property'), op.drop,
      op.store(300, 140), op.store(304, 7),
      op.i32(1), op.i32(300), op.i32(1), op.i32(308), call('fd_write'), op.drop,
      op.localGet(1)
    ]
  })
}

/**
 * Reads `data.txt` from the files root (its first 64 bytes become the export
 * `content`, path_open's errno `openErrno`) and writes "from addon" to
 * `out.txt`, all through WASI during registration.
 */
export function fileAddon (): Uint8Array<ArrayBuffer> {
  const pathOpen = { module: 'wasi_snapshot_preview1', name: 'path_open', params: [I32, I32, I32, I32, I32, TYPE.I64, TYPE.I64, I32, I32], results: [I32] }
  const wasi = (name: string, params: number) => ({ module: 'wasi_snapshot_preview1', name, params: Array<number>(params).fill(I32), results: [I32] })
  const open = (path: number, length: number, oflags: number, rights: bigint, fdAt: number): number[][] =>
    [op.i32(3), op.i32(0), op.i32(path), op.i32(length), op.i32(oflags), op.i64(rights), op.i64(0n), op.i32(0), op.i32(fdAt)]
  return buildModule({
    imports: [
      napi('napi_create_int32', 3), napi('napi_create_string_utf8', 4), napi('napi_set_named_property', 4),
      pathOpen, wasi('fd_read', 4), wasi('fd_write', 4), wasi('fd_close', 1)
    ],
    exportName: 'napi_register_wasm_v1',
    params: [I32, I32],
    results: [I32],
    locals: 1,
    table: true,
    extra: ALLOCATOR,
    data: [HEAP_TOP, { offset: 600, text: 'data.txt' }, { offset: 620, text: 'out.txt' }, { offset: 640, text: 'content\0' },
      { offset: 660, text: 'openErrno\0' }, { offset: 680, text: 'from addon' }],
    body: (call) => {
      const exportValue = (name: number, valueAt: number): number[][] =>
        [op.localGet(0), op.localGet(1), op.i32(name), op.load(valueAt), call('napi_set_named_property'), op.drop]
      return [
        ...open(600, 8, 0, 2n, 700), call('path_open'), op.localSet(2),
        op.localGet(0), op.localGet(2), op.i32(728), call('napi_create_int32'), op.drop,
        ...exportValue(660, 728),
        op.store(710, 800), op.store(714, 64),
        op.load(700), op.i32(710), op.i32(1), op.i32(720), call('fd_read'), op.drop,
        op.localGet(0), op.i32(800), op.load(720), op.i32(724), call('napi_create_string_utf8'), op.drop,
        ...exportValue(640, 724),
        ...open(620, 7, 9, 64n, 704), call('path_open'), op.drop,
        op.store(740, 680), op.store(744, 10),
        op.load(704), op.i32(740), op.i32(1), op.i32(750), call('fd_write'), op.drop,
        op.load(704), call('fd_close'), op.drop,
        op.load(700), call('fd_close'), op.drop,
        op.localGet(1)
      ]
    }
  })
}

/**
 * Shaped as a napi-rs build is: Node-API imported from `env`, `env.memory`
 * imported at 3 pages rather than exported, and a `__napi_register__mark`
 * export that stores 7 for napi_register_wasm_v1 to read back as `marked`,
 * which is 7 only if the loader ran it first. `registerTraps` makes that
 * export trap instead, as a Rust panic under panic=abort does.
 */
export function napiRsShapedAddon (memory: { initial: number, maximum: number, shared?: boolean } = { initial: 3, maximum: 16 }, registerTraps = false): Uint8Array<ArrayBuffer> {
  const env = (name: string, params: number): { module: string, name: string, params: number[], results: number[] } =>
    ({ module: 'env', name, params: Array<number>(params).fill(I32), results: [I32] })
  return buildModule({
    imports: [env('napi_create_int32', 3), env('napi_set_named_property', 4)],
    importMemory: memory,
    exportName: 'napi_register_wasm_v1',
    params: [I32, I32],
    results: [I32],
    table: true,
    extra: [...ALLOCATOR, { name: '__napi_register__mark', params: [], results: [], body: registerTraps ? [op.unreachable] : [op.store(600, 7)] }],
    data: [HEAP_TOP, { offset: 100, text: 'marked\0' }],
    body: (call) => [
      op.localGet(0), op.load(600), op.i32(200), call('napi_create_int32'), op.drop,
      op.localGet(0), op.localGet(1), op.i32(100), op.load(200), call('napi_set_named_property'), op.drop,
      op.localGet(1)
    ]
  })
}

export function threadedAddon (): Uint8Array<ArrayBuffer> {
  return buildModule({
    imports: [{ module: 'wasi', name: 'thread-spawn', params: [I32], results: [I32] }],
    table: true,
    extra: ALLOCATOR,
    exportName: 'napi_register_wasm_v1',
    params: [I32, I32],
    results: [I32],
    body: () => [op.localGet(1)]
  })
}

/** A command build, exporting `_start`, which emnapi would start through Node's WASI internals. */
export function commandAddon (): Uint8Array<ArrayBuffer> {
  return buildModule({
    imports: [],
    table: true,
    extra: [...ALLOCATOR, { name: '_start', params: [], results: [], body: [] }],
    exportName: 'napi_register_wasm_v1',
    params: [I32, I32],
    results: [I32],
    body: () => [op.localGet(1)]
  })
}
