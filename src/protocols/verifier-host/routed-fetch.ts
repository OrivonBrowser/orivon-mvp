// A fetch for what a tunnel-profile website needs from the network: HTTP, over TLS, over a CONNECT to the tunnel
// profile's front. The front opens the stream through the tunnel's route with the name unresolved, so nothing is
// resolved or dialled on this computer, and it answers only a caller that signs in to it. `net.fetch` in a utility
// process cannot sign in (it gets the front's 407), so this speaks to the front with Node's own sockets.
// README.md's Design notes say why the front and not the tunnel's SOCKS5 address.

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import type { ClientRequestArgs } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { collectHeaders, sendNodeRequest } from './direct-fetch.js'
import type { WebFetch } from './egress.js'

/** The tunnel profile's front, as main hands it over (`HostConfig.profileFront`). */
export interface ProfileFront {
  readonly port: number
  readonly username: string
  readonly password: string
}

/** The tunnel carried nothing: it is down, not set up, or refused the destination. A routed request never falls back to another way. */
export class TunnelUnavailable extends Error {
  override readonly name = 'TunnelUnavailable'
}

export interface RoutedFetchOptions {
  /** Read for every new connection, so a front main replaced is followed and an absent one fails the request. */
  readonly front: () => ProfileFront | undefined
  /** Test builds only: a plain-HTTP fixture gateway. */
  readonly allowHttp?: boolean
  /** Test builds only: trusts a private CA for a TLS fixture. */
  readonly ca?: string | Buffer
  readonly idleTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly maxSockets?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000
/** The tunnel may be starting: Nym takes seconds to bring a first stream up. */
const DEFAULT_CONNECT_TIMEOUT_MS = 40_000
const DEFAULT_MAX_SOCKETS = 8
const MAX_HEAD_BYTES = 8 * 1024
const AUTHORITY_HOST = /^[A-Za-z0-9._:[\]-]+$/

function authorityOf (host: string, port: number): string {
  if (!AUTHORITY_HOST.test(host)) throw new TunnelUnavailable(`${host} is not a name the tunnel can be asked for`)
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`
}

/** One stream to `host:port` through the front: its CONNECT answered 200, nothing read past the head. */
async function connectThroughFront (front: ProfileFront, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const authority = authorityOf(host, port)
  return await new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port: front.port })
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => { fail(new TunnelUnavailable(`the tunnel did not open a connection to ${host} within ${String(timeoutMs / 1000)} s`)) }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
    }
    function fail (error: Error): void {
      cleanup()
      socket.destroy()
      reject(error)
    }
    function onClose (): void { fail(new TunnelUnavailable(`the tunnel closed before it opened a connection to ${host}`)) }
    function onData (chunk: Buffer): void {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) {
        if (received.length > MAX_HEAD_BYTES) fail(new TunnelUnavailable('the tunnel answered with something that is not a proxy answer'))
        return
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(received.subarray(0, end).toString('latin1'))?.[1]
      if (status !== '200') {
        fail(new TunnelUnavailable(status === '407' ? 'the tunnel did not accept this computer\'s sign-in' : `the tunnel did not carry the connection to ${host} (it answered ${status ?? 'with no status'})`))
        return
      }
      cleanup()
      socket.pause()
      const rest = received.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      socket.on('error', () => {})
      resolve(socket)
    }
    socket.on('data', onData)
    socket.on('error', (error) => { fail(new TunnelUnavailable(`the tunnel is not reachable: ${error.message}`)) })
    socket.on('close', onClose)
    socket.once('connect', () => {
      const credentials = Buffer.from(`${front.username}:${front.password}`).toString('base64')
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`)
    })
  })
}

/** An agent whose every connection is made through the front, kept alive and pooled per destination as any agent's are. */
interface AgentSettings {
  readonly front: RoutedFetchOptions['front']
  readonly maxSockets: number
  readonly connectTimeoutMs: number
  readonly ca: string | Buffer | undefined
}

function agentFor (secure: boolean, options: AgentSettings): HttpAgent {
  const dial = (args: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): undefined => {
    const host = String(args.hostname ?? args.host ?? '')
    const port = Number(args.port ?? (secure ? 443 : 80))
    const front = options.front()
    const done = callback ?? (() => {})
    if (front === undefined) { done(new TunnelUnavailable('there is no tunnel to send this through'), undefined as unknown as Duplex); return undefined }
    connectThroughFront(front, host, port, options.connectTimeoutMs).then(
      (carrier) => {
        // The stream arrives paused: a TLS layer takes it over, and a plain request reads it from here on.
        if (!secure) { carrier.resume(); done(null, carrier); return }
        const tls = tlsConnect({ socket: carrier, host, servername: host, ca: options.ca })
        done(null, tls)
      },
      (error: unknown) => { done(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex) }
    )
    return undefined
  }
  const settings = { keepAlive: true, maxSockets: options.maxSockets }
  if (secure) {
    class FrontHttpsAgent extends HttpsAgent {
      override createConnection (args: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined { return dial(args, callback) }
    }
    return new FrontHttpsAgent(settings)
  }
  class FrontHttpAgent extends HttpAgent {
    override createConnection (args: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined { return dial(args, callback) }
  }
  return new FrontHttpAgent(settings)
}

function bodyOf (body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('a request sent through the tunnel carries a string or bytes as its body')
}

/**
 * A `fetch` that sends each request through the tunnel profile's front and nowhere else: GET, HEAD or POST over `https`,
 * a redirect handed back as a response and never followed (`allowlisted` turns it into the refusal), no cookie and no
 * cache. A tunnel that cannot carry the connection rejects with `TunnelUnavailable`; nothing is retried another way.
 */
export function createRoutedFetch (options: RoutedFetchOptions): WebFetch {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const settings = { front: options.front, maxSockets: options.maxSockets ?? DEFAULT_MAX_SOCKETS, connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, ca: options.ca }
  const secureAgent = agentFor(true, settings)
  const plainAgent = options.allowHttp === true ? agentFor(false, settings) : undefined
  return async (url, init) => {
    const parsed = new URL(url)
    const secure = parsed.protocol === 'https:'
    if (!secure && !(parsed.protocol === 'http:' && plainAgent !== undefined)) throw new Error(`a routed fetch only reaches https, not ${parsed.protocol}`)
    if (parsed.username !== '' || parsed.password !== '') throw new Error('a routed fetch does not take credentials in the address')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new Error(`a routed fetch only supports GET, HEAD and POST, not ${method}`)
    const body = method === 'POST' ? bodyOf(init?.body) : undefined
    const headers = collectHeaders(init)
    if (body !== undefined) headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength)
    const requestOptions: RequestOptions = {
      method,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      servername: parsed.hostname,
      port: parsed.port !== '' ? parsed.port : secure ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      agent: secure ? secureAgent : plainAgent,
      signal: init?.signal ?? undefined,
      timeout: idleTimeoutMs
    }
    return await sendNodeRequest({ request: secure ? httpsRequest : httpRequest, options: requestOptions, method, body, hostname: parsed.hostname, idleTimeoutMs, allowRedirect: true, label: 'routed fetch' })
  }
}
