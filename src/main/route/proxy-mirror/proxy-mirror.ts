// Copies the system's proxy settings into the config the route controller gives the sessions that follow the system, and keeps
// the copy true. It reads the settings every 30 seconds and asks Chromium's own answer (a session that stays on the system's config)
// every 2 seconds, which shows a proxy turned on, off or moved at once. A copy is applied only after a session of its own,
// set to it, answers the same as Chromium's session for the same addresses; when it does not, twice running, or when the settings
// cannot be read or carried, every session stays on `{ mode: 'system' }`, where the guard for the names the verifier serves decides.
// A copy already applied is kept through a read that fails or a check that gets no answer, while Chromium's base answers are what
// they were when the copy passed its check. A script the system names is fetched, wrapped and copied the same way. Electron-free
// over the calls it is handed.

import type { SystemProxyConfig } from '../system-follow.js'
import { within } from '../within.js'
import { BASE_CANARIES, exceptionCanaries } from './canaries.js'
import { mirroredConfig, mirroredScriptConfig } from './mirrored-config.js'
import type { MirrorReason, MirrorStatus } from './mirror-status.js'
import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** How often Chromium's own answer is asked, in process. Provisional: a proxy turned on is followed after about this long. */
export const ANSWER_EVERY_MS = 2_000
/** How often the settings are read. Provisional: an edit of the exceptions alone is followed after about this long. */
export const READ_EVERY_MS = 30_000
/** How long a change in Chromium's answers alone, with the settings the same, starts no read after one did. */
export const ANSWERS_QUIET_MS = 2 * READ_EVERY_MS
/** How long the first read and check may hold the start of the browser. */
export const START_BOUND_MS = 6_000
/** How long one question to a session, or one set of the check session, may take. */
const CALL_MS = 5_000
/** How long a fetched script is used before it is fetched again: Chromium notices an edit of a script at the same address very late, if ever. */
export const SCRIPT_EVERY_MS = 30 * 60_000
/** The least time between two fetches that a change in Chromium's answers, or a failed fetch, starts. */
export const SCRIPT_RECHECK_MS = 20_000
/** How long a fetch of the script may hold a pass. */
const SCRIPT_CALL_MS = 35_000

const SYSTEM: SystemProxyConfig = { mode: 'system' }

/** What a pass came to: the config the sessions should be set to, or that the copy applied stays as it is. */
type Decision = { readonly config: SystemProxyConfig, readonly reason: MirrorReason, readonly mode: MirrorStatus['mode'] } | 'kept'
/** How a copy answered against Chromium's own: the same, otherwise, or a question that got no answer. */
type Verdict = 'agrees' | 'differs' | 'unanswered'

export interface ProxyMirrorDeps {
  readonly source: SettingsSourceName
  /** Reads the settings, or undefined when this computer's cannot be read yet: the mirror then does nothing at all. Never rejects. */
  readonly read: (() => Promise<SystemSettings>) | undefined
  /** Nothing follows the system (a window held to a tunnel). */
  readonly held?: boolean
  /** The text of the proxy script at `url`, fetched direct; rejects when it cannot be. Without it, a script stays with the system. */
  readonly fetchScript?: (url: string) => Promise<string>
  /** Makes Chromium's own session read its settings and its script again, so that it answers for the script as it is now. */
  readonly reloadSystem?: () => Promise<void>
  /** Chromium's own answer for the address, from a session that stays on `{ mode: 'system' }`. */
  readonly systemAnswer: (url: string) => Promise<string>
  /** A session of the mirror's own: set to a config to try, then asked. */
  readonly check: { readonly set: (config: SystemProxyConfig) => Promise<void>, readonly answer: (url: string) => Promise<string> }
  /** `config()` has changed: every session that follows the system takes it. Resolves with whether every one did; the mirror calls it again on its next pass when one did not. */
  readonly apply: () => Promise<boolean>
  readonly log?: (line: string) => void
}

