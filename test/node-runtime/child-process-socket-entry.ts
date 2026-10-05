// Bundled against the shim by ./e2e-child-process.test.ts into the socket
// fixture's page script: spawns a WASI 0.2 component that opens a socket.

import { spawn } from 'child_process'

export interface ComponentSocketResults {
  readonly events?: string[]
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: string
}

async function run (): Promise<ComponentSocketResults> {
  const child = spawn('/bin/socket', [])
  const events: string[] = []
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: { toString: () => string }) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: { toString: () => string }) => { stderr += chunk.toString() })
  child.on('error', (error: Error) => events.push(`error ${error.message}`))
  child.on('spawn', () => events.push('spawn'))
  child.on('exit', (code: number | null, signal: string | null) => events.push(`exit ${String(code)} ${String(signal)}`))
  child.stdin?.end()
  await new Promise((resolve) => child.on('close', resolve))
  return { events, stdout, stderr }
}

;(globalThis as unknown as { componentSocketE2e: { run: () => Promise<ComponentSocketResults> } }).componentSocketE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
