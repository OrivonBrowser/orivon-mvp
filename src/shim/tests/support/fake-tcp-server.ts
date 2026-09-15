// A fake TcpServer (src/contracts/handles.ts) for exercising
// node-net-server.ts without a broker, a preload or an Electron launch --
// the accept-side counterpart of fake-tcp-socket.ts. `connections` is a REAL
// ReadableStream run at highWaterMark: 0, matching the broker's own
// TcpServer.connections exactly (handle-contracts.md's "TcpServer" section),
// so `pullCount()` is a faithful count of how many accept-demand signals
// node-net-server.ts's Server actually issued -- the property
// node-net-server.test.ts exists to prove. Under tests/support/, not
// tests/, for the same reason fake-tcp-socket.ts is: vitest.config.ts's
// `include` only matches `*.test.ts`.

import type { OrivonErrorCode } from '../../../contracts/errors.js'
import type { TcpServer, TcpSocket } from '../../../contracts/handles.js'

export interface FakeTcpServer {
  readonly server: TcpServer
  /** How many times the connections stream's pull() has fired -- one per unit of accept demand. */
  pullCount (): number
  /** Delivers one accepted connection in response to the current outstanding pull. */
  deliver (socket: TcpSocket): void
  /** Simulates the connections stream ending cleanly (server closed from the broker's side). */
  end (): void
  /** Simulates an abrupt failure on the connections stream. */
  fail (code: OrivonErrorCode, message: string, platformCode?: string): void
  /** Whether the server called TcpServer.close(). */
  closed (): boolean
}

function makeOrivonError (code: OrivonErrorCode, message: string, platformCode?: string): Error {
  const error = new Error(message) as Error & { code: OrivonErrorCode, platformCode?: string }
  error.code = code
  if (platformCode !== undefined) error.platformCode = platformCode
  return error
}

export function createFakeTcpServer (opts: { localAddress?: string, localPort?: number } = {}): FakeTcpServer {
  let pulls = 0
  let connectionsController!: ReadableStreamDefaultController<TcpSocket>
  const connections = new ReadableStream<TcpSocket>({
    start (controller) { connectionsController = controller },
    pull () { pulls++ }
  }, new CountQueuingStrategy({ highWaterMark: 0 }))

  let didClose = false
  const server: TcpServer = {
    id: 'fake-tcp-server',
    closed: new Promise(() => {}),
    close: async () => { didClose = true },
    connections,
    localAddress: opts.localAddress ?? '0.0.0.0',
    localPort: opts.localPort ?? 4000
  }

  return {
    server,
    pullCount: () => pulls,
    deliver: (socket) => connectionsController.enqueue(socket),
    end: () => connectionsController.close(),
    fail: (code, message, platformCode) => connectionsController.error(makeOrivonError(code, message, platformCode)),
    closed: () => didClose
  }
}
