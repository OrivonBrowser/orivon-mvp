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
