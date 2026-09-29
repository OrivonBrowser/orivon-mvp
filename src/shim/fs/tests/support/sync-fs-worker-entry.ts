// The Worker end of sync-in-worker.test.ts, run in a real worker_threads
// thread (never the thread that serves it, worker/README.md's own rule):
// installs the Worker's synchronous orivon, then drives fs.ts's *Sync
// exports against it, exactly as a ported dependency would.

import { parentPort, workerData } from 'node:worker_threads'
import { createOrivonClient } from '../../../worker/orivon-client.js'
import * as fs from '../../fs.js'

const { port } = workerData as { port: MessagePort }
;(globalThis as unknown as { orivon: unknown }).orivon = createOrivonClient(port)

function outcome (run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    return { error: { name: (error as Error).name, code: (error as { code?: unknown }).code } }
  }
}

const results = {
  mkdir: outcome(() => { fs.mkdirSync('dir/nested', { recursive: true }); return true }),
  write: outcome(() => { fs.writeFileSync('dir/notes.txt', 'hello sync'); return true }),
  append: outcome(() => { fs.appendFileSync('dir/notes.txt', '!'); return true }),
  stat: outcome(() => fs.statSync('dir/notes.txt').size),
  lstat: outcome(() => fs.lstatSync('dir/notes.txt').size),
  readdir: outcome(() => [...fs.readdirSync('dir')].sort()),
  readdirTypes: outcome(() => [...(fs.readdirSync('dir', { withFileTypes: true }) as ReadonlyArray<{ name: string, isDirectory: () => boolean }>)]
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name))),
  copy: outcome(() => { fs.copyFileSync('dir/notes.txt', 'dir/copy.txt'); return true }),
  rename: outcome(() => { fs.renameSync('dir/copy.txt', 'dir/renamed.txt'); return true }),
  readBack: outcome(() => new TextDecoder().decode(fs.readFileSync('dir/renamed.txt') as Uint8Array)),
  access: outcome(() => { fs.accessSync('dir/renamed.txt'); return true }),
  unlink: outcome(() => { fs.unlinkSync('dir/renamed.txt'); return true }),
  mkdtemp: outcome(() => fs.mkdtempSync('dir/tmp-')),
  // orivon.fs has one remove primitive, which always needs `recursive` for a
  // directory (core-sync.ts's own doRmdirSync doc comment) -- true here even
  // though 'dir/nested' is empty.
  rmdir: outcome(() => { fs.rmdirSync('dir/nested', { recursive: true }); return true }),
  rm: outcome(() => { fs.rmSync('dir', { recursive: true }); return true }),
  missingAfterRm: outcome(() => fs.statSync('dir'))
}

parentPort?.postMessage(results)
