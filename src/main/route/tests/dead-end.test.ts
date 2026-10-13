import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startDeadEnd } from '../dead-end.js'
import type { DeadEnd } from '../dead-end.js'

let held: DeadEnd | undefined
afterEach(async () => { await held?.close(); held = undefined })

describe('the dead end', () => {
  it('listens on loopback at a port of its own', async () => {
    held = await startDeadEnd()
    const other = await startDeadEnd()
    expect(held.port).toBeGreaterThan(0)
    expect(other.port).not.toBe(held.port)
    await other.close()
  })

  it('accepts a connection and closes it without reading or answering', async () => {
    held = await startDeadEnd()
    const events = await new Promise<string>((resolve) => {
      const socket = connect(held?.port ?? 0, '127.0.0.1')
      let seen = ''
      socket.on('data', (chunk) => { seen += chunk.toString() })
      socket.on('close', () => { resolve(seen) })
      socket.on('error', () => {})
      socket.on('connect', () => { socket.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n') })
    })
    expect(events).toBe('')
  })
})
