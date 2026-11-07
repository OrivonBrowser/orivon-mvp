// A name the verifier serves (`.eth`, and every other host a protocol serves) reaches the verifier on this computer through
// Chromium's resolver rules, but a session that follows the system's proxy asks that proxy first, and a proxy that carries
// the request learns the name and can answer it with a page of its own. No setting of a session in system mode can exempt the
// names, so a request for one is cancelled before it is sent when its session would use a proxy or cannot say which, and
// always when it asks for plain `http:` or `ws:`, whose proxy answer is given for the whole URL and cannot be trusted. Pure
// over the facts it is handed: no `electron` import.

import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { loadRefusals } from './load-refusals.js'
import { proxyAnswerFor, proxyEpoch, proxySetInFlight, proxySetOverran, proxySettled } from './proxy-answers.js'
import type { ProxyResolver } from './proxy-answers.js'

/** What the sheet over a tab and the error of a request made by Orivon itself say when the session's proxy would carry the name. */
export const PROXY_WOULD_SEE_NAME = 'Your system proxy would see this name, so Orivon did not open it.'
/** The same when the session did not say which proxy it would use in time. */
export const PROXY_NOT_KNOWN = 'Orivon could not tell whether your system proxy would see this name, so it did not open it.'
/** The same for a name asked for over plain `http:` or `ws:`. */
export const PLAIN_NAME_REFUSED = 'A name like this opens only over a secure connection, so Orivon did not open it over plain http.'
/** What the sheet adds for the first two: when the name opens. */
export const PROXY_REFUSAL_ADVICE = 'Names like this open when your system has no proxy, when the proxy\'s exceptions list names like *.eth, or with a tunnel turned on.'

/** Why a request for a name the verifier serves was cancelled; each kind is a `LoadRefusal` too. */
export type NameRefusal =
  | { readonly kind: 'would-see', readonly answer: string }
  | { readonly kind: 'unsure' }
  | { readonly kind: 'plain' }

/** The words of an error Orivon's own request fails with. */
function refusalWords (refusal: NameRefusal): string {
  return refusal.kind === 'would-see' ? PROXY_WOULD_SEE_NAME : refusal.kind === 'unsure' ? PROXY_NOT_KNOWN : PLAIN_NAME_REFUSED
}

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

/** Whether `url` asks over plain `http:` or `ws:` for a host `allowsPlain` does not name: the verifier answers TLS only, and a PAC script is shown the whole URL of such a request, which the question asked beforehand cannot repeat. */
export function refusesPlain (url: string, allowsPlain: (host: string) => boolean = isDevEthName): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && !allowsPlain(parsed.hostname.replace(/\.$/, ''))
  } catch {
    return false
  }
}

/** Whether a proxy would be asked to carry the request: any answer but exactly `DIRECT` (a list that falls back to `DIRECT` after a proxy still asks the proxy first). */
export function proxyWouldCarry (answer: string): boolean {
  return answer.trim() !== 'DIRECT'
}

/** The part of a request's answer the guard reads and sets; Electron's `CallbackResponse` has the same two fields. */
export interface GuardResponse {
  readonly cancel?: boolean
  readonly redirectURL?: string
}

/** What a handler on one session needs. */
export interface VerifierNameGuard {
  /** Whether the session follows the system's proxy: one pointed at a tunnel's front or held shut is not the system's to answer for. */
  readonly followsSystem: () => boolean
  readonly ask: (url: string) => Promise<string>
  /** Resolves when no change of the session's proxy is under way, and rejects when one still is after the time allowed. Nothing to wait for when left out. */
  readonly settled?: () => Promise<void>
  /** Moves whenever the session's proxy begins or ends being set; an answer asked across a move is asked again. */
  readonly epoch?: () => number
  /** The hosts that may be asked for over plain `http:` or `ws:`: this run's developer names when left out. */
  readonly allowsPlain?: (host: string) => boolean
  readonly note?: (url: string, refusal: NameRefusal) => void
}

/** Times a question is asked again because the session's proxy was set meanwhile, before the request counts as one that cannot be told. */
const MOST_ASKS = 3

/** Why `url` must not be sent in this session, or undefined when it may. Anything that cannot be found out counts as a refusal. */
async function refusalFor (guard: VerifierNameGuard, url: string): Promise<NameRefusal | undefined> {
  for (let asked = 0; asked < MOST_ASKS; asked += 1) {
    await guard.settled?.()
    const epoch = guard.epoch?.()
    if (!guard.followsSystem()) return undefined
    if (refusesPlain(url, guard.allowsPlain)) return { kind: 'plain' }
    const answer = await guard.ask(url)
    if (guard.epoch?.() === epoch) return proxyWouldCarry(answer) ? { kind: 'would-see', answer } : undefined
  }
  return { kind: 'unsure' }
}

