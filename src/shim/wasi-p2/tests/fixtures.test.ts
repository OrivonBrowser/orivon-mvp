// Regenerates the WASI 0.2 component fixture the other tests run: a preview1
// program hand-assembled here (ADR-0002), made a component with the preview1
// adapter and transpiled by jco exactly as a port is told to (run.ts's
// transpileCommand), its glue minified. jco has native dependencies, so it
// is never one of this repository's (Rule 8); this runs only when
// ORIVON_JCO_DIR names a directory holding it:
//
//   npm install --prefix <dir> @bytecodealliance/jco-transpile@0.15.0
//   (cd <dir> && npm pack @bytecodealliance/jco@1.35.0 && tar xzf bytecodealliance-jco-1.35.0.tgz package/lib)
//   ORIVON_JCO_DIR=<dir> npx vitest run src/shim/wasi-p2/tests/fixtures.test.ts

import { writeFileSync } from 'node:fs'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { op, wasiModule } from '../../wasi/tests/support/wasm-module.js'
import { TOUR_FIXTURE } from './support/component-fixture.js'
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

describe.skipIf(JCO_DIR === undefined)('the WASI 0.2 component fixture', () => {
  it('is regenerated from the hand-assembled program', async () => {
    const { glue: raw, cores: files } = await (await loadJco()).adaptAndTranspile(tourProgram(), 'tour')
    const glue = (await esbuild.transform(raw, { minify: true, format: 'esm' })).code
    const cores = Object.fromEntries([...files].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]))
    writeFileSync(TOUR_FIXTURE, `${JSON.stringify({ glue, cores })}\n`)
    expect(Object.keys(cores).length).toBeGreaterThan(0)
  })
})
