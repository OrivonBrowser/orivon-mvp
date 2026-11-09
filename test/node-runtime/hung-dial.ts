// An address whose dials do not complete, for the specs that prove what the broker does with a dial that hangs.
//
// Where the system allows it the address is a loopback listener in a child process that is then stopped: its backlog
// of one fills after a few connections and the kernel gives the rest no answer, as a peer that has gone silent would
// not answer. Windows has no stopped process, and answers a connection past a full backlog with a refusal, and one
// the program has not accepted with a timeout after 300 ms, so on loopback no dial there stays pending. There the
// address is one in the range reserved for documentation (RFC 5737), which no network routes: the stack sends the
// connection request out and nothing answers it for about 21 s.

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import type { ChildProcess } from 'node:child_process'

export interface HungDial {
  readonly host: string
  readonly port: number
  /** The `host:port` a manifest's `tcp.connect` names to reach it. */
  readonly pattern: string
  /** Ends the listener's process, which frees the connections held in its backlog; nothing to end on Windows. */
  stop: () => void
}

const LISTENER_SCRIPT = "const s = require('node:net').createServer(); s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => console.log(s.address().port))"
const UNROUTABLE_HOST = '192.0.2.1'
const UNROUTABLE_PORT = 49_999
/** How long a probe dial must stay pending for the address to count as one that hangs. */
const PROBE_MS = 1500

/** Rejects with what the system said if a dial to the address is answered within `PROBE_MS`, which no spec here can use. */
async function assertUnroutableHangs (): Promise<void> {
  const answer = await new Promise<string | undefined>((resolve) => {
    const socket = connect({ host: UNROUTABLE_HOST, port: UNROUTABLE_PORT })
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined) }, PROBE_MS)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected') })
    socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? String(error)) })
  })
  if (answer !== undefined) throw new Error(`a dial to ${UNROUTABLE_HOST}:${String(UNROUTABLE_PORT)} was answered at once (${answer}): this machine has no network route that drops it, and the spec needs a dial that never completes`)
}

async function startStoppedListener (): Promise<HungDial> {
  const child: ChildProcess = spawn('node', ['-e', LISTENER_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.stdout?.once('data', (chunk: Buffer) => { resolve(Number(chunk.toString().trim())) })
  })
  child.kill('SIGSTOP')
  return { host: '127.0.0.1', port, pattern: `127.0.0.1:${String(port)}`, stop: () => { child.kill('SIGCONT'); child.kill('SIGKILL') } }
}

export async function startHungDial (): Promise<HungDial> {
  if (process.platform !== 'win32') return await startStoppedListener()
  await assertUnroutableHangs()
  return { host: UNROUTABLE_HOST, port: UNROUTABLE_PORT, pattern: `${UNROUTABLE_HOST}:${String(UNROUTABLE_PORT)}`, stop: () => {} }
}
