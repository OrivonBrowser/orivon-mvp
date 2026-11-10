// When the name relay runs, and what turning it on and off does, in the order that keeps this computer's address from showing:
// the listener first, then Chromium's resolver held at this computer's DNS (so none of its probes goes to a DNS provider), then
// the sessions that follow the system set to the relay, then their pages confined, then the callers that check addresses pointed at
// the relay's lookup. Off is the reverse, and the listener stops
// accepting last, so a tunnel in flight finishes. A listener that stops by itself is started again on another port, and until
// then the sessions are pointed at the dead end, never back at the proxy's own lookup. Electron-free over the calls it is handed.

import type { SystemProxyConfig } from '../system-follow.js'
import type { RouteChallengeSource } from '../lookup-session.js'
import type { MirrorPass } from '../proxy-mirror/proxy-mirror.js'
import type { MirrorStatus } from '../proxy-mirror/mirror-status.js'
import type { DohProvider } from './proxied-lookup.js'
import type { RefusalWord } from './relay-failures.js'
import type { NameRelayLink } from './relay-link.js'
import { nameRelayStatus, stateLine } from './relay-status.js'
import type { NameRelayStatus } from './relay-status.js'

type Environment = Readonly<Record<string, string | undefined>>

/** The variables Chromium reads a proxy from on Linux, in the spellings it tries. */
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'all_proxy', 'SOCKS_SERVER'] as const

const variable = (env: Environment, name: string): string | undefined => env[name] ?? env[name.toUpperCase()]

/** Whether the environment names a proxy where Chromium reads it: on Linux, from the source that has no setting of its own or none set. `auto_proxy` set and empty is detection, which counts. A variable set and empty names none. */
export function environmentNamesProxy (env: Environment, source: MirrorStatus['source']): boolean {
  if (source === 'windows' || source === 'macos') return false
  return variable(env, 'auto_proxy') !== undefined || PROXY_VARIABLES.some((name) => (variable(env, name) ?? '').trim() !== '')
}

export interface ActivationFacts {
  /** The setting. */
  readonly enabled: boolean
  /** A private window held to Nym: nothing follows the system. */
  readonly heldToNym: boolean
  readonly mirror: MirrorStatus
  /** Chromium's own answer for each of the mirror's two ordinary addresses at its last pass, `unanswered` for one that did not come; undefined before a pass, or when no reader exists. */
  readonly answers: readonly string[] | undefined
  readonly environment: Environment
}

/** `on` and `off` are decided; `keep` says the facts do not settle it and the relay stays as it is. */
export type Activation = 'on' | 'off' | 'keep'

/** Whether a proxy may apply, which is the relay's reason to run. A read that found a proxy, a script, detection or settings that cannot be carried or read counts at once, ahead of the copy; so does a base answer that names a proxy, and the environment where Chromium reads it. */
export function activation (facts: ActivationFacts): Activation {
  if (!facts.enabled || facts.heldToNym) return 'off'
  const { mirror } = facts
  if (mirror.mode === 'manual' || mirror.mode === 'script' || mirror.mode === 'detect' || mirror.mode === 'unsupported' || mirror.mode === 'unreadable') return 'on'
  if (environmentNamesProxy(facts.environment, mirror.source)) return 'on'
  const answers = facts.answers ?? []
  if (answers.some((answer) => answer !== 'DIRECT' && answer !== 'unanswered')) return 'on'
  if (mirror.mode === 'unknown' && mirror.reason === 'no-reader') return 'off'
  if (facts.answers === undefined || answers.includes('unanswered')) return 'keep'
  return 'off'
}

/** A listener that is up: where Chromium is pointed, and what its proxy challenge is answered with. */
export interface RelayListener {
  readonly port: number
  readonly username: string
  readonly secret: string
  /** Stops accepting; a connection in flight finishes, and this resolves when the last has. */
  readonly stop: () => Promise<void>
  /** Ends every connection and stops accepting. */
  readonly close: () => Promise<void>
}

