// A loopback address whose dials do not complete, for the specs that prove what the broker does with a dial that
// hangs. Where the system allows it, the listener lives in a child process that is stopped once it listens: its
// backlog of one fills after a few connections, and the kernel gives the rest no answer, as a peer that has gone
// silent would not answer. Windows has no stopped process and refuses a connection past a full backlog, so there the
// listener asks the stack to hold every connection until the program accepts it, which it never does.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface SilentListener {
  readonly port: number
  /** Ends the listener's process, which frees the connections held in its backlog. */
  stop: () => void
}

const POSIX_SCRIPT = "const s = require('node:net').createServer(); s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => console.log(s.address().port))"

/** SO_CONDITIONAL_ACCEPT: the stack answers a connection only once the program accepts it. */
export function windowsScript (conditional: boolean): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$listener = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp)',
    '$listener.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, 0))',
    conditional ? '$listener.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]0x3002, 1)' : '',
    '$listener.Listen(1)',
    '[Console]::Out.WriteLine(([System.Net.IPEndPoint]$listener.LocalEndPoint).Port)',
    '[Console]::Out.Flush()',
    'Start-Sleep -Seconds 3600'
  ].join('\n')
}

export async function spawnListener (platform: NodeJS.Platform, conditional = true): Promise<SilentListener> {
  const windows = platform === 'win32'
  const child: ChildProcess = windows
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(windowsScript(conditional), 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['-e', POSIX_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { reject(new Error(`the silent listener exited with ${String(code)} before it listened: ${stderr}`)) })
    child.stdout?.once('data', (chunk: Buffer) => { resolve(Number(chunk.toString().trim())) })
  })
  if (!windows) child.kill('SIGSTOP')
  return { port, stop: () => { if (!windows) child.kill('SIGCONT'); child.kill('SIGKILL') } }
}

export async function startSilentListener (): Promise<SilentListener> {
  return await spawnListener(process.platform)
}
