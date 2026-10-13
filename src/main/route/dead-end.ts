// The place a session is pointed at to stop it: a listener on a random loopback port that Orivon holds, which accepts a
// connection and closes it, so a request there fails at once and nothing else on this computer is ever shown a destination
// name. Electron-free; README.md says when a session is stopped.

import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'

export interface DeadEnd {
  readonly port: number
  close: () => Promise<void>
}

export async function startDeadEnd (): Promise<DeadEnd> {
  const server: Server = createServer((socket) => {
    socket.on('error', () => {})
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  // A later error on a listener nobody reads from must not end the browser.
  server.on('error', (error) => { console.error('[route] the dead end failed:', error) })
  server.unref()
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }
  }
}
