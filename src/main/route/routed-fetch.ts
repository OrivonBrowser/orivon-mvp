// A GET made by the main process through an app's route, answered as a `Response`. `Session.fetch` cannot be used for it:
// the application's `login` event is not raised for a request without web contents, so the front's proxy challenge
// would end the request as a 407. `net.request` takes a `login` listener of its own. Electron-free: the caller hands in `net`.

import { Readable } from 'node:stream'
import type { Net, Session } from 'electron'
import { answerRouteChallenge } from './lookup-session.js'

/** Rejects with the signal's reason when it fires, and with the request's error when it fails. */
export async function fetchThroughRoute (net: Pick<Net, 'request'>, session: Session, url: string, signal: AbortSignal): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const request = net.request({ url, method: 'GET', session, credentials: 'omit', useSessionCookies: false })
    const onAbort = (): void => {
      reject(signal.reason)
      request.abort()
    }
    request.on('login', (info, callback) => { answerRouteChallenge(info, callback) })
    request.on('response', (response) => {
      // The signal covers the body too: a stalled body is cut off when it fires.
      signal.removeEventListener('abort', onAbort)
      const cutOff = (): void => { response.destroy(signal.reason as Error) }
      signal.addEventListener('abort', cutOff, { once: true })
      response.once('close', () => { signal.removeEventListener('abort', cutOff) })
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
      const body = Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>
      resolve(new Response(response.statusCode === 204 || response.statusCode === 304 ? null : body, { status: response.statusCode, headers }))
    })
    request.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}
