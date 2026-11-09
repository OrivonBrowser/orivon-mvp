// Copies the system's proxy settings into the config the route controller gives the sessions that follow the system, and keeps
// the copy true. It reads the settings every 30 seconds and asks Chromium's own answer (a session that stays on the system's config)
// every 2 seconds, which shows a proxy turned on, off or moved at once. A copy is applied only after a session of its own,
// set to it, answers the same as Chromium's session for the same addresses; when it does not, twice running, or when the settings
// cannot be read or carried, every session stays on `{ mode: 'system' }`, where the guard for the names the verifier serves decides.
// Electron-free over the calls it is handed.

import type { SystemProxyConfig } from '../system-follow.js'
import { within } from '../within.js'
import { BASE_CANARIES, exceptionCanaries } from './canaries.js'
import { mirroredConfig } from './mirrored-config.js'
import type { MirrorReason, MirrorStatus } from './mirror-status.js'
import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** How often Chromium's own answer is asked, in process. Provisional: a proxy turned on is followed after about this long. */
export const ANSWER_EVERY_MS = 2_000
/** How often the settings are read. Provisional: an edit of the exceptions alone is followed after about this long. */
export const READ_EVERY_MS = 30_000
/** How long the first read and check may hold the start of the browser. */
export const START_BOUND_MS = 6_000
/** How long one question to a session, or one set of the check session, may take. */
const CALL_MS = 5_000

const SYSTEM: SystemProxyConfig = { mode: 'system' }

export interface ProxyMirrorDeps {
  readonly source: SettingsSourceName
  /** Reads the settings, or undefined when this computer's cannot be read yet: the mirror then does nothing at all. Never rejects. */
  readonly read: (() => Promise<SystemSettings>) | undefined
  /** Nothing follows the system (a window held to a tunnel). */
  readonly held?: boolean
  /** Chromium's own answer for the address, from a session that stays on `{ mode: 'system' }`. */
  readonly systemAnswer: (url: string) => Promise<string>
  /** A session of the mirror's own: set to a config to try, then asked. */
  readonly check: { readonly set: (config: SystemProxyConfig) => Promise<void>, readonly answer: (url: string) => Promise<string> }
  /** `config()` has changed: every session that follows the system takes it. */
  readonly apply: () => Promise<void>
  readonly log?: (line: string) => void
}

export interface ProxyMirror {
  /** What the sessions that follow the system are set to now; `{ mode: 'system' }` until a copy has been checked. */
  config: () => SystemProxyConfig
  status: () => MirrorStatus
  /** Reads once (bounded), then keeps reading. Resolves with nothing read at all when this computer's settings cannot be read yet. */
  start: () => Promise<void>
  /** Reads, checks and applies once; resolves when that ended. */
  refresh: () => Promise<void>
  stop: () => void
}

const STAY_REASON: Readonly<Record<Exclude<SystemSettings['kind'], 'manual'>, MirrorReason>> = {
  none: 'no-proxy', script: 'script', detect: 'detect', unsupported: 'unsupported', unreadable: 'unreadable'
}

export function createProxyMirror (deps: ProxyMirrorDeps): ProxyMirror {
  const log = deps.log ?? ((line: string) => { console.info(line) })
  let applied: SystemProxyConfig = SYSTEM
  let status: MirrorStatus = { source: deps.source, mode: 'unknown', state: 'system', reason: deps.held === true ? 'held' : deps.read === undefined ? 'no-reader' : 'starting' }
  /** What the last pass looked at, so a pass that sees the same does nothing. */
  let lastInputs = ''
  let lastAnswers = ''
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

  /** Whether a session set to `config` answers as Chromium's own does for the base addresses and the ones the exceptions cover. */
  async function agrees (config: SystemProxyConfig, exceptions: readonly string[]): Promise<boolean> {
    try {
      await within(deps.check.set(config), CALL_MS, 'the check session was not set')
    } catch {
      return false
    }
    for (const url of [...BASE_CANARIES, ...exceptionCanaries(exceptions)]) {
      const [system, copy] = await Promise.all([ask(deps.systemAnswer, url), ask(deps.check.answer, url)])
      if (system === undefined || system !== copy) return false
    }
    return true
  }

  /** What the sessions should be set to for `settings`. A copy that Chromium's answer does not match is tried once more after a fresh read, since the settings may have changed between the read and the question. */
  async function decide (settings: SystemSettings, read: () => Promise<SystemSettings>): Promise<{ config: SystemProxyConfig, reason: MirrorReason, mode: MirrorStatus['mode'] }> {
    let current = settings
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) current = await read()
      if (current.kind !== 'manual') return { config: SYSTEM, reason: STAY_REASON[current.kind], mode: current.kind }
      const config = mirroredConfig(current)
      if (config !== undefined && await agrees(config, current.exceptions)) return { config, reason: 'copied', mode: 'manual' }
    }
    return { config: SYSTEM, reason: 'disagrees', mode: 'manual' }
  }

  async function pass (): Promise<void> {
    const read = deps.read
    if (read === undefined) return
    const settings = await read()
    const answers = await sample()
    const inputs = JSON.stringify(settings)
    const settled = status.reason !== 'starting' && status.reason !== 'unreadable' && status.reason !== 'disagrees'
    if (settled && inputs === lastInputs && answers === lastAnswers) return
    lastInputs = inputs
    lastAnswers = answers
    const outcome = await decide(settings, read)
    const next: MirrorStatus = { source: deps.source, mode: outcome.mode, state: outcome.config === SYSTEM ? 'system' : 'mirrored', reason: outcome.reason }
    if (JSON.stringify(outcome.config) !== JSON.stringify(applied)) {
      applied = outcome.config
      await deps.apply()
    }
    if (JSON.stringify(next) !== JSON.stringify(status)) log(`[route] system proxy: ${next.state === 'mirrored' ? 'copied' : 'left to the system'} (${next.source}, ${next.mode}, ${next.reason})`)
    status = next
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
          await pass()
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
    if (answers !== lastAnswers && running === undefined && !stopped) await refresh()
  }

  return {
    config: () => applied,
    status: () => status,
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
