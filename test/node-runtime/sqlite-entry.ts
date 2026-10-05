// Bundled against the shim by ./e2e-sqlite.test.ts into the fixture app's page
// script: it forks the app's /sqlite-child.js, which opens a database file, and
// reads what that left in the app's files.

import { fork } from 'child_process'

export interface SqliteResults {
  readonly reply?: unknown
  readonly fileStart?: string
  readonly fileBytes?: number
  readonly journalLeft?: boolean
  readonly pageMemoryRefusal?: { name?: string, message?: string } | undefined
  readonly error?: string
}

async function run (): Promise<SqliteResults> {
  const child = fork('/sqlite-child.js', [], { silent: true })
  let stderr = ''
  child.stderr?.on('data', (chunk: { toString: () => string }) => { stderr += chunk.toString() })
  const reply = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('exit', (code: number | null) => reject(new Error(`the child exited ${String(code)} before it replied: ${stderr}`)))
    child.send({ go: true })
  })
  const orivon = (window as unknown as { orivon: { fs: { readFile: (path: string) => Promise<Uint8Array>, stat: (path: string) => Promise<unknown> } } }).orivon
  const file = await orivon.fs.readFile('data/scrollback.sqlite3')
  const journalLeft = await orivon.fs.stat('data/scrollback.sqlite3-journal').then(() => true, () => false)
  child.kill()
  return { reply, fileStart: new TextDecoder().decode(file.subarray(0, 15)), fileBytes: file.length, journalLeft }
}

;(globalThis as unknown as { sqliteE2e: { run: () => Promise<SqliteResults> } }).sqliteE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
