// Bundled against the shim by ./e2e-child-host.test.ts into the fixture
// app's page script (served at both index.html and second.html, so two tabs
// of one app run the identical bundle): starts a forked heartbeat and reads
// back what it has written, so the test can watch it keep ticking, or stop,
// from whichever tab is still open.

import { promises as fs } from 'fs'
import { fork } from 'child_process'

export interface ChildHostE2eResults {
  readonly started?: boolean
  readonly error?: string
}

let child: ReturnType<typeof fork> | undefined

async function start (): Promise<ChildHostE2eResults> {
  try {
    child = fork('/heartbeat.js', [], { silent: true })
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve())
      child?.once('error', (error: Error) => reject(error))
    })
    return { started: true }
  } catch (error) {
    return { error: String(error) }
  }
}

/** The heartbeat file's current tick count, or -1 before it exists yet (the
 * forked child has not written its first tick). */
async function readCount (): Promise<number> {
  try {
    const bytes = await fs.readFile('heartbeat.txt')
    return Number(new TextDecoder().decode(bytes))
  } catch {
    return -1
  }
}

;(globalThis as unknown as { childHostE2e: { start: typeof start, readCount: typeof readCount } }).childHostE2e = { start, readCount }
