// The `fetch` of Orivon's own requests that leave on the system's proxy (a website set to off while the whole browser is on the
// tunnel, the lookups about one): made in the session that follows the system as the controller sets it, and refused first for a name
// the verifier serves that this session's proxy would carry.

import type { Net, Session } from 'electron'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { refusingProxiedNames } from './verifier-name-guard.js'

/** A proxy's challenge is cancelled: the system's proxy is not one Orivon signs in to. */
export function createDirectFetch (net: Pick<Net, 'request'>, systemSession: Session): (url: string, init?: RequestInit) => Promise<Response> {
  return refusingProxiedNames(systemSession, createRequestFetch({ net, session: systemSession, answer: (_info, callback) => { callback() } }))
}
