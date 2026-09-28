import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { generateTlsFixture } from '../../../broker/adapters/tests/tls-adapter.test-helpers.js'
import { nodeReachDial, REACH_IDLE_TIMEOUT_MS } from '../reach.js'

// The reach timeout is an IDLE timeout on bytes, never a total: a long-poll
// or an event stream that keeps trickling must outlive it, and only a peer
// that goes silent for the whole window is cut off.
describe('nodeReachDial -- idle timeout', () => {
  const IDLE_MS = 150
  let server: HttpsServer
  let port: number
  let ca: string

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    ca = fixture.caCert
    server = createHttpsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url === '/trickle') {
        let sent = 0
        const timer = setInterval(() => {
          res.write(`data: ${String(sent)}\n\n`)
          sent += 1
          if (sent === 8) { clearInterval(timer); res.end() }
        }, IDLE_MS / 2)
        return
      }
      res.write('data: first\n\n') // /stall: one event, then silence
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    port = address.port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('is generous by default: minutes, not seconds, so a long-poll or an event stream survives', () => {
    expect(REACH_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('a response that keeps sending bytes outlives the idle window many times over', async () => {
    const dial = nodeReachDial({ ca, idleTimeoutMs: IDLE_MS })
    const started = Date.now()
    const response = await dial(new Request(`https://localhost:${String(port)}/trickle`), 'localhost', port)
    const text = await response.text()
    expect(Date.now() - started).toBeGreaterThan(IDLE_MS * 2)
    expect(text.match(/data:/g)?.length).toBe(8)
  })

  it('a peer that goes silent mid-body for the whole idle window is cut off, and the reader sees a failure', async () => {
    const dial = nodeReachDial({ ca, idleTimeoutMs: IDLE_MS })
    const response = await dial(new Request(`https://localhost:${String(port)}/stall`), 'localhost', port)
    await expect(response.text()).rejects.toThrow()
  })
})
