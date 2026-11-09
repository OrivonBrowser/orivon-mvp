// PROBE (temporary): how dials to a silent listener answer on this system.
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { spawnListener } from './silent-listener.js'

const wait = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

async function probe (label: string, conditional: boolean, backlog: number, dials: number, windowMs: number, target?: { host: string, port: number }): Promise<void> {
  const started = Date.now()
  const silent = target === undefined ? await spawnListener(process.platform, conditional, backlog) : { port: target.port, stop: () => {} }
  const host = target?.host ?? '127.0.0.1'
  const startedMs = Date.now() - started
  const t0 = Date.now()
  let connected = 0
  const errors: Record<string, { n: number, first: number, last: number }> = {}
  const sockets = Array.from({ length: dials }, () => {
    const socket = connect({ host, port: silent.port })
    socket.on('connect', () => { connected += 1 })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'error'
      const at = Date.now() - t0
      const seen = errors[code] ?? { n: 0, first: at, last: at }
      seen.n += 1
      seen.last = at
      errors[code] = seen
    })
    return socket
  })
  const lines: string[] = []
  let next = 500
  while (Date.now() - t0 < windowMs) {
    await wait(Math.max(0, next - (Date.now() - t0)))
    const settled = Object.values(errors).reduce((a, b) => a + b.n, 0)
    lines.push(`t=${String(next)}ms connected=${String(connected)} errors=${JSON.stringify(errors)} pending=${String(dials - connected - settled)}`)
    next += next < 4000 ? 500 : 2000
  }
  for (const socket of sockets) socket.destroy()
  silent.stop()
  console.log(`PROBE ${process.platform} ${label} (listener ready in ${String(startedMs)}ms)\n${lines.join('\n')}`)
}

it('probe: dials to the silent listener', async () => {
  if (process.platform === 'win32') {
    await probe('conditional backlog 1', true, 1, 300, 12_000)
    await probe('conditional backlog 200', true, 200, 300, 30_000)
    await probe('conditional backlog 5000', true, 5000, 300, 30_000)
    await probe('unroutable 192.0.2.1:9', true, 1, 3, 30_000, { host: '192.0.2.1', port: 9 })
  } else {
    await probe('posix', true, 1, 300, 8_000)
  }
  expect(true).toBe(true)
}, 180_000)
