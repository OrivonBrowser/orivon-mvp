// PROBE (temporary): how a full backlog answers on this system.
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { startSilentListener } from './silent-listener.js'

const wait = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

it('probe: dials to the silent listener', async () => {
  const silent = await startSilentListener()
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
  for (const at of [1500, 3000, 6000, 12000, 25000]) {
    await wait(at - (Date.now() - t0))
    report.push(`t=${String(at)}ms connected=${String(connected.length)} errors=${JSON.stringify(errors)} pending=${String(300 - connected.length - Object.values(errors).reduce((a, b) => a + b, 0))}`)
  }
  for (const socket of sockets) socket.destroy()
  silent.stop()
  console.log(`PROBE ${process.platform}\n${report.join('\n')}`)
  expect(report.length).toBe(5)
}, 60_000)
