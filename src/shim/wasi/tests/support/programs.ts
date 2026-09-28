// WASI programs the child_process tests run, hand-assembled (wasm-module.ts).

import { op, wasiModule } from './wasm-module.js'

/** Copies stdin to stdout, 64 bytes at a time, until end of input; exits 0. */
export function echoProgram (): Uint8Array<ArrayBuffer> {
  return wasiModule({
    imports: ['fd_read', 'fd_write', 'proc_exit'],
    body: (call) => [
      op.store(0, 100),
      op.block, op.loop,
      op.store(4, 64),
      op.i32(0), op.i32(0), op.i32(1), op.i32(16), call('fd_read'), op.drop,
      op.load(16), op.i32Eqz, op.brIf(1),
      op.copy(4, 16),
      op.i32(1), op.i32(0), op.i32(1), op.i32(20), call('fd_write'), op.drop,
      op.br(0),
      op.end, op.end,
      op.i32(0), call('proc_exit')
    ]
  })
}

/** Writes `text` to stderr and exits with `code`. */
export function failingProgram (text: string, code: number): Uint8Array<ArrayBuffer> {
  return wasiModule({
    imports: ['fd_write', 'proc_exit'],
    data: [{ offset: 100, text }],
    body: (call) => [
      op.store(0, 100), op.store(4, text.length),
      op.i32(2), op.i32(0), op.i32(1), op.i32(16), call('fd_write'), op.drop,
      op.i32(code), call('proc_exit')
    ]
  })
}

/** Traps at once, as a crashed program does. */
export function trappingProgram (): Uint8Array<ArrayBuffer> {
  return wasiModule({ imports: [], body: () => [op.unreachable] })
}