/** What a pass saw and decided, for whoever follows the mirror instead of reading the settings again. */
export interface MirrorPass {
  readonly status: MirrorStatus
  /** Chromium's own answer for each of `BASE_CANARIES`, in their order, as the pass asked it; `unanswered` for a question that got none. */
  readonly answers: readonly string[]
}

export interface ProxyMirror {
  /** What the sessions that follow the system are set to now; `{ mode: 'system' }` until a copy has been checked. */
  config: () => SystemProxyConfig
  status: () => MirrorStatus
  /** Calls `listener` at the end of every pass, including one that changed nothing, with what that pass saw. Returns the call that removes it. A listener that throws is skipped and the mirror goes on. */
  onPass: (listener: (pass: MirrorPass) => void) => () => void
  /** Reads once (bounded), then keeps reading. Resolves with nothing read at all when this computer's settings cannot be read yet. */
  start: () => Promise<void>
  /** Reads, checks and applies once; resolves when that ended. */
  refresh: () => Promise<void>
  stop: () => void
}

const STAY_REASON: Readonly<Record<Exclude<SystemSettings['kind'], 'manual' | 'script'>, MirrorReason>> = {
  none: 'no-proxy', detect: 'detect', unsupported: 'unsupported', unreadable: 'unreadable'
}

