// A name the verifier serves (`.eth`, and every other host a protocol serves) reaches the verifier on this computer through
// Chromium's resolver rules, but a session that follows the system's proxy asks that proxy first, and a proxy that carries
// the request learns the name and can answer it with a page of its own. No setting of a session in system mode can exempt the
// names, so a request for one is cancelled before it is sent when its session would use a proxy. Pure over the facts it is
// handed: no `electron` import.

import type { CallbackResponse } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { proxyAnswerFor } from './proxy-answers.js'
import type { ProxyResolver } from './proxy-answers.js'
import { createOnionRefusals } from './onion-guard.js'
import type { OnionRefusals } from './onion-guard.js'

/** What the sheet over a tab and the error of a request made by Orivon itself both say. */
export const PROXY_WOULD_SEE_NAME = 'Your system proxy would see this name, so Orivon did not open it.'
/** What the sheet adds: when the name opens. */
export const PROXY_REFUSAL_ADVICE = 'Names like this open when your system has no proxy, or with a tunnel turned on.'

/** Every scheme a request that can go to a proxy can use. */
const SCHEMES = ['http', 'https', 'ws', 'wss']

/** Electron's own `{ urls }` filter: each protocol suffix under every scheme, with and without the root dot, which is a host of its own to a match pattern. */
export function verifierNameFilter (): { readonly urls: string[] } {
  return { urls: BUILTIN_ADDRESSES.routedSuffixes().flatMap((suffix) => SCHEMES.flatMap((scheme) => [`${scheme}://*.${suffix}/*`, `${scheme}://*.${suffix}./*`])) }
}

/** Whether `url` names a host under a suffix the resolver rules send to the verifier (`MAP *.suffix`), written with or without the root dot; any spelling those rules match, an empty label included. */
export function namesVerifierHost (url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/\.$/, '')
    return BUILTIN_ADDRESSES.routedSuffixes().some((suffix) => host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

/** Whether a proxy would be asked to carry the request: any answer but exactly `DIRECT` (a list that falls back to `DIRECT` after a proxy still asks the proxy first). */
export function proxyWouldCarry (answer: string): boolean {
  return answer.trim() !== 'DIRECT'
}

/** The proxy `ask` names for `url`, or undefined when it cannot be asked, which counts as a proxy: a request is not sent on a guess. */
async function askProxy (ask: (url: string) => Promise<string>, url: string): Promise<string | undefined> {
  try {
    return await ask(url)
  } catch {
    return undefined
  }
}

/** The refusals of main-frame loads, read by the sheet over the tab to say why. */
export const proxyRefusals: OnionRefusals = createOnionRefusals()

/** At most one line a minute for the log, counting the ones it left out, so a page with many subresources cannot fill the ring. */
export function createRefusalNotes (options: { now?: () => number, everyMs?: number } = {}): (url: string, answer: string | undefined) => string | undefined {
  const now = options.now ?? Date.now
  const everyMs = options.everyMs ?? 60_000
  let lastAt = Number.NEGATIVE_INFINITY
  let unsaid = 0
  return (url, answer) => {
    const at = now()
    if (at - lastAt < everyMs) {
      unsaid += 1
      return undefined
    }
    lastAt = at
    const more = unsaid
    unsaid = 0
    let suffix = ''
    try {
      suffix = new URL(url).hostname.replace(/\.$/, '').split('.').pop() ?? ''
    } catch {
      // A URL that does not parse names no suffix; the line says so by leaving it out.
    }
    // The name itself stays out of the line: a report carries the log, and the proxy's own address is the person's.
    const via = answer === undefined ? 'its proxy could not be asked' : `its proxy (${answer.trim().split(/[\s;]/)[0] ?? ''}) would have carried it`
    return `[route] refused a request for a .${suffix} name: ${via}, and so seen the name${more > 0 ? `; ${String(more)} more since the last line` : ''}`
  }
}

const noteInTheLog = createRefusalNotes()

/** Writes the refusal where a bug report reads it. */
export function noteRefusal (url: string, answer: string | undefined): void {
  const line = noteInTheLog(url, answer)
  if (line !== undefined) console.warn(line)
}

/** What a handler on one session needs. */
export interface VerifierNameGuard {
  /** Whether the session follows the system's proxy: one pointed at a tunnel's front or held shut is not the system's to answer for. */
  readonly followsSystem: () => boolean
  readonly ask: (url: string) => Promise<string>
  readonly note?: (url: string, answer: string | undefined) => void
}

/** The `onBeforeRequest` handler of a session: cancels a request for a name the verifier serves when the session's proxy would carry it, and remembers a main-frame load it cancelled so the sheet can say why. */
export function verifierNameGuard (guard: VerifierNameGuard): (details: { readonly url: string, readonly resourceType: string, readonly webContentsId?: number | undefined }, current: CallbackResponse) => Promise<CallbackResponse> {
  const note = guard.note ?? noteRefusal
  return async (details, current) => {
    if (!guard.followsSystem()) return current
    const answer = await askProxy(guard.ask, details.url)
    if (answer !== undefined && !proxyWouldCarry(answer)) return current
    if (details.resourceType === 'mainFrame') proxyRefusals.note(details.webContentsId, details.url)
    note(details.url, answer)
    return { cancel: true }
  }
}

/** Throws when a request Orivon itself makes in `target` for a name the verifier serves would go to a proxy. */
export async function refuseWhenProxySees (target: ProxyResolver, url: string): Promise<void> {
  if (!namesVerifierHost(url)) return
  const answer = await askProxy(async (asked) => await proxyAnswerFor(target, asked), url)
  if (answer !== undefined && !proxyWouldCarry(answer)) return
  noteRefusal(url, answer)
  throw new Error(PROXY_WOULD_SEE_NAME)
}

/** `send`, refused first when the request names a host the verifier serves and `target`'s proxy would carry it. */
export function refusingProxiedNames (target: ProxyResolver, send: (url: string, init?: RequestInit) => Promise<Response>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    await refuseWhenProxySees(target, url)
    return await send(url, init)
  }
}
