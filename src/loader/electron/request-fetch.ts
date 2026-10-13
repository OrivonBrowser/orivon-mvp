// A `fetch` made with Electron's `net.request`, for a request that must sign in to a loopback proxy front itself.
// `net.fetch` and `Session.fetch` raise no `login` event for the application when there is no web contents (the main
// process, a utility process), so a front's `407` would end the request; `net.request` takes a `login` listener of its own.
// Electron-free over the `net` it is handed.

import { Readable } from 'node:stream'
import type { Net, Session } from 'electron'

/** The proxy challenge `net.request` raises, as far as this needs it. */
export interface ProxyChallenge {
  readonly isProxy: boolean
  readonly host: string
  readonly port: number
}

export type AnswerChallenge = (info: ProxyChallenge, callback: (username?: string, password?: string) => void) => void

export interface RequestFetchOptions {
  readonly net: Pick<Net, 'request'>
  /** The session the request is made in; none means the process's own network context (a utility process has no session). */
  readonly session?: Session
  /** Answers the proxy's challenge, or cancels it by calling back with nothing. */
  readonly answer: AnswerChallenge
  /** `include` sends and keeps the session's cookies, as `Session.fetch` did for the Reader's pictures; the default sends none. */
  readonly credentials?: 'omit' | 'include'
}

/** Headers a request cannot carry itself: the network stack sets them. */
const NOT_SET = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization'])

function bodyBytes (body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('a request made through the tunnel carries a string or bytes as its body')
}

/** Every header the call asked for, by lower-cased name, less the ones the stack sets. */
function headersOf (init: HeadersInit | undefined): Array<[string, string]> {
  if (init === undefined) return []
  return [...new Headers(init)].filter(([name]) => !NOT_SET.has(name))
}

/**
 * A `fetch` that rejects with the signal's reason when it fires (also while the body is read) and with the request's
 * own error when it fails. A `redirect: 'manual'` call answers the redirect as a response with its `location`, and
 * follows nothing.
 */
export function createRequestFetch (options: RequestFetchOptions): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const signal = init.signal ?? undefined
    const payload = bodyBytes(init.body)
    return await new Promise<Response>((resolve, reject) => {
      if (signal?.aborted === true) { reject(signal.reason); return }
      const redirect = init.redirect === 'manual' || init.redirect === 'error' ? init.redirect : 'follow'
      const request = options.net.request({
        url,
        method: init.method ?? 'GET',
        credentials: options.credentials ?? 'omit',
        useSessionCookies: options.credentials === 'include',
        redirect,
        ...(options.session === undefined ? {} : { session: options.session })
      })
      for (const [name, value] of headersOf(init.headers)) request.setHeader(name, value)
      // `net.request` has no cache option: a call that asked for `no-store` asks for revalidation, so no cached answer is faster than the network's.
      if (init.cache === 'no-store') request.setHeader('Cache-Control', 'no-cache')
      const onAbort = (): void => {
        reject(signal?.reason)
        request.abort()
      }
      request.on('login', (info, callback) => { options.answer(info, callback) })
      if (redirect === 'manual') {
        request.on('redirect', (status, _method, redirectUrl, headers) => {
          signal?.removeEventListener('abort', onAbort)
          const out = new Headers()
          for (const [name, value] of Object.entries(headers)) for (const one of Array.isArray(value) ? value : [value]) out.append(name, one)
          if (!out.has('location')) out.set('location', redirectUrl)
          resolve(new Response(null, { status, headers: out }))
          request.abort()
        })
      }
      request.on('response', (response) => {
        signal?.removeEventListener('abort', onAbort)
        const stream = response as unknown as Readable
        const cutOff = (): void => { stream.destroy(signal?.reason as Error) }
        signal?.addEventListener('abort', cutOff, { once: true })
        stream.once('close', () => { signal?.removeEventListener('abort', cutOff) })
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
        const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
        resolve(new Response(response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304 ? null : body, { status: response.statusCode, headers }))
      })
      request.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (payload !== undefined) request.write(Buffer.from(payload))
      request.end()
    })
  }
}