export interface RelaySwitchDeps {
  readonly environment: Environment
  readonly heldToNym: boolean
  /** Starts the listener. `onClosed` is called when it stops listening, whoever stopped it. Rejects when it cannot listen. */
  readonly listen: (onClosed: () => void) => Promise<RelayListener>
  /** Holds Chromium's own resolver at this computer's DNS (and stops Orivon's Quad9 check), or lets the Secure DNS setting apply again. */
  readonly holdResolver: (held: boolean) => void
  /** Sets every session that follows the system to what `link.config()` says now. Resolves with whether every one took it. */
  readonly sessionsChanged: () => Promise<boolean>
  /** The pages of the sessions that follow the system take, or lose, the WebRTC confinement `link.config()` implies. */
  readonly confine: () => void
  /** The callers in main that check an address before they read (a tab's icon, a CCIP-Read gateway) use the relay's lookup and its pinned endpoint while this is `true`, and their own lookup and road when it is `false`. */
  readonly callers: (on: boolean) => void
  /** Forgets every answer the lookups hold and closes their sessions' connections. */
  readonly forgetLookups: () => Promise<void>
  /** The config the mirror has applied, and what it says of the settings: its exceptions go to the relay's sessions only while it copied them. */
  readonly mirrorConfig: () => SystemProxyConfig
  readonly mirrorStatus: () => MirrorStatus
  /** The bypass rules for the names the verifier serves, in both spellings: used when the mirror holds no copy. */
  readonly routedBypass: () => string
  /** The rule that reaches nothing, for the sessions while no listener is up. */
  readonly deadEnd: () => string
  readonly provider: () => DohProvider
  readonly refused: () => Readonly<Record<RefusalWord, number>>
  readonly log?: (line: string) => void
  /** How long after a stop it did not ask for the listener is started again, and after a start that failed. */
  readonly restartAfterMs?: number
}

export interface RelaySwitch {
  readonly link: NameRelayLink
  /** The setting changed, or was read for the first time. */
  setEnabled: (enabled: boolean) => void
  /** The mirror finished a pass: the relay follows what it saw. */
  onPass: (pass: MirrorPass) => void
  /** Resolves when every change started so far has ended. */
  settled: () => Promise<void>
  status: () => NameRelayStatus
  /** The relay stops for good: no restart, every connection ends. */
  dispose: () => Promise<void>
}

const RESTART_AFTER_MS = 5_000

