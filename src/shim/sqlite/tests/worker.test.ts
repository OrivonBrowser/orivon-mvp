// The module in a real Worker thread that blocks on every file call, over a
// real disk: what a forked child of a cross-origin isolated app does. The
// file it leaves is then opened by Node's own node:sqlite.

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { serveOrivon } from '../../worker/orivon-server.js'

describe('DatabaseSync in a Worker thread', () => {
  it('writes, closes, reopens and reads a file Node\'s own sqlite opens', async () => {
    const built = await esbuild.build({
      entryPoints: [join(import.meta.dirname, 'support', 'worker-entry.ts')],
      bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
      alias: { '@sqlite.org/sqlite-wasm': createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/package.json').replace('package.json', 'dist/index.mjs') },
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
    })
    const scratch = mkdtempSync(join(tmpdir(), 'orivon-sqlite-worker-'))
    const entry = join(scratch, 'worker.mjs')
    await import('node:fs/promises').then(async ({ writeFile }) => { await writeFile(entry, built.outputFiles[0]?.text ?? '') })
    const disk = await createRealDiskFs()
    const { port1, port2 } = new MessageChannel()
    const server = serveOrivon(port1 as unknown as globalThis.MessagePort, disk.orivon)
    const wasmPath = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')
    const worker = new Worker(entry, { workerData: { port: port2, wasmPath }, transferList: [port2 as never] })
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      expect(result).toEqual({ counted: 500, last: 'message 499 ', integrity: { integrity_check: 'ok' } })
      expect(await disk.existsOnDisk('data/scrollback.sqlite3-journal')).toBe(false)
      const real = new NodeDatabaseSync(join(disk.root, 'data/scrollback.sqlite3'), { readOnly: true })
      expect(real.prepare('select count(*) as n from messages').get()).toEqual({ n: 500 })
      real.close()
    } finally {
      await worker.terminate()
      await server.dispose()
      await disk.cleanup()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
