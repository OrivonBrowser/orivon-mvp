// How a report reaches the server and what its answer means. The wire format is the server's; this only posts
// one JSON body to one of two addresses and reads the status of the reply, never its body. `fetch` comes in as
// an argument, so the decisions are tested without a network.
import { endpointUrl } from '../../telemetry/mode.js'
import { wireBody } from './report-payload.js'
import type { ReportPayload } from './report-payload.js'

/** A report may carry a dump of several megabytes over a slow link, so it waits longer than a usage report does. */
export const REPORT_TIMEOUT_MS = 60_000

export type Post = (url: string, body: string, timeoutMs: number) => Promise<{ readonly status: number }>

/** Why a send failed, in the terms the form tells the person. */
export type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false, readonly why: 'offline' | 'too-large' | 'too-many' | 'server-full' | 'dump-store-full' | 'rejected' }

export function outcomeOfStatus (status: number): SendOutcome {
  if (status === 204) return { ok: true }
  if (status === 413) return { ok: false, why: 'too-large' }
  if (status === 429) return { ok: false, why: 'too-many' }
  if (status === 503) return { ok: false, why: 'server-full' }
  if (status === 507) return { ok: false, why: 'dump-store-full' }
  return { ok: false, why: 'rejected' }
}

/** What the form says for each failure; "rejected" is a report the server called malformed, which no retry fixes. */
export const FAILURE_TEXT: Readonly<Record<Exclude<SendOutcome, { ok: true }>['why'], string>> = {
  offline: 'Could not reach the server. Check the connection and press Send again; nothing was lost.',
  'too-large': 'The report is too large. Try again without the crash dump or the recent log.',
  'too-many': 'Too many reports from this connection just now. Try again later.',
  'server-full': 'The server cannot take more reports today. Try again tomorrow.',
  'dump-store-full': 'The server has no room for a crash dump. Try again without it.',
  rejected: 'The server did not accept this report. Copy it as text instead and attach it to a GitHub issue.'
}

async function postBody (send: Post, url: string, body: string): Promise<SendOutcome> {
  try {
    return outcomeOfStatus((await send(url, body, REPORT_TIMEOUT_MS)).status)
  } catch {
    return { ok: false, why: 'offline' }
  }
}

export async function sendReport (send: Post, base: string, payload: ReportPayload): Promise<SendOutcome> {
  return await postBody(send, endpointUrl(base, 'report'), wireBody(payload))
}

/** Asks the server to delete a report. Any 204 is done, whether it held the report or not. */
export async function eraseReport (send: Post, base: string, reportId: string): Promise<boolean> {
  return (await postBody(send, endpointUrl(base, 'report-erase'), JSON.stringify({ schema: 1, reportId }))).ok
}
