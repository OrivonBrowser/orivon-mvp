// Which proxy a session would use for a URL, asked of the session's own network context. An answer is shared only by asks
// that overlap and never kept: a PAC script, the network and the system's own settings can answer differently the next time.
// The answer stands only for the proxy setting it was asked under, so a change of a session's proxy is tracked here: a
// caller waits for one under way (`proxySettled`) before it asks, and an ask that spanned one is asked again. Pure over the
// session it is handed: no `electron` import.

import { within } from './within.js'

/** The part of a session this needs. */
export interface ProxyResolver {
  readonly resolveProxy: (url: string) => Promise<string>
}

/**
 * How long a session may take to say which proxy it would use. Automatic detection and a PAC script answer the first
 * question after a start or a change of network slowly, while the system tries one place after another for the script, and
 * a request that waits is not sent: the wait costs a page its load time and nothing else.
 */
export const PROXY_ASK_TIMEOUT_MS = 15_000
/** How long a request waits for a change of its session's proxy to end before it asks which proxy applies. */
export const PROXY_SETTLE_MS = 10_000

const epochs = new WeakMap<object, number>()

/** Moves whenever `target`'s proxy begins to be set or has just been set: an answer asked under another epoch stands for another setting. */
export function proxyEpoch (target: object): number {
  return epochs.get(target) ?? 0
}

/** `target` is about to have its proxy set, or just did: whatever it answered before no longer stands. */
export function noteProxySet (target: object): void {
  epochs.set(target, proxyEpoch(target) + 1)
}

interface Setting {
  inFlight: number
  /** The last change took longer than the caller waits for it, or still does. */
  overran: boolean
  settled: Promise<void>
  release: () => void
}

const settings = new WeakMap<object, Setting>()

function settingOf (target: object): Setting {
  let setting = settings.get(target)
  if (setting === undefined) {
    setting = { inFlight: 0, overran: false, settled: Promise.resolve(), release: () => {} }
    settings.set(target, setting)
  }
  return setting
}

/**
 * Runs `work`, a change of `target`'s proxy, and tracks it: answers asked before and across it are forgotten, `proxySetInFlight`
 * is true until the call itself ends (not when whoever waits for it gives up), and a call that outlasts `overranMs` leaves
 * `proxySetOverran` true until a later one is quick, because whoever gave up on it no longer knows which proxy the session has.
 */
export async function trackProxySet<T> (target: object, work: () => Promise<T>, overranMs = PROXY_SETTLE_MS): Promise<T> {
  const setting = settingOf(target)
  noteProxySet(target)
  if (setting.inFlight === 0) setting.settled = new Promise<void>((resolve) => { setting.release = resolve })
  setting.inFlight += 1
  let late = false
  const timer = setTimeout(() => { late = true; setting.overran = true }, overranMs)
  try {
    return await work()
  } finally {
    clearTimeout(timer)
    if (!late && setting.inFlight === 1) setting.overran = false
    setting.inFlight -= 1
    noteProxySet(target)
    if (setting.inFlight === 0) setting.release()
  }
}

/** Whether a change of `target`'s proxy has begun and not ended: the session may be on the old setting, the new one or neither. */
export function proxySetInFlight (target: object): boolean {
  return (settings.get(target)?.inFlight ?? 0) > 0
}

/** Whether the last change of `target`'s proxy took longer than whoever applied it waited, so what it recorded about the session may be wrong. */
export function proxySetOverran (target: object): boolean {
  return settings.get(target)?.overran === true
}

/** Resolves when no change of `target`'s proxy is under way, and rejects when one still is after `ms`. */
export async function proxySettled (target: object, ms = PROXY_SETTLE_MS): Promise<void> {
  const setting = settings.get(target)
  if (setting === undefined || setting.inFlight === 0) return
  await within(setting.settled, ms, 'the session\'s proxy was still being set')
}

/** Answers `resolve` gives, dropped when `epoch()` moves; callers that ask while an answer is on its way share it, and nothing is kept once it has come. */
export function createProxyAnswers (options: { resolve: (url: string) => Promise<string>, epoch: () => number, askTimeoutMs?: number }): (url: string) => Promise<string> {
  const askTimeoutMs = options.askTimeoutMs ?? PROXY_ASK_TIMEOUT_MS
  const asking = new Map<string, { readonly epoch: number, readonly answer: Promise<string> }>()
  return async (url) => {
    const target = new URL(url)
    // A proxy rule is by host. A PAC script for `https:` and `wss:` is shown no path, so the host is all that can differ; for `http:` and `ws:` it is shown the whole URL, which is why those are not asked about (`verifier-name-guard.ts`).
    const key = `${target.protocol}//${target.host}`
    const epoch = options.epoch()
    const earlier = asking.get(key)
    if (earlier !== undefined && earlier.epoch === epoch) return await earlier.answer
    const answer = within(options.resolve(`${key}/`), askTimeoutMs, 'the session did not say which proxy it would use')
    const entry = { epoch, answer }
    asking.set(key, entry)
    const done = (): void => { if (asking.get(key) === entry) asking.delete(key) }
    answer.then(done, done)
    return await answer
  }
}

const bySession = new WeakMap<object, (url: string) => Promise<string>>()

/** The proxy `session` would use for `url`, from the one set of asks under way the session has. */
export async function proxyAnswerFor (session: ProxyResolver, url: string): Promise<string> {
  let answers = bySession.get(session)
  if (answers === undefined) {
    answers = createProxyAnswers({ resolve: async (target) => await session.resolveProxy(target), epoch: () => proxyEpoch(session) })
    bySession.set(session, answers)
  }
  return await answers(url)
}
