// Bundled against the shim by ./e2e-native-addon.test.ts as /files-child.js:
// a forked child of a cross-origin isolated app, whose addon, readFileSync,
// every other fs *Sync call (ADR-0016's Worker amendment) and spawnSync of a
// WASI program all block on the page's orivon.fs/orivon.*.

import { readFileSync, mkdirSync, writeFileSync, statSync, readdirSync, renameSync, rmSync } from 'fs'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const require = createRequire('/files-child.js')
const addon = require('./native/files.node') as { content: string, openErrno: number }

function outcome<T> (run: () => T): { value: T } | { error: string } {
  try {
    return { value: run() }
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) }
  }
}

const syncFs = {
  mkdir: outcome(() => { mkdirSync('synctest', { recursive: true }); return true }),
  write: outcome(() => { writeFileSync('synctest/notes.txt', 'blocking write'); return true }),
  stat: outcome(() => statSync('synctest/notes.txt').size),
  readdir: outcome(() => [...readdirSync('synctest')]),
  rename: outcome(() => { renameSync('synctest/notes.txt', 'synctest/renamed.txt'); return true }),
  rm: outcome(() => { rmSync('synctest', { recursive: true }); return true })
}

const echo = spawnSync('/bin/echo', [], { input: 'blocking spawnSync', encoding: 'utf8' })

process.send?.({
  openErrno: addon.openErrno,
  content: addon.content,
  readFileSync: readFileSync('data.txt', 'utf8'),
  syncFs,
  echo: { status: echo.status, signal: echo.signal, stdout: echo.stdout }
})
