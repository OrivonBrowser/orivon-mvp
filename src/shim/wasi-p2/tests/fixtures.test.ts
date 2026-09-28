// Regenerates the WASI 0.2 component fixtures the other tests run, each
// hand-assembled here (ADR-0002) and transpiled by jco exactly as a port is
// told to (run.ts's transpileCommand), its glue minified: a preview1 program
// made a component with the preview1 adapter, and a socket client written
// against the canonical ABI. jco has native dependencies, so it
// is never one of this repository's (Rule 8); this runs only when
// ORIVON_JCO_DIR names a directory holding it:
//
//   npm install --prefix <dir> @bytecodealliance/jco-transpile@0.15.0
//   (cd <dir> && npm pack @bytecodealliance/jco@1.35.0 && tar xzf bytecodealliance-jco-1.35.0.tgz package/lib)
//   ORIVON_JCO_DIR=<dir> npx vitest run src/shim/wasi-p2/tests/fixtures.test.ts

import { writeFileSync } from 'node:fs'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { TYPE, buildModule, op, wasiModule } from '../../wasi/tests/support/wasm-module.js'
import { SOCKET_FIXTURE, SOCKET_TARGET, TOUR_FIXTURE } from './support/component-fixture.js'
import { JCO_DIR, loadJco } from './support/jco.js'

/** Echoes stdin to stdout, writes `from-component.txt` under the first preopen, says "done" on stderr, and exits 3. */
function tourProgram (): Uint8Array<ArrayBuffer> {
  const file = 'from-component.txt'
  const contents = 'written by a component\n'
  return wasiModule({
    imports: ['fd_read', 'fd_write', 'path_open', 'fd_close', 'proc_exit'],
    data: [{ offset: 300, text: file }, { offset: 340, text: contents }, { offset: 380, text: 'done\n' }],
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
      op.i32(3), op.i32(0), op.i32(300), op.i32(file.length), op.i32(9), op.i64(64n), op.i64(0n), op.i32(0), op.i32(400), call('path_open'), op.drop,
      op.store(408, 340), op.store(412, contents.length),
      op.load(400), op.i32(408), op.i32(1), op.i32(20), call('fd_write'), op.drop,
      op.load(400), call('fd_close'), op.drop,
      op.store(416, 380), op.store(420, 5),
      op.i32(2), op.i32(416), op.i32(1), op.i32(20), call('fd_write'), op.drop,
      op.i32(3), call('proc_exit')
    ]
  })
}

const { I32, I64 } = TYPE
const SUB = [0x6b]
const RETURN = [0x0f]
/** i32.load8_u from a constant address: a result's discriminant. */
const loadByte = (address: number): number[] => [...op.i32(address), 0x2d, 0, 0]
/** Returns 1 from run when the result at 1000 is an error. */
const failOnError = [op.block, loadByte(1000), op.i32Eqz, op.brIf(0), op.i32(1), RETURN, op.end]

const SOCKET_WIT = `package test:sockets;

world client {
  import wasi:sockets/instance-network@0.2.12;
  import wasi:sockets/tcp-create-socket@0.2.12;
  import wasi:sockets/tcp@0.2.12;
  import wasi:io/poll@0.2.12;
  import wasi:io/streams@0.2.12;
  import wasi:cli/stdout@0.2.12;
  export wasi:cli/run@0.2.12;
}
`

/**
 * A client written straight against the canonical ABI: connects to
 * SOCKET_TARGET, sends its message, and prints the reply. Results land at
 * address 1000; the heap cabi_realloc bumps starts at 4096.
 */
