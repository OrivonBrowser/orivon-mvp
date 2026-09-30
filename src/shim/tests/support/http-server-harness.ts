// Helpers for the http.Server suites: start the shim's server on a real
// loopback port (real-tcp-listen.ts), talk to it with real Node clients, and
// send hand-built bytes over a raw `node:net` socket when a test needs a
// malformed, split or pipelined request.

import { connect } from 'node:net'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer, kListen, type HttpServerOptions, type Server } from '../../http/server.js'
import type { IncomingMessage } from '../../http/message.js'
import type { ServerResponse } from '../../http/server-response.js'
import { listenViaRealSocket } from './real-tcp-listen.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void
const started: Server[] = []

export interface Started { readonly server: Server, readonly port: number }

export async function startServer (handler?: Handler, options: HttpServerOptions = {}): Promise<Started> {
  const server = createServer({ ...options, [kListen]: listenViaRealSocket() }, handler)
  started.push(server)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return { server, port: (server.address() as { port: number }).port }
}

/** Closes every server a test started, dropping whatever connections are left. */
export async function stopServers (): Promise<void> {
  for (const server of started.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
}

export interface RawResult { readonly data: string, readonly closed: boolean }

export interface RawOptions {
  /** Resolve as soon as the reply contains this. Default: when the server closes, or after `timeoutMs`. */
  readonly until?: string
  readonly timeoutMs?: number
  /** Milliseconds between the pieces of a multi-piece script. */
  readonly gapMs?: number
  /** Send a FIN after the script. */
  readonly endAfter?: boolean
}

/** Plays `script` (pieces written one after another) on a raw socket and returns what came back, as latin1 text. */
export async function rawExchange (port: number, script: string | readonly (string | Uint8Array)[], options: RawOptions = {}): Promise<RawResult> {
  const pieces = typeof script === 'string' ? [script] : script
  return await new Promise<RawResult>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let data = ''
    let done = false
    const finish = (closed: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ data, closed })
    }
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 400)
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (options.until !== undefined && data.includes(options.until)) finish(false)
    })
    socket.on('close', () => finish(true))
    socket.on('error', () => finish(true))
    socket.on('connect', () => {
      void (async () => {
        for (const piece of pieces) {
          socket.write(piece)
          if (pieces.length > 1) await new Promise((r) => setTimeout(r, options.gapMs ?? 30))
        }
        if (options.endAfter === true) socket.end()
      })()
    })
  })
}

export interface ClientReply {
  readonly status: number
  readonly statusMessage: string
  readonly headers: IncomingHttpHeaders
  readonly rawHeaders: string[]
  readonly body: Buffer
  readonly text: string
}

/** One request with node:http, body sent as given; the reply body read to the end. */
export async function fetchFrom (port: number, path: string, init: { method?: string, headers?: Record<string, string>, body?: string | Buffer } = {}): Promise<ClientReply> {
  return await new Promise<ClientReply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => parts.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(parts)
        resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', headers: res.headers, rawHeaders: res.rawHeaders, body, text: body.toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

export async function waitFor (condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The status line and the header block of a raw reply, and what followed. */
export function splitReply (data: string): { head: string, body: string } {
  const at = data.indexOf('\r\n\r\n')
  return at === -1 ? { head: data, body: '' } : { head: data.slice(0, at), body: data.slice(at + 4) }
}
