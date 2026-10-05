// Bundled against the shim by ./e2e-child-host.test.ts into the spawn-through-
// host fixture's page script (served at both index.html and second.html, so
// two tabs of one app run the identical bundle): `start()` spawns a WASI 0.2
// component that listens, the way tab A does; `connectAndEcho()` connects to
// it over plain `net`, the way a later tab (or the same one) reaches an
// already-running daemon, draining its reply so the ack this fixture also
// exercises (the component's own echo is written to ITS stdout, over the
// same ack protocol a forked child's writes never use) never stalls.

import { spawn } from 'child_process'
import { connect } from 'net'

export interface ChildHostSpawnStartResult {
  readonly started?: boolean
  readonly stdout?: string
  readonly error?: string
}

export interface ChildHostSpawnEchoResult {
  readonly echoed?: string
  readonly error?: string
}

let stdout = ''

async function start (): Promise<ChildHostSpawnStartResult> {
  try {
    const child = spawn('/bin/listener', [])
    const listening = new Promise<boolean>((resolve) => {
      child.stdout?.on('data', (chunk: { toString: () => string }) => {
        stdout += chunk.toString()
        if (stdout.includes('listening')) resolve(true)
      })
      child.on('exit', () => { resolve(false) })
      child.on('error', () => { resolve(false) })
    })
    return { started: await listening, stdout }
  } catch (error) {
    return { error: String(error) }
  }
}

async function connectAndEcho (port: number, timeoutMs = 5000): Promise<ChildHostSpawnEchoResult> {
  return await new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); resolve({ error: 'timed out waiting for a reply' }) }, timeoutMs)
    const done = (result: ChildHostSpawnEchoResult): void => { clearTimeout(timer); resolve(result) }
    socket.once('error', (error: Error) => { done({ error: error.message }) })
    socket.once('data', (chunk: { toString: () => string }) => { done({ echoed: chunk.toString() }) })
    socket.once('connect', () => { socket.write('hello from a later tab\n') })
  })
}

;(globalThis as unknown as {
  childHostSpawnE2e: { start: typeof start, connectAndEcho: typeof connectAndEcho }
}).childHostSpawnE2e = { start, connectAndEcho }