function socketModule (): Uint8Array<ArrayBuffer> {
  const i32s = (count: number): number[] => Array<number>(count).fill(I32)
  const imports = [
    { module: 'wasi:sockets/instance-network@0.2.12', name: 'instance-network', params: [], results: [I32] },
    { module: 'wasi:sockets/tcp-create-socket@0.2.12', name: 'create-tcp-socket', params: i32s(2), results: [] },
    { module: 'wasi:sockets/tcp@0.2.12', name: '[method]tcp-socket.start-connect', params: i32s(15), results: [] },
    { module: 'wasi:sockets/tcp@0.2.12', name: '[method]tcp-socket.subscribe', params: [I32], results: [I32] },
    { module: 'wasi:io/poll@0.2.12', name: '[method]pollable.block', params: [I32], results: [] },
    { module: 'wasi:sockets/tcp@0.2.12', name: '[method]tcp-socket.finish-connect', params: i32s(2), results: [] },
    { module: 'wasi:io/streams@0.2.12', name: '[method]output-stream.blocking-write-and-flush', params: i32s(4), results: [] },
    { module: 'wasi:io/streams@0.2.12', name: '[method]input-stream.blocking-read', params: [I32, I64, I32], results: [] },
    { module: 'wasi:cli/stdout@0.2.12', name: 'get-stdout', params: [], results: [I32] }
  ]
  const [a, b, c, d] = SOCKET_TARGET.address
  return buildModule({
    imports,
    exportName: 'wasi:cli/run@0.2.12#run',
    params: [],
    results: [I32],
    locals: 5,
    data: [{ offset: 2000, text: '\u0000\u0010\u0000\u0000' }, { offset: 3000, text: SOCKET_TARGET.message }],
    extra: [{
      name: 'cabi_realloc',
      params: i32s(4),
      results: [I32],
      locals: 1,
      body: [
        op.load(2000), op.localGet(2), op.i32Add, op.i32(1), SUB, op.i32(0), op.localGet(2), SUB, op.i32And, op.localSet(4),
        op.i32(2000), op.localGet(4), op.localGet(3), op.i32Add, op.storeAt,
        op.localGet(4)
      ]
    }],
    body: (call) => [
      call('instance-network'), op.localSet(0),
      op.i32(0), op.i32(1000), call('create-tcp-socket'), ...failOnError,
      op.load(1004), op.localSet(1),
      op.localGet(1), op.localGet(0), op.i32(0), op.i32(SOCKET_TARGET.port), op.i32(a), op.i32(b), op.i32(c), op.i32(d),
      ...Array.from({ length: 6 }, () => op.i32(0)), op.i32(1000), call('[method]tcp-socket.start-connect'), ...failOnError,
      op.localGet(1), call('[method]tcp-socket.subscribe'), call('[method]pollable.block'),
      op.localGet(1), op.i32(1000), call('[method]tcp-socket.finish-connect'), ...failOnError,
      op.load(1004), op.localSet(2), op.load(1008), op.localSet(3),
      op.localGet(3), op.i32(3000), op.i32(SOCKET_TARGET.message.length), op.i32(1000), call('[method]output-stream.blocking-write-and-flush'), ...failOnError,
      op.localGet(2), op.i64(64n), op.i32(1000), call('[method]input-stream.blocking-read'), ...failOnError,
      call('get-stdout'), op.localSet(4),
      op.localGet(4), op.load(1004), op.load(1008), op.i32(1100), call('[method]output-stream.blocking-write-and-flush'),
      op.i32(0)
    ]
  })
}

async function writeFixture (path: string, glue: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  const minified = (await esbuild.transform(glue, { minify: true, format: 'esm' })).code
  writeFileSync(path, `${JSON.stringify({ glue: minified, cores: Object.fromEntries([...files].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')])) })}\n`)
}

describe.skipIf(JCO_DIR === undefined)('the WASI 0.2 component fixtures', () => {
  it('regenerates the socket client from its canonical-ABI module and WIT world', async () => {
    const { glue, cores } = await (await loadJco()).embedAndTranspile(socketModule(), SOCKET_WIT, 'client', 'socket')
    await writeFixture(SOCKET_FIXTURE, glue, cores)
    expect(cores.size).toBeGreaterThan(0)
  })

  it('regenerates the tour from the hand-assembled preview1 program', async () => {
    const { glue, cores } = await (await loadJco()).adaptAndTranspile(tourProgram(), 'tour')
    await writeFixture(TOUR_FIXTURE, glue, cores)
    expect(cores.size).toBeGreaterThan(0)
  })
})