export function createRelaySwitch (deps: RelaySwitchDeps): RelaySwitch {
  const log = deps.log ?? ((line: string) => { console.info(line) })
  const restartAfterMs = deps.restartAfterMs ?? RESTART_AFTER_MS
  let enabled = false
  let answers: readonly string[] | undefined
  let seen: MirrorStatus | undefined
  /** Whether the sessions are, or are being, on the relay. */
  let active = false
  /** The listener Chromium is pointed at while one is up; every one that still accepts or carries a connection is in `alive`. */
  let listener: RelayListener | undefined
  const alive = new Set<RelayListener>()
  /** Whether the sessions took the last config they were told of; when not, the next pass sets them again. */
  let taken = true
  let disposed = false
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()
  let lastLine = ''

  const mirrorNow = (): MirrorStatus => seen ?? deps.mirrorStatus()

  const status = (): NameRelayStatus => nameRelayStatus({
    enabled, heldToNym: deps.heldToNym, active, listening: listener !== undefined, resolverHeld: active, provider: deps.provider(), refused: deps.refused()
  })

  const say = (): void => {
    const line = stateLine(status())
    if (line === lastLine) return
    lastLine = line
    log(line)
  }

  const bypass = (): string => {
    const copied = deps.mirrorStatus().state === 'mirrored' ? deps.mirrorConfig() : undefined
    return copied?.mode === 'fixed_servers' && copied.proxyBypassRules !== undefined ? copied.proxyBypassRules : deps.routedBypass()
  }

  const link: NameRelayLink = {
    config: () => active ? { mode: 'fixed_servers', proxyRules: listener === undefined ? deps.deadEnd() : `http://127.0.0.1:${String(listener.port)}`, proxyBypassRules: bypass() } : undefined,
    credentials: ((info) => {
      for (const one of alive) if (info.isProxy && info.host === '127.0.0.1' && info.port === one.port) return { username: one.username, password: one.secret }
      return undefined
    }) satisfies RouteChallengeSource
  }

  const apply = async (): Promise<void> => {
    try {
      taken = await deps.sessionsChanged()
    } catch (error) {
      taken = false
      console.error('[route] setting the sessions to the name relay failed:', error instanceof Error ? error.message : 'unexpected error')
    }
  }

  function closedByItself (closed: RelayListener): void {
    if (!alive.delete(closed) || listener !== closed || disposed) return
    listener = undefined
    // The sessions are pointed at the dead end at once, then at the new port once it listens.
    enqueue(async () => {
      if (!active) return
      say()
      await apply()
      await restart()
    })
  }

  async function startListening (): Promise<boolean> {
    let started: RelayListener | undefined
    try {
      started = await deps.listen(() => { if (started !== undefined) closedByItself(started) })
    } catch (error) {
      console.error('[route] the name relay could not listen:', error instanceof Error ? error.message : 'unexpected error')
      return false
    }
    alive.add(started)
    listener = started
    return true
  }

  async function restart (): Promise<void> {
    if (disposed || !active || listener !== undefined) return
    if (await startListening()) {
      await apply()
      say()
      return
    }
    later(restart)
  }

  /** Tries `work` again after a while, once: a listener that could not start is the one thing a person could not fix by hand. */
  function later (work: () => Promise<void>): void {
    if (restartTimer !== undefined) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => { restartTimer = undefined; enqueue(work) }, restartAfterMs)
    restartTimer.unref()
  }

  async function turnOn (): Promise<void> {
    if (active || disposed) return
    if (!await startListening()) {
      // Nothing is pointed at a listener that is not there: the sessions stay as they were, and it is tried again.
      later(evaluate)
      return
    }
    deps.holdResolver(true)
    active = true
    await apply()
    deps.confine()
    deps.callers(true)
    say()
  }

  async function turnOff (): Promise<void> {
    if (!active) return
    if (restartTimer !== undefined) { clearTimeout(restartTimer); restartTimer = undefined }
    deps.callers(false)
    active = false
    await apply()
    deps.confine()
    deps.holdResolver(false)
    await deps.forgetLookups().catch((error: unknown) => { console.error('[route] the name relay could not forget its lookups:', error instanceof Error ? error.message : 'unexpected error') })
    const stopping = listener
    listener = undefined
    // A connection in flight finishes: the listener stops accepting and goes when the last one ends.
    if (stopping !== undefined) void stopping.stop().catch(() => {}).finally(() => { alive.delete(stopping) }) // orivon:floating-ok -- the catch above swallows every rejection
    say()
  }

  async function evaluate (): Promise<void> {
    const decided = activation({ enabled, heldToNym: deps.heldToNym, mirror: mirrorNow(), answers, environment: deps.environment })
    const want = decided === 'keep' ? active : decided === 'on'
    if (want && !active) await turnOn()
    else if (!want && active) await turnOff()
    else if (!taken) await apply()
    say()
  }

  function enqueue (work: () => Promise<void>): void {
    queue = queue.then(work).catch((error: unknown) => { console.error('[route] the name relay failed:', error instanceof Error ? error.message : 'unexpected error') })
  }

  return {
    link,
    setEnabled: (next) => {
      if (next === enabled) return
      enabled = next
      enqueue(evaluate)
    },
    onPass: (pass) => {
      answers = pass.answers
      seen = pass.status
      enqueue(evaluate)
    },
    settled: async () => {
      let waiting: Promise<void>
      do {
        waiting = queue
        await waiting
      } while (queue !== waiting)
    },
    status,
    dispose: async () => {
      disposed = true
      if (restartTimer !== undefined) clearTimeout(restartTimer)
      if (active) deps.callers(false)
      active = false
      listener = undefined
      await queue.catch(() => {})
      deps.holdResolver(false)
      await Promise.allSettled([...alive].map(async (one) => { await one.close() }))
      alive.clear()
    }
  }
}
