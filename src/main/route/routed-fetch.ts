// A GET made by the main process through an app's route, answered as a `Response`. `Session.fetch` cannot be used for it:
// the application's `login` event is not raised for a request without web contents, so the front's proxy challenge
// would end the request as a 407. `net.request` takes a `login` listener of its own (`createRequestFetch`).
// Electron-free: the caller hands in `net`.

import type { Net, Session } from 'electron'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { asOwnRead } from '../../loader/fetch/own-read.js'
import { answerRouteChallenge } from './lookup-session.js'

/**
 * Rejects with the signal's reason when it fires, and with the request's error when it fails. A read of a host the verifier
 * serves carries the mark of the shell's own reads, as every other read the main process makes of such a host does: it must
 * not be handed to the handler of an app served at that name.
 */
export async function fetchThroughRoute (net: Pick<Net, 'request'>, session: Session, url: string, signal: AbortSignal): Promise<Response> {
  return await createRequestFetch({ net, session, answer: answerRouteChallenge })(url, { signal, headers: asOwnRead(url) })
}
