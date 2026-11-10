// The relay's connection to an address: through the proxy the system named (an HTTP or HTTPS proxy by CONNECT, SOCKS5, SOCKS4),
// or straight to it for a first `DIRECT`. Every call asks for an address, never a name, and hands the stream back paused.
// Tied to the operating system's network (`node:net`, `node:tls`), not to Electron.

import { connect as netConnect, isIP } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect, getCACertificates } from 'node:tls'
import { SocksClient } from 'socks'
import { createSocks5Provider } from '../../../broker/route/socks5.js'
import { nextAddressAfterSocks, nextAddressAfterStatus } from './addresses.js'
import type { ProxyEntry } from './proxy-answer.js'

/** How long each step of reaching an address (connecting, then the proxy's answer) may take. */
export const UPSTREAM_TIMEOUT_MS = 15_000
const MAX_HEAD_BYTES = 16_384

/** What a failure means for what comes next: `proxy`, this proxy could not be reached (try the next one of the list); `address`, it could not reach that address (try the next address); `final`, neither would change the answer. */
export type UpstreamEffect = 'proxy' | 'address' | 'final'

export class UpstreamFailure extends Error {
  readonly effect: UpstreamEffect
  readonly word: 'unreachable' | 'sign-in' | 'refused'
  constructor (effect: UpstreamEffect, word: UpstreamFailure['word']) {
    super(`the upstream did not carry the connection (${effect}, ${word})`)
    this.effect = effect
    this.word = word
  }
}

export interface UpstreamOptions {
  readonly timeoutMs?: number
  /** The certificates an HTTPS proxy is verified against, as PEM; the bundled and the system's roots when left out. */
  readonly roots?: readonly string[]
}

/** What a connection that its client gave up on rejects with. */
export function abandoned (): Error {
  return Object.assign(new Error('the connection was abandoned'), { name: 'AbortError' })
}

function ignore (): void {}

/** Resolves with `socket`, paused, once it emits `ready`; rejects as `effect` on an error or the time allowed, and as an abort when `signal` fires. */
async function readied (socket: Socket, ready: 'connect' | 'secureConnect', signal: AbortSignal, timeoutMs: number, effect: UpstreamEffect): Promise<Socket> {
  socket.on('error', ignore)
  return await new Promise((resolve, reject) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); socket.off(ready, onReady); socket.off('error', onError) }
    const onError = (): void => { finish(); socket.destroy(); reject(new UpstreamFailure(effect, 'unreachable')) }
    const onAbort = (): void => { finish(); socket.destroy(); reject(abandoned()) }
    const onReady = (): void => { finish(); socket.pause(); resolve(socket) }
    const timer = setTimeout(onError, timeoutMs)
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('error', onError)
    socket.once(ready, onReady)
  })
}

let systemRoots: string[] | undefined | null = null

/** The roots Node reads: its bundled ones and the operating system's. A runtime that cannot read the system's keeps Node's own. */
function trustedRoots (): string[] | undefined {
  if (systemRoots === null) {
    try {
      systemRoots = [...getCACertificates('bundled'), ...getCACertificates('system')]
    } catch {
      systemRoots = undefined
    }
  }
  return systemRoots
}

async function dialProxy (proxy: ProxyEntry, signal: AbortSignal, options: UpstreamOptions): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  if (proxy.kind === 'https') {
    const ca = options.roots === undefined ? trustedRoots() : [...options.roots]
    const secure = tlsConnect({ host: proxy.host, port: proxy.port, ...(isIP(proxy.host) === 0 ? { servername: proxy.host } : {}), ...(ca === undefined ? {} : { ca }) })
    return await readied(secure, 'secureConnect', signal, timeoutMs, 'proxy')
  }
  return await readied(netConnect({ host: proxy.host, port: proxy.port }), 'connect', signal, timeoutMs, 'proxy')
}

/** The status line of the proxy's answer to a CONNECT and whatever followed its head. The stream is paused afterwards. */
async function readAnswer (socket: Socket, signal: AbortSignal, timeoutMs: number): Promise<{ status: number, rest: Buffer }> {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); socket.off('data', onData); socket.off('close', onClose); socket.pause() }
    const fail = (error: Error): void => { finish(); reject(error) }
    const onClose = (): void => { fail(new UpstreamFailure('proxy', 'unreachable')) }
    const onAbort = (): void => { fail(abandoned()) }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) fail(new UpstreamFailure('proxy', 'unreachable'))
        return
      }
      const status = /^HTTP\/1\.[01] (\d{3})[ \r]/.exec(`${buffered.subarray(0, end).toString('latin1')}\r`)
      if (status === null) { fail(new UpstreamFailure('proxy', 'unreachable')); return }
      finish()
      resolve({ status: Number(status[1]), rest: buffered.subarray(end + 4) })
    }
    const timer = setTimeout(() => { fail(new UpstreamFailure('address', 'unreachable')) }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.resume()
  })
}

