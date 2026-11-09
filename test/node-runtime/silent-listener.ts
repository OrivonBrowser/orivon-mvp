// A loopback address whose dials do not complete, for the specs that prove what the broker does with a dial that
// hangs. The listener lives in a child process that blocks its own thread once it listens, so it never accepts: its
// backlog of one fills after a few connections, and the kernel gives the rest no answer, as a peer that has gone
// silent would not answer. Blocking the thread instead of signalling the process keeps this the same on every system
// (a stopped process has no Windows equivalent).

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface SilentListener {
  readonly port: number
  /** Ends the listener's process, which frees the connections held in its backlog. */
  stop: () => void
}

const LISTENER_SCRIPT = `
const server = require('node:net').createServer()
server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
  require('node:fs').writeSync(1, server.address().port + '\\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})
`

/** Starts the listener and resolves with its port once it is blocked and no longer accepting. */
export async function startSilentListener (): Promise<SilentListener> {
  const child: ChildProcess = spawn(process.execPath, ['-e', LISTENER_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { reject(new Error(`the silent listener exited with ${String(code)} before it listened`)) })
    child.stdout?.once('data', (chunk: Buffer) => { resolve(Number(chunk.toString().trim())) })
  })
  return { port, stop: () => { child.kill('SIGKILL') } }
}
