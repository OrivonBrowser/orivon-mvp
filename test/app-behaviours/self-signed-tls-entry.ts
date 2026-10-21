// Bundled against the shim by ./e2e-app-self-signed-tls.test.ts into a fixture page's script: the three ways an
// app reaches a server whose certificate no root vouches for. The raw `orivon.net.connectSecure`, Node's `tls.connect`
// (the shim over the same call), and the page's own `fetch`, which has no TLS option to pass. Each answers with plain
// data, so the test reads what happened. The test calls these functions from outside the page.

import tls from 'tls'

export interface Handshake {
  readonly ok: boolean
  /** The bytes the server sent after the handshake. */
  readonly text?: string
  readonly authorized?: boolean
  readonly authorizationError?: string
  readonly code?: string
  readonly platformCode?: string
  readonly message?: string
}

export interface Fetched {
  readonly ok: boolean
  readonly status?: number
  readonly text?: string
  readonly name?: string
  readonly message?: string
}

interface SecureSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly authorized: boolean
  readonly authorizationError?: string
  close: () => Promise<void>
}

const TIMEOUT_MS = 10_000

function withTimeout<T> (work: Promise<T>): Promise<T> {
  const timer = new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error('no answer in 10 s')) }, TIMEOUT_MS) })
  return Promise.race([work, timer])
}

/** `orivon.net.connectSecure` to `localhost:port`, with `rejectUnauthorized` as given (left out when undefined). */
async function raw (port: number, rejectUnauthorized?: boolean): Promise<Handshake> {
  const orivon = (globalThis as unknown as { orivon: { net: { connectSecure: (o: { host: string, port: number, rejectUnauthorized?: boolean }) => Promise<SecureSocket> } } }).orivon
  try {
    return await withTimeout((async () => {
      const socket = await orivon.net.connectSecure({ host: 'localhost', port, ...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }) })
      try {
        const reader = socket.readable.getReader()
        let text = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          text += new TextDecoder().decode(value)
        }
        return { ok: true, text, authorized: socket.authorized, ...(socket.authorizationError === undefined ? {} : { authorizationError: socket.authorizationError }) }
      } finally {
        await socket.close().catch(() => {})
      }
    })())
  } catch (error) {
    const { code, platformCode, message } = error as { code?: string, platformCode?: string, message?: string }
    return { ok: false, ...(code === undefined ? {} : { code }), ...(platformCode === undefined ? {} : { platformCode }), message: String(message ?? error) }
  }
}

/** Node's `tls.connect({ host: 'localhost', port, rejectUnauthorized })`, as a ported client writes it. */
async function node (port: number, rejectUnauthorized?: boolean): Promise<Handshake> {
  return await withTimeout(new Promise<Handshake>((resolve) => {
    const socket = tls.connect({ host: 'localhost', port, ...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }) })
    let text = ''
    let secure = false
    socket.setEncoding('utf8')
    socket.on('secureConnect', () => { secure = true })
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('end', () => {
      resolve({ ok: secure, text, authorized: socket.authorized, ...(typeof socket.authorizationError === 'string' ? { authorizationError: socket.authorizationError } : {}) })
      socket.destroy()
    })
    socket.on('error', (error: Error & { code?: string }) => {
      resolve({ ok: false, ...(error.code === undefined ? {} : { code: error.code }), message: error.message })
      socket.destroy()
    })
  })).catch((error: unknown) => ({ ok: false, message: String((error as Error)?.message ?? error) }))
}

/** The page's `fetch`. `init` is passed through as given, so a Node-style `rejectUnauthorized` can be tried and seen to do nothing. */
async function routedFetch (url: string, init?: Record<string, unknown>): Promise<Fetched> {
  try {
    return await withTimeout((async () => {
      const response = await fetch(url, init as RequestInit | undefined)
      return { ok: true, status: response.status, text: await response.text() }
    })())
  } catch (error) {
    const { name, message } = error as { name?: string, message?: string }
    return { ok: false, ...(name === undefined ? {} : { name }), message: String(message ?? error) }
  }
}

;(globalThis as unknown as { selfSignedTlsE2e: unknown }).selfSignedTlsE2e = { raw, node, routedFetch }