function failureOfStatus (status: number): UpstreamFailure {
  if (nextAddressAfterStatus(status)) return new UpstreamFailure('address', 'unreachable')
  return new UpstreamFailure('final', status === 407 ? 'sign-in' : 'refused')
}

/** `CONNECT <address>:<port>` over `socket`, a connection to an HTTP or HTTPS proxy. The request carries the address and nothing that could name a site. */
async function tunnel (socket: Socket, address: string, port: number, signal: AbortSignal, timeoutMs: number): Promise<Socket> {
  const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${String(port)}`
  try {
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    const { status, rest } = await readAnswer(socket, signal, timeoutMs)
    if (status < 200 || status >= 300) throw failureOfStatus(status)
    if (rest.length > 0) socket.unshift(rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** What an error from the `socks` package says about the proxy's answer; one that is not an answer means the proxy could not be reached. */
function failureOfSocks (error: unknown): UpstreamFailure {
  const message = error instanceof Error ? error.message : ''
  const rejected = /^Socks[45] [Pp]roxy rejected connection - \(?(\w+)/.exec(message)
  if (rejected !== null) {
    const reply = rejected[1] ?? ''
    if (nextAddressAfterSocks(reply)) return new UpstreamFailure('address', 'unreachable')
    return new UpstreamFailure('final', reply === 'Rejected' || reply === 'RejectedIdent' ? 'sign-in' : 'refused')
  }
  if (/Authentication failed|no accepted authentication type/.test(message)) return new UpstreamFailure('final', 'sign-in')
  return new UpstreamFailure(message === 'Proxy connection timed out' ? 'address' : 'proxy', 'unreachable')
}

/** Bytes the proxy sent behind its answer are the target's first words: held until the package has resumed the stream, then put back in front of it. */
async function keepEarlyBytes (socket: Socket): Promise<void> {
  const held: Buffer[] = []
  const hold = (chunk: Buffer): void => { held.push(chunk) }
  socket.on('data', hold)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  socket.off('data', hold)
  socket.pause()
  if (held.length > 0 && !socket.destroyed) socket.unshift(Buffer.concat(held))
}

async function viaSocks4 (proxy: ProxyEntry, address: string, port: number, signal: AbortSignal, options: UpstreamOptions): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  const socket = await dialProxy(proxy, signal, options)
  socket.resume()
  const onAbort = (): void => { socket.destroy() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const established = await SocksClient.createConnection({ proxy: { host: proxy.host, port: proxy.port, type: 4 }, command: 'connect', destination: { host: address, port }, existing_socket: socket, timeout: timeoutMs })
    await keepEarlyBytes(established.socket)
    return established.socket
  } catch (error) {
    socket.destroy()
    throw signal.aborted ? abandoned() : failureOfSocks(error)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function viaSocks5 (proxy: ProxyEntry, address: string, port: number, signal: AbortSignal, options: UpstreamOptions): Promise<Socket> {
  try {
    return await createSocks5Provider({ host: proxy.host, port: proxy.port, timeoutMs: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS }).connect(address, port, signal)
  } catch (error) {
    throw signal.aborted ? abandoned() : failureOfSocks(error)
  }
}

/**
 * A stream to `address:port` through `proxy`, paused. Rejects with an `UpstreamFailure` saying what to try next, or with an
 * `AbortError` when `signal` fires first. SOCKS4 carries IPv4 only.
 */
export async function connectThroughProxy (proxy: ProxyEntry, address: string, port: number, signal: AbortSignal, options: UpstreamOptions = {}): Promise<Socket> {
  if (proxy.kind === 'socks4' && isIP(address) !== 4) throw new UpstreamFailure('address', 'unreachable')
  if (proxy.kind === 'socks5') return await viaSocks5(proxy, address, port, signal, options)
  if (proxy.kind === 'socks4') return await viaSocks4(proxy, address, port, signal, options)
  return await tunnel(await dialProxy(proxy, signal, options), address, port, signal, options.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
}

/** A stream straight to `address:port`, paused, for a connection the system sends outside any proxy. */
export async function connectDirect (address: string, port: number, signal: AbortSignal, options: UpstreamOptions = {}): Promise<Socket> {
  return await readied(netConnect({ host: address, port }), 'connect', signal, options.timeoutMs ?? UPSTREAM_TIMEOUT_MS, 'address')
}
