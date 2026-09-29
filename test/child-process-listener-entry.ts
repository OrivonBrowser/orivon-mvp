// Bundled against the shim by ./e2e-child-process.test.ts into the listener
// fixture's page script: spawns a WASI 0.2 component that listens, then
// connects to it through Node's net, as an app's page reaches its daemon.

import { spawn } from 'child_process'
import { connect } from 'net'

export interface ComponentListenerResults {
  readonly events?: string[]
  readonly stdout?: string
  readonly echoed?: string
  readonly error?: string
}

const MESSAGE = 'hello from the page\n'
const progress: string[] = []
;(globalThis as unknown as { componentListenerProgress: string[] }).componentListenerProgress = progress

async function run (port: number): Promise<ComponentListenerResults> {
  const child = spawn('/bin/listener', [])
  const events: string[] = []
  let stdout = ''
  child.on('spawn', () => events.push('spawn'))
  child.on('exit', (code: number | null, signal: string | null) => { events.push(`exit ${String(code)} ${String(signal)}`); progress.push(`exit ${String(code)}`) })
  child.on('error', (error: Error) => events.push(`error ${error.message}`))
  child.stderr?.on('data', (chunk: { toString: () => string }) => progress.push(`stderr ${chunk.toString()}`))
  const closed = new Promise((resolve) => child.on('close', resolve))
  const listening = new Promise<boolean>((resolve) => {
    child.stdout?.on('data', (chunk: { toString: () => string }) => {
      stdout += chunk.toString()
      if (stdout.includes('listening')) resolve(true)
    })
    child.on('exit', () => { resolve(false) })
  })
  child.stdin?.end()
  if (!await listening) return { events, stdout }
  progress.push('listening')
  const socket = connect(port, '127.0.0.1')
  socket.on('connect', () => progress.push('connected'))
  const echoed = await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk: { toString: () => string }) => { resolve(chunk.toString()) })
    socket.once('error', reject)
    socket.write(MESSAGE)
  })
  progress.push('echoed')
  socket.end()
  await closed
  return { events, stdout, echoed }
}

;(globalThis as unknown as { componentListenerE2e: { run: (port: number) => Promise<ComponentListenerResults> } }).componentListenerE2e = {
  run: async (port) => { try { return await run(port) } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
