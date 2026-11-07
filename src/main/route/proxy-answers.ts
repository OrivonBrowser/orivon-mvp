// Which proxy a session would use for a URL, asked of the session's own network context and remembered for a few seconds.
// The answer is good only for the proxy setting it was asked under, so setting a session's proxy forgets every answer it
// gave. Pure over the session it is handed: no `electron` import.

/** The part of a session this needs. */
export interface ProxyResolver {
  readonly resolveProxy: (url: string) => Promise<string>
}

/** How long an answer is kept when nothing sets the session's proxy: the system's own proxy can change while Orivon runs, and nothing tells it so. */
export const PROXY_ANSWER_TTL_MS = 3_000
/** How long a session may take to say which proxy it would use: a script that stalls must not hold a request for ever, and a request that was not answered is not sent. */
export const PROXY_ASK_TIMEOUT_MS = 2_000
/** A page can ask for as many hosts as it likes; the oldest answers go first. */
const MOST_KEPT = 128

const epochs = new WeakMap<object, number>()

/** `target` is about to have its proxy set, or just did: whatever it answered before no longer stands. */
export function noteProxySet (target: object): void {
  epochs.set(target, (epochs.get(target) ?? 0) + 1)
}

/** `work`, or a rejection once `ms` have passed. */
async function within (work: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the session did not say which proxy it would use')) }, ms) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

interface Remembered {
  readonly epoch: number
  readonly at: number
  readonly answer: Promise<string>
}

/** Answers `resolve` gives, kept per host and scheme for `ttlMs`, and dropped when `epoch()` moves; callers that ask while an answer is on its way share it. */
export function createProxyAnswers (options: { resolve: (url: string) => Promise<string>, epoch: () => number, now?: () => number, ttlMs?: number, askTimeoutMs?: number }): (url: string) => Promise<string> {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? PROXY_ANSWER_TTL_MS
  const askTimeoutMs = options.askTimeoutMs ?? PROXY_ASK_TIMEOUT_MS
  const kept = new Map<string, Remembered>()
  return async (url) => {
    const target = new URL(url)
    // A proxy rule is by host; a PAC file could look at the path, and none that decides on a name's behalf is known.
    const key = `${target.protocol}//${target.host}`
    const epoch = options.epoch()
    const earlier = kept.get(key)
    if (earlier !== undefined && earlier.epoch === epoch && now() - earlier.at < ttlMs) return await earlier.answer
    const answer = within(options.resolve(`${key}/`), askTimeoutMs)
    const entry: Remembered = { epoch, at: now(), answer }
    kept.delete(key)
    kept.set(key, entry)
    while (kept.size > MOST_KEPT) kept.delete(kept.keys().next().value as string)
    // An answer that failed is not kept: the next request asks again.
    answer.catch(() => { if (kept.get(key) === entry) kept.delete(key) })
    return await answer
  }
}

const bySession = new WeakMap<object, (url: string) => Promise<string>>()

/** The proxy `session` would use for `url`, from the one set of remembered answers the session has. */
export async function proxyAnswerFor (session: ProxyResolver, url: string): Promise<string> {
  let answers = bySession.get(session)
  if (answers === undefined) {
    answers = createProxyAnswers({ resolve: async (target) => await session.resolveProxy(target), epoch: () => epochs.get(session) ?? 0 })
    bySession.set(session, answers)
  }
  return await answers(url)
}
