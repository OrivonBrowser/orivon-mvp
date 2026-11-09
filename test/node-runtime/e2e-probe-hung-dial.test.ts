// PROBE (temporary): how dials to a silent listener answer on this system.
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { spawnListener } from './silent-listener.js'

const wait = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

async function probe (label: string, conditional: boolean): Promise<void> {
  const started = Date.now()
  const silent = await spawnListener(process.platform, conditional)
  const startedMs = Date.now() - started
  const connected: number[] = []
  const errors: Record<string, number> = {}
  const sockets = Array.from({ length: 300 }, () => {
    const socket = connect({ host: '127.0.0.1', port: silent.port })
    socket.on('connect', () => { connected.push(Date.now()) })
    socket.on('error', (error: NodeJS.ErrnoException) => { errors[error.code ?? 'error'] = (errors[error.code ?? 'error'] ?? 0) + 1 })
    return socket
  })
  const report: string[] = []
  const t0 = Date.now()
  for (const at of [1500, 3000, 6000, 12000]) {
    await wait(at - (Date.now() - t0))
    report.push(`t=${String(at)}ms connected=${String(connected.length)} errors=${JSON.stringify(errors)} pending=${String(300 - connected.length - Object.values(errors).reduce((a, b) => a + b, 0))}`)
  }
  for (const socket of sockets) socket.destroy()
  silent.stop()
  console.log(`PROBE ${process.platform} ${label} (listener ready in ${String(startedMs)}ms)\n${report.join('\n')}`)
}

it('probe: dials to the silent listener', async () => {
  await probe('default', true)
  if (process.platform === 'win32') await probe('plain listener', false)
  expect(true).toBe(true)
}, 120_000)