export function createProxyMirror (deps: ProxyMirrorDeps): ProxyMirror {
  const log = deps.log ?? ((line: string) => { console.info(line) })
  let applied: SystemProxyConfig = SYSTEM
  /** Whether every session took `applied`; when one did not, the next pass calls `apply` again. */
  let taken = true
  let status: MirrorStatus = { source: deps.source, mode: 'unknown', state: 'system', reason: deps.held === true ? 'held' : deps.read === undefined ? 'no-reader' : 'starting' }
  /** What the last pass looked at, so a pass that sees the same does nothing. */
  let lastInputs = ''
  let lastAnswers = ''
  /** The script the settings name, as last fetched. A failed fetch keeps the text for the same address. */
  let script: { readonly url: string, readonly text: string, readonly fetchedAt: number, readonly tried: number } | undefined
  /** Moves whenever the text of the script changes, so that the pass sees a new script as a new input. */
  let scriptVersion = 0
  /** The config made for the script as of `scriptVersion`: wrapping and encoding a megabyte takes about 160 ms of the main thread, and each attempt of each pass that is not settled asks for it. */
  let built: { readonly version: number, readonly config: SystemProxyConfig } | undefined
  /** Until then a change in Chromium's answers alone starts no read: a script that answers by the clock or at random changes them at every question, and each read of the settings spawns a process. */
  let answersQuietUntil = 0
  /** What the pass now running did with the script, so that it fetches and reloads once and not again for the same difference. */
  let passFetched = false
  let passReloaded = false
  const listeners = new Set<(pass: MirrorPass) => void>()
  let running: Promise<void> | undefined
  let queued = false
  let stopped = false
  let timers: Array<ReturnType<typeof setInterval>> = []

  const ask = async (question: (url: string) => Promise<string>, url: string): Promise<string | undefined> => {
    try {
      return (await within(question(url), CALL_MS, 'a session did not answer')).trim()
    } catch {
      return undefined
    }
  }

  async function sample (): Promise<string> {
    return (await Promise.all(BASE_CANARIES.map(async (url) => await ask(deps.systemAnswer, url) ?? 'unanswered'))).join('\n')
  }

  /** How a session set to `config` answers beside Chromium's own, for the base addresses and the ones the exceptions cover. A real difference outweighs a question that got no answer. */
  async function check (config: SystemProxyConfig, exceptions: readonly string[]): Promise<Verdict> {
    if (stopped) return 'unanswered'
    try {
      await within(deps.check.set(config), CALL_MS, 'the check session was not set')
    } catch {
      return 'unanswered'
    }
    const urls = [...BASE_CANARIES, ...exceptionCanaries(exceptions)]
    const pairs = await Promise.all(urls.map(async (url) => await Promise.all([ask(deps.systemAnswer, url), ask(deps.check.answer, url)])))
    if (pairs.some(([system, copy]) => system !== undefined && copy !== undefined && system !== copy)) return 'differs'
    return pairs.some(([system, copy]) => system === undefined || copy === undefined) ? 'unanswered' : 'agrees'
  }

  /**
   * What the sessions should be set to for `settings`. A copy that Chromium's answer does not match is tried once more after a fresh
   * read, since the settings may have changed between the read and the question. With `keepable` (a checked copy is applied and
   * Chromium's base answers have not moved), a read that failed or a check that got no answer decides nothing: the copy stays.
   */
  async function decide (settings: SystemSettings, read: () => Promise<SystemSettings>, keepable: boolean): Promise<Decision> {
    let current = settings
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) current = await read()
      if (current.kind === 'unreadable' && attempt === 0 && keepable) return 'kept'
      if (current.kind !== 'manual' && current.kind !== 'script') return { config: SYSTEM, reason: STAY_REASON[current.kind], mode: current.kind }
      // A difference that stays means Chromium's session may hold another text than the fetch did: it is made to read the script again.
      if (current.kind === 'script' && attempt === 1) {
        if (!passFetched && !passReloaded) await updateScript(current.url, true)
        if (!passReloaded) await reloadSystem()
      }
      const config = current.kind === 'manual' ? mirroredConfig(current) : scriptConfig(current.url)
      if (config === undefined) {
        if (current.kind === 'script') return { config: SYSTEM, reason: 'unfetched', mode: 'script' }
        continue
      }
      const verdict = await check(config, current.kind === 'manual' ? current.exceptions : [])
      if (verdict === 'agrees') return { config, reason: 'copied', mode: current.kind }
      if (verdict === 'unanswered' && attempt === 0 && keepable) return 'kept'
    }
    return { config: SYSTEM, reason: 'disagrees', mode: settings.kind === 'script' ? 'script' : 'manual' }
  }

  /** The config for the script fetched from `url`, or undefined when none was fetched. */
  function scriptConfig (url: string): SystemProxyConfig | undefined {
    if (script?.url !== url) return undefined
    if (built?.version !== scriptVersion) built = { version: scriptVersion, config: mirroredScriptConfig(script.text) }
    return built.config
  }

  /**
   * Fetches the script at `url` when it is due: for a new address, once its text is older than half an hour, when Chromium's answers
   * moved (an edit it noticed), when a fetch failed, or when `force` says so. A fetch that fails keeps the text for the same address.
   * When the text changed, Chromium's own session is made to read its script again, since it would not notice the edit for a long
   * time and the check would find the copy different. Resolves with whether it did.
   */
  async function updateScript (url: string, force: boolean, answersMoved = false): Promise<boolean> {
    const fetchScript = deps.fetchScript
    const held = script?.url === url ? script : undefined
    const now = Date.now()
    if (fetchScript === undefined) return false
    const due = held === undefined || force || now - held.fetchedAt >= SCRIPT_EVERY_MS || ((answersMoved || held.tried > held.fetchedAt) && now - held.tried >= SCRIPT_RECHECK_MS)
    if (!due) return false
    let text: string | undefined
    passFetched = true
    try {
      text = await within(fetchScript(url), SCRIPT_CALL_MS, 'the proxy script took too long')
    } catch {
      text = undefined
    }
    if (stopped) return false
    if (text === undefined) {
      script = held === undefined ? undefined : { ...held, tried: now }
      return false
    }
    script = { url, text, fetchedAt: now, tried: now }
    if (text === held?.text) return false
    scriptVersion += 1
    return held !== undefined && await reloadSystem()
  }

  /** Makes Chromium's own session read its script again. Resolves with whether it did. */
  async function reloadSystem (): Promise<boolean> {
    const reload = deps.reloadSystem
    if (reload === undefined || stopped) return false
    passReloaded = true
    try {
      await within(reload(), CALL_MS, 'Chromium did not read its script again')
      return true
    } catch {
      return false
    }
  }

  /** Has every session set to `applied`; false when one did not, or the call itself failed. */
  async function applyOnce (): Promise<boolean> {
    try {
      return await deps.apply()
    } catch (error) {
      console.error('[route] setting the sessions to the system proxy failed:', error instanceof Error ? error.message : 'unexpected error')
      return false
    }
  }

  /** Calls `apply` again for a config that not every session took. */
  async function retryApply (): Promise<void> {
    if (taken || stopped) return
    taken = await applyOnce()
  }

  /** One pass; resolves with the base answers it saw, or undefined when it did nothing. */
  async function pass (): Promise<string | undefined> {
    const read = deps.read
    if (read === undefined || stopped) return undefined
    passFetched = false
    passReloaded = false
    const settings = await read()
    let answers = await sample()
    if (settings.kind === 'script') {
      if (await updateScript(settings.url, false, answers !== lastAnswers)) answers = await sample()
    } else if (settings.kind !== 'unreadable') {
      script = undefined
      built = undefined
    }
    const inputs = JSON.stringify([settings, scriptVersion])
    const settled = status.reason !== 'starting' && status.reason !== 'unreadable' && status.reason !== 'disagrees'
    if (settled && inputs === lastInputs && answers === lastAnswers) {
      await retryApply()
      return answers
    }
    const outcome = await decide(settings, read, applied !== SYSTEM && answers === lastAnswers)
    if (stopped) return undefined
    if (outcome === 'kept') {
      await retryApply()
      return answers
    }
    answersQuietUntil = inputs === lastInputs && answers !== lastAnswers ? Date.now() + ANSWERS_QUIET_MS : 0
    lastInputs = inputs
    lastAnswers = answers
    const next: MirrorStatus = { source: deps.source, mode: outcome.mode, state: outcome.config === SYSTEM ? 'system' : 'mirrored', reason: outcome.reason }
    if (JSON.stringify(outcome.config) !== JSON.stringify(applied) || !taken) {
      applied = outcome.config
      taken = await applyOnce()
    }
    if (JSON.stringify(next) !== JSON.stringify(status)) log(`[route] system proxy: ${next.state === 'mirrored' ? 'copied' : 'left to the system'} (${next.source}, ${next.mode}, ${next.reason})`)
    status = next
    return answers
  }

  /** Tells the listeners what a pass saw. `sample` joins the answers with a newline, which no answer holds. */
  function announce (answers: string): void {
    const seen: MirrorPass = { status, answers: answers.split('\n') }
    for (const listener of listeners) {
      try {
        listener(seen)
      } catch (error) {
        console.error('[route] a listener of the system proxy mirror failed:', error instanceof Error ? error.message : 'unexpected error')
      }
    }
  }

  /** One pass at a time; a call during one runs one more pass after it. Never rejects. */
  function refresh (): Promise<void> {
    if (running !== undefined) {
      queued = true
      return running
    }
    const loop = async (): Promise<void> => {
      do {
        queued = false
        try {
          const answers = await pass()
          if (answers !== undefined && !stopped) announce(answers)
        } catch (error) {
          console.error('[route] reading the system proxy failed:', error instanceof Error ? error.message : 'unexpected error')
        }
      } while (queued && !stopped)
    }
    running = loop().finally(() => { running = undefined })
    return running
  }

  async function tick (): Promise<void> {
    if (running !== undefined || stopped) return
    const answers = await sample()
    if (answers !== lastAnswers && running === undefined && !stopped && Date.now() >= answersQuietUntil) await refresh()
  }

  return {
    config: () => applied,
    status: () => status,
    onPass: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: async () => {
      if (deps.read === undefined || deps.held === true) return
      await within(refresh(), START_BOUND_MS, 'the first read of the system proxy took too long').catch(() => {})
      if (stopped) return
      timers = [
        setInterval(() => { void tick() }, ANSWER_EVERY_MS), // orivon:floating-ok -- tick asks sessions through `ask`, which catches
        setInterval(() => { void refresh() }, READ_EVERY_MS) // orivon:floating-ok -- refresh never rejects
      ]
      for (const timer of timers) timer.unref()
    },
    refresh,
    stop: () => {
      stopped = true
      for (const timer of timers) clearInterval(timer)
      timers = []
    }
  }
}
