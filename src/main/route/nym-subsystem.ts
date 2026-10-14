// The Nym tunnel as the shell reaches it: ask for it (`ensure`), read what it is doing, test it. The utility process
// starts when the first routed app needs it and stops ten minutes after the last tunnel is gone, on a loopback port
// and under a secret made for each start. Electron-free: the process, the artifact, the proxy check and the clock
// come in (nym-launch.ts).

import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { createSocks5Provider } from '../../broker/route/socks5.js'
import { SHORT_LIVED_USER } from '../../protocols/nym-tunnel/protocol.js'
import type { NymPrivacy, NymTunnelConfig, PinnedFile } from '../../protocols/nym-tunnel/protocol.js'
import type { ArtifactStatus } from '../verifier/local-node-artifact.js'
import type { HostProcess } from '../verifier/process-supervisor.js'
import { RefusedToStart } from '../verifier/process-supervisor.js'
import type { NymState, NymTestResult } from './nym-status.js'
import { NymSupervisor } from './nym-supervisor.js'

/** Where the host listens and what its clients must send. */
export interface NymEndpoint {
  readonly port: number
  readonly secret: string
}

/** Why Nym cannot carry traffic now; an app's connection through it fails closed with this. */
export class NymUnavailable extends Error {}

export const STOP_AFTER_LAST_TUNNEL_MS = 10 * 60_000
export const LISTEN_WAIT_MS = 15_000
/** Each tunnel the host starts leaves a module instance in its memory until the process exits (the host's README.md): after this many it is replaced, as soon as no tunnel is open. */
export const RECYCLE_AFTER_STARTS = 24
/** How long an answer to "is a proxy set?" is reused. */
const PROXY_CHECK_REUSE_MS = 5_000
/** A refusal is answered from memory for this long before the files and the proxy are looked at again. */
export const REFUSAL_MEMORY_MS = 10_000
const TEST_DESTINATION = { host: 'example.com', port: 443 }
export const TEST_WAIT_MS = 60_000

export interface NymDeps {
  readonly fork: () => HostProcess
  /** Checks the module's files against the pinned hashes, and says where they are. */
  readonly artifact: () => Promise<ArtifactStatus>
  /** The files the module is made of, as pinned: the process reads each once and runs only matching bytes. */
  readonly files: () => readonly PinnedFile[]
  /** Whether the default session has a proxy in front of it, which Nym's own connections to its gateways would go around. */
  readonly proxyConfigured: () => Promise<boolean>
  /** Why Nym must not start in this build (a hermetic test run), or undefined. */
  readonly disabled?: () => string | undefined
  /** A quiet loopback port, new at each call. */
  readonly freshPort: () => number
  readonly maxInstances: number
  /** The level tunnels are made at until `setPrivacy` says otherwise: the saved setting. */
  readonly privacy: NymPrivacy
  readonly log?: boolean
  readonly stopAfterMs?: number
  readonly listenWaitMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
  readonly now?: () => number
}

export interface NymSubsystem {
  /** Starts the host if need be and resolves with where it listens. Rejects with `NymUnavailable` when Nym cannot run. */
  ensure: () => Promise<NymEndpoint>
  state: () => NymState
  onChange: (listener: () => void) => () => void
  /** Brings Nym up if need be, opens a stream to a name through it, and says how long that took. */
  test: () => Promise<NymTestResult>
  /** Tunnels started from now on are made at `privacy`; the running ones are replaced as soon as nothing is using them. */
  setPrivacy: (privacy: NymPrivacy) => void
  stop: () => void
}

type Verdict = { readonly directory: string } | { readonly reason: string, readonly cause: 'not-in-build' | 'proxy' | 'other' }

const PROXY_VERDICT = { reason: 'a proxy is configured, and the Nym tunnel\'s connections to Nym\'s gateways would go around it', cause: 'proxy' } as const