const UNSURE: NameRefusal = { kind: 'unsure' }

/** At most one line a minute of each kind for the log, counting the ones it left out, so a page with many subresources cannot fill the ring. */
export function createRefusalNotes (options: { now?: () => number, everyMs?: number } = {}): (url: string, refusal: NameRefusal) => string | undefined {
  const now = options.now ?? Date.now
  const everyMs = options.everyMs ?? 60_000
  const said = new Map<NameRefusal['kind'], { lastAt: number, unsaid: number }>()
  return (url, refusal) => {
    const at = now()
    const earlier = said.get(refusal.kind) ?? { lastAt: Number.NEGATIVE_INFINITY, unsaid: 0 }
    said.set(refusal.kind, earlier)
    if (at - earlier.lastAt < everyMs) {
      earlier.unsaid += 1
      return undefined
    }
    earlier.lastAt = at
    const more = earlier.unsaid
    earlier.unsaid = 0
    let suffix = ''
    try {
      suffix = new URL(url).hostname.replace(/\.$/, '').split('.').pop() ?? ''
    } catch {
      // A URL that does not parse names no suffix; the line says so by leaving it out.
    }
    // The name itself stays out of the line: a report carries the log, and the proxy's own address is the person's.
    const what = refusal.kind === 'plain' ? 'plain request' : 'request'
    const why = refusal.kind === 'would-see'
      ? `its proxy (${refusal.answer.trim().split(/[\s;]/)[0] ?? ''}) would have carried it, and so seen the name`
      : refusal.kind === 'unsure' ? 'it could not be told whether its proxy would carry it' : 'these names open over https only'
    return `[route] refused a ${what} for a .${suffix} name: ${why}${more > 0 ? `; ${String(more)} more since the last line` : ''}`
  }
}

const noteInTheLog = createRefusalNotes()

/** Writes the refusal where a bug report reads it. */
export function noteRefusal (url: string, refusal: NameRefusal): void {
  const line = noteInTheLog(url, refusal)
  if (line !== undefined) console.warn(line)
}

/** The `onBeforeRequest` handler of a session: cancels a request for a name the verifier serves when it asks over plain `http:` or `ws:` or the session's proxy would carry it or cannot be told, and remembers a main-frame load it cancelled so the sheet can say why. Whatever goes wrong while deciding cancels. */
export function verifierNameGuard (guard: VerifierNameGuard): (details: { readonly url: string, readonly resourceType: string, readonly webContentsId?: number | undefined }, current: GuardResponse) => Promise<GuardResponse> {
  const note = guard.note ?? noteRefusal
  return async (details, current) => {
    const refusal = await refusalFor(guard, details.url).catch((): NameRefusal => UNSURE)
    if (refusal === undefined) return current
    try {
      if (details.resourceType === 'mainFrame') loadRefusals.note(details.webContentsId, details.url, refusal.kind)
      note(details.url, refusal)
    } catch {
      // Saying why must not let the request out.
    }
    return { cancel: true }
  }
}

/** What the guard of the session `target` needs, over how the controller says a session leaves (`RouteController.tunnelOf`). */
export function guardOfSession (target: ProxyResolver, tunnelOf: (session: object) => unknown, allowsPlain?: (host: string) => boolean): VerifierNameGuard {
  return {
    // A session whose proxy is being set, or was set by a call that outlasted the wait for it, is not the controller's to describe: the tunnel it records for it may not be the one the session has.
    followsSystem: () => proxySetInFlight(target) || proxySetOverran(target) || tunnelOf(target) === undefined,
    settled: async () => { await proxySettled(target) },
    epoch: () => proxyEpoch(target),
    ask: async (url) => await proxyAnswerFor(target, url),
    ...(allowsPlain === undefined ? {} : { allowsPlain })
  }
}

/** Throws when a request Orivon itself makes in `target` for a name the verifier serves would go to a proxy, cannot be told to, or asks for plain `http:`. */
export async function refuseWhenProxySees (target: ProxyResolver, url: string, allowsPlain?: (host: string) => boolean): Promise<void> {
  if (!namesVerifierHost(url)) return
  const refusal = await refusalFor(guardOfSession(target, () => undefined, allowsPlain), url).catch((): NameRefusal => UNSURE)
  if (refusal === undefined) return
  noteRefusal(url, refusal)
  throw new Error(refusalWords(refusal))
}

/** `send`, refused first when the request names a host the verifier serves and `target`'s proxy would carry it. */
export function refusingProxiedNames (target: ProxyResolver, send: (url: string, init?: RequestInit) => Promise<Response>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    await refuseWhenProxySees(target, url)
    return await send(url, init)
  }
}