export function createNymSubsystem (deps: NymDeps): NymSubsystem {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) })
  const listeners = new Set<() => void>()
  let current: NymState = { state: 'off' }
  let endpoint: NymEndpoint | undefined
  let listening = false
  let running = false
  let refusedUntil = 0
  let refusal: Extract<Verdict, { reason: string }> | undefined
  let approved: string | undefined
  let checking: Promise<Verdict> | undefined
  let stopTimer: unknown
  let privacy = deps.privacy
  let waiters: Array<{ resolve: () => void, reject: (error: Error) => void }> = []

  /** How many times the state has become `failed`, so a reason can be told from one that was there before a press. */
  let failures = 0
  const set = (state: NymState): void => {
    if (state.state === 'failed') failures += 1
    current = state
    for (const listener of [...listeners]) listener()
  }
  const settle = (error?: Error): void => {
    const all = waiters
    waiters = []
    for (const waiter of all) { if (error === undefined) waiter.resolve(); else waiter.reject(error) }
  }
  const cancelStop = (): void => {
    if (stopTimer !== undefined) clearTimer(stopTimer)
    stopTimer = undefined
  }
  const armStop = (): void => {
    cancelStop()
    stopTimer = setTimer(() => { stopTimer = undefined; supervisor.idle() }, deps.stopAfterMs ?? STOP_AFTER_LAST_TUNNEL_MS)
  }

  let proxyAnswer: { readonly at: number, readonly set: boolean } | undefined
  const proxyIsSet = async (): Promise<boolean> => {
    if (proxyAnswer !== undefined && now() - proxyAnswer.at < PROXY_CHECK_REUSE_MS) return proxyAnswer.set
    const set = await deps.proxyConfigured().catch(() => true)
    proxyAnswer = { at: now(), set }
    return set
  }

  const look = async (): Promise<Verdict> => {
    const disabled = deps.disabled?.()
    if (disabled !== undefined) return { reason: disabled, cause: 'other' }
    if (await proxyIsSet()) return PROXY_VERDICT
    const artifact = await deps.artifact()
    return artifact.ok ? { directory: artifact.directory } : { reason: artifact.reason, cause: 'not-in-build' }
  }
  const check = async (): Promise<Verdict> => {
    checking ??= look().finally(() => { checking = undefined })
    return await checking
  }
  const refuse = (verdict: Extract<Verdict, { reason: string }>): void => {
    refusal = verdict
    refusedUntil = now() + REFUSAL_MEMORY_MS
    set({ state: 'unavailable', cause: verdict.cause, reason: verdict.reason })
  }

  const supervisor = new NymSupervisor({
    fork: deps.fork,
    config: async (): Promise<NymTunnelConfig> => {
      const taken = approved
      approved = undefined
      const verdict = taken === undefined ? await check() : { directory: taken }
      if ('reason' in verdict) {
        refuse(verdict)
        throw new RefusedToStart(verdict.reason)
      }
      endpoint = { port: deps.freshPort(), secret: randomBytes(24).toString('hex') }
      return { moduleDir: verdict.directory, files: deps.files(), port: endpoint.port, secret: endpoint.secret, maxInstances: deps.maxInstances, privacy, ...(deps.log === true ? { log: true } : {}) }
    },
    events: {
      starting: () => { running = true; listening = false; set({ state: 'connecting' }) },
      idle: () => { running = false; listening = false; endpoint = undefined; cancelStop(); set(current.state === 'failed' ? current : { state: 'off' }); settle(new NymUnavailable('Nym was stopped')) },
      listening: () => {
        listening = true
        if (current.state === 'connecting') set({ state: 'idle' })
        settle()
      },
      instances: (connecting, ready, started, problem) => {
        if (connecting > 0) { cancelStop(); set({ state: 'connecting' }); return }
        if (ready > 0) { cancelStop(); set({ state: 'ready', ...(problem === undefined ? {} : { reason: problem }) }); return }
        if (problem !== undefined) set({ state: 'failed', reason: problem })
        else set({ state: 'idle' })
        if (started >= RECYCLE_AFTER_STARTS) { cancelStop(); supervisor.idle(); return }
        armStop()
      },
      failed: () => {},
      down: (reason, restarting) => {
        if (refusal !== undefined && !restarting) { running = false; listening = false; settle(new NymUnavailable(refusal.reason)); return }
        console.error(`[nym-tunnel] ${reason}`)
        listening = false
        if (!restarting) { running = false; refusedUntil = now() + REFUSAL_MEMORY_MS }
        set({ state: 'failed', reason })
        settle(new NymUnavailable(reason))
      }
    },
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.now === undefined ? {} : { now: deps.now })
  })

  const ensure = async (): Promise<NymEndpoint> => {
    cancelStop()
    if (listening && endpoint !== undefined) {
      // A proxy set while the host runs: its connections to the gateways would now go around it.
      if (await proxyIsSet()) { supervisor.idle(); refuse(PROXY_VERDICT); throw new NymUnavailable(PROXY_VERDICT.reason) }
      return endpoint
    }
    if (!running) {
      if (now() < refusedUntil && current.state === 'unavailable') throw new NymUnavailable(current.reason)
      if (now() < refusedUntil && current.state === 'failed') throw new NymUnavailable(current.reason)
      refusal = undefined
      const verdict = await check()
      if ('reason' in verdict) { refuse(verdict); throw new NymUnavailable(verdict.reason) }
      approved = verdict.directory
      supervisor.start()
    }
    if (!listening) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve: () => { clearTimer(timer); resolve() }, reject: (error: Error) => { clearTimer(timer); reject(error) } }
        const timer = setTimer(() => { waiters = waiters.filter((entry) => entry !== waiter); reject(new NymUnavailable('Nym did not start in time')) }, deps.listenWaitMs ?? LISTEN_WAIT_MS)
        waiters.push(waiter)
      })
    }
    if (endpoint === undefined) throw new NymUnavailable('Nym is not running')
    // Nothing may come of this ask (a client with the wrong secret): the host must not outlive it for ever.
    if (current.state === 'idle') armStop()
    return endpoint
  }

  const test = async (): Promise<NymTestResult> => {
    const started = now()
    const failuresBefore = failures
    // One bound for the whole press, so the person is never left on "Testing" for the sum of the waits inside it.
    const abort = new AbortController()
    const timer = setTimer(() => { abort.abort() }, TEST_WAIT_MS)
    const silent: NymTestResult = { ok: false, reason: 'silent', detail: `no answer within ${String(TEST_WAIT_MS / 1000)} s` }
    const expired = new Promise<never>((_resolve, reject) => { abort.signal.addEventListener('abort', () => { reject(new Error('the test ran out of time')) }, { once: true }) })
    expired.catch(() => {})
    let socket: Socket | undefined
    try {
      let where: NymEndpoint
      try {
        where = await Promise.race([ensure(), expired])
      } catch (error) {
        if (abort.signal.aborted) return silent
        return { ok: false, reason: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
      }
      try {
        const provider = createSocks5Provider({ host: '127.0.0.1', port: where.port, credentials: { userId: SHORT_LIVED_USER, password: where.secret }, timeoutMs: TEST_WAIT_MS })
        socket = await provider.connect(TEST_DESTINATION.host, TEST_DESTINATION.port, abort.signal)
        return { ok: true, ms: now() - started }
      } catch (error) {
        if (abort.signal.aborted) return silent
        // The host knows why a tunnel did not come up; the connection only says that it was closed.
        const detail = current.state === 'failed' && failures > failuresBefore ? current.reason : error instanceof Error ? error.message : String(error)
        return { ok: false, reason: 'failed', detail }
      }
    } finally {
      clearTimer(timer)
      socket?.destroy()
    }
  }

  return {
    ensure,
    state: () => current,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    test,
    setPrivacy: (next) => {
      if (next === privacy) return
      privacy = next
      // A host that is not running reads the level at its next start; one that is has it said.
      supervisor.send({ type: 'privacy', privacy })
    },
    stop: () => { cancelStop(); supervisor.stop() }
  }
}
