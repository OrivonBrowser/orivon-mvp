import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkServiceRecovery, holdLine, untilAnswered } from '../network-service-recovery.js'
import type { ServiceSetting, SessionSetting } from '../network-service-recovery.js'
import { NetworkServiceRestart } from '../network-service-restart.js'

type Target = string

interface Pending { resolve: () => void, reject: (why: string) => void, stop: () => boolean }

interface Built {
  recovery: NetworkServiceRecovery<Target>
  restart: NetworkServiceRestart
  log: string[]
  order: string[]
  /** Every session setting sent, as `name:session`, and every service setting, as `name`. */
  sent: string[]
  /** The probes still unanswered, by session. */
  pending: Map<Target, Pending>
  /** Answers the probe of `target`. */
  answer: (target: Target) => Promise<void>
  /** Makes a session known while a restart is under way. */
  announce: (target: Target) => void
}

interface Options {
  /** The sessions that answer at once; any other waits for `answer`. */
  answering?: Target[]
  targets?: Target[]
  service?: ServiceSetting[]
  session?: Array<SessionSetting<Target>>
  beforeSending?: () => Promise<void>
}

/** Lets what a settled promise started run, without moving the clock. */
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

function build (options: Options = {}): Built {
  const log: string[] = []
  const order: string[] = []
  const sent: string[] = []
  const pending = new Map<Target, Pending>()
  const listeners = new Set<(target: Target) => void>()
  const targets = options.targets ?? ['default', 'tunnel']
  const answering = options.answering ?? targets
  const restart = new NetworkServiceRestart({ now: Date.now, boundMs: 5000, ended: (report) => { order.push(`ended:${report.outcome}`) } })
  const session = options.session ?? [{ name: 'certificate check', reapply: (target: Target) => { sent.push(`check:${target}`) } }]
  const service = options.service ?? [{ name: 'secure DNS', reapply: () => { sent.push('dns'); return 'secure' } }]
  const recovery = new NetworkServiceRecovery<Target>({
    restart,
    primary: () => 'default',
    answers: async (target, stop) => {
      order.push(`ask:${target}`)
      await new Promise<void>((resolve, reject) => {
        if (answering.includes(target)) resolve()
        else pending.set(target, { resolve, reject: (why) => { reject(new Error(why)) }, stop })
      })
    },
    targets: () => targets,
    watch: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ...(options.beforeSending === undefined ? {} : { beforeSending: options.beforeSending }),
    graceMs: 1000,
    serviceSettings: () => service,
    sessionSettings: () => session,
    now: Date.now,
    log: (line) => { log.push(line) },
    holdBegan: () => { order.push('hold') }
  })
  return {
    recovery,
    restart,
    log,
    order,
    sent,
    pending,
    answer: async (target) => { pending.get(target)?.resolve(); pending.delete(target); await flush() },
    announce: (target) => { for (const listener of [...listeners]) listener(target) }
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a network-service restart', () => {
  it('holds requests, waits for the new service, sends each setting once, then lets the requests go', async () => {
    const { recovery, restart, order, sent, log } = build()
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(order.filter((step) => !step.startsWith('ask:'))).toEqual(['hold', 'ended:reapplied'])
    expect(order.slice(0, 3).sort()).toEqual(['ask:default', 'ask:tunnel', 'hold'])
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
    expect(restart.isHolding()).toBe(false)
    expect(log[0]).toContain('ended (killed, exit code 9)')
    expect(log[1]).toContain('secure DNS (secure), certificate check (2 sessions)')
  })

  it('keeps requests waiting while the new service is not up, and sends nothing before it is', async () => {
    const { recovery, restart, sent, answer } = build({ answering: ['tunnel'] })
    const done = recovery.onEnded({ reason: 'crashed', exitCode: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(restart.isHolding()).toBe(true)
    expect(sent).toEqual([])
    await answer('default')
    await done
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
    expect(restart.isHolding()).toBe(false)
  })

  it('sends nothing, to any session, before the padding a test build asks for has passed', async () => {
    let release: () => void = () => {}
    const { recovery, sent } = build({ beforeSending: async () => { await new Promise<void>((resolve) => { release = resolve }) } })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(500)
    expect(sent).toEqual([])
    release()
    await done
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
  })

  it('still sends the settings of the service when the primary session never answers, and says it could not tell', async () => {
    const { recovery, sent, log, pending } = build({ answering: ['tunnel'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await flush()
    pending.get('default')?.reject('no answer after 20 tries')
    expect(await done).toBe(true)
    expect(sent.sort()).toEqual(['check:tunnel', 'dns'])
    expect(log.some((line) => line.includes('could not tell when the new service was up (Error: no answer after 20 tries)'))).toBe(true)
  })

  it('goes on to the other settings when one throws, and names the one that was not sent', async () => {
    const sent: string[] = []
    const { recovery, log, restart } = build({
      service: [
        { name: 'verifier host', reapply: () => { throw new Error('host gone') } },
        { name: 'secure DNS', reapply: () => { sent.push('dns'); return 'secure' } }
      ],
      session: [
        { name: 'certificate check', reapply: (target) => { if (target === 'tunnel') throw new Error('session gone'); sent.push(`check:${target}`) } }
      ]
    })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(sent.sort()).toEqual(['check:default', 'dns'])
    expect(restart.isHolding()).toBe(false)
    expect(log.some((line) => line.includes('could not send the verifier host again: Error: host gone'))).toBe(true)
    expect(log.some((line) => line.includes('could not send the certificate check again to a session: Error: session gone'))).toBe(true)
    expect(log.at(-1)).toContain('not sent: verifier host, certificate check')
  })

  it('says "none to send" when there is nothing to give a new service', async () => {
    const { recovery, log } = build({ service: [{ name: 'secure DNS', reapply: () => undefined }], session: [] })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(log.at(-1)).toContain('none to send')
  })

  it('leaves the hold to the later restart when the service ends again before the settings are sent', async () => {
    const { recovery, restart, log, sent, pending } = build({ answering: [] })
    const first = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(10)
    const firstProbes = new Map(pending)
    pending.clear()
    const second = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await flush()
    for (const probe of pending.values()) probe.resolve()
    expect(await second).toBe(true)
    expect(restart.isHolding()).toBe(false)
    const sentByLater = [...sent]
    expect(sentByLater.filter((entry) => entry === 'dns')).toHaveLength(1)
    for (const probe of firstProbes.values()) {
      expect(probe.stop()).toBe(true)
      probe.resolve()
    }
    expect(await first).toBe(false)
    expect(sent).toEqual(sentByLater)
    expect(log.some((line) => line.includes('ended again before its settings were sent'))).toBe(true)
  })

  it('lets the requests go at the bound when the new service never answers, and still sends the settings when it does', async () => {
    const { recovery, restart, order, sent, answer } = build({ answering: [] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(restart.isHolding()).toBe(false)
    expect(order).toContain('ended:timed-out')
    expect(sent).toEqual([])
    await answer('default')
    await answer('tunnel')
    await done
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
  })
})

describe('the sessions of a restart', () => {
  it('sends a session its settings when its own probe answers, and lets the requests go once every session has', async () => {
    const { recovery, restart, sent, answer } = build({ answering: [] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await answer('tunnel')
    expect(sent).toEqual([])
    await answer('default')
    await vi.advanceTimersByTimeAsync(0)
    expect(await done).toBe(true)
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
    expect(restart.isHolding()).toBe(false)
  })

  it('does not send the settings of a session whose probe has not answered, and sends them when it does, after the requests went on', async () => {
    const { recovery, restart, sent, log, answer } = build({ answering: ['default'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await done).toBe(true)
    expect(restart.isHolding()).toBe(false)
    expect(sent.sort()).toEqual(['check:default', 'dns'])
    expect(log.at(-1)).toContain('certificate check (1 session)')
    await vi.advanceTimersByTimeAsync(2000)
    await answer('tunnel')
    expect(sent.sort()).toEqual(['check:default', 'check:tunnel', 'dns'])
    expect(log.at(-1)).toBe('[network-service] 1 of 2 sessions answered after the requests went on, and were sent their settings then')
  })

  it('never sends the settings to a session that does not answer, and says how many did not', async () => {
    const { recovery, sent, log, pending } = build({ answering: ['default'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(1000)
    await done
    await vi.advanceTimersByTimeAsync(4000)
    pending.get('tunnel')?.reject('no answer after 900 tries')
    await flush()
    expect(sent.sort()).toEqual(['check:default', 'dns'])
    expect(log.at(-1)).toBe('[network-service] 1 of 2 sessions did not answer within 5000 ms, and were not sent their settings')
  })

  it('says nothing of late sessions when every one answered in time', async () => {
    const { recovery, log } = build()
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await flush()
    expect(log.filter((line) => line.includes('sessions answered after') || line.includes('did not answer'))).toEqual([])
  })

  it('asks and sends a session made while the restart is under way', async () => {
    const { recovery, sent, order, answer, announce } = build({ answering: [], targets: ['default'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await flush()
    announce('later')
    expect(order).toContain('ask:later')
    await answer('default')
    expect(sent).not.toContain('check:later')
    await answer('later')
    expect(await done).toBe(true)
    expect(sent.sort()).toEqual(['check:default', 'check:later', 'dns'])
  })

  it('holds the requests for a session made during the grace until it answers or the grace passes', async () => {
    const { recovery, restart, answer, announce, sent } = build({ answering: ['default'], targets: ['default', 'slow'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(300)
    announce('made-in-the-grace')
    await vi.advanceTimersByTimeAsync(100)
    await answer('slow')
    expect(restart.isHolding()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(restart.isHolding()).toBe(true)
    await answer('made-in-the-grace')
    expect(await done).toBe(true)
    expect(restart.isHolding()).toBe(false)
    expect(sent.sort()).toEqual(['check:default', 'check:made-in-the-grace', 'check:slow', 'dns'])
  })

  it('does not ask a session made after the requests went on', async () => {
    const { recovery, order, announce } = build({ targets: ['default'] })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    announce('after')
    expect(order).not.toContain('ask:after')
  })

  it('asks a session once, however many times it is announced', async () => {
    const { recovery, order, announce, answer } = build({ answering: [], targets: ['default'] })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await flush()
    announce('twice')
    announce('twice')
    announce('default')
    await answer('default')
    await answer('twice')
    await done
    expect(order.filter((step) => step === 'ask:twice')).toHaveLength(1)
    expect(order.filter((step) => step === 'ask:default')).toHaveLength(1)
  })

  it('stops asking, and says nothing of the sessions that did not answer, once a later restart supersedes it', async () => {
    const { recovery, log, pending } = build({ answering: ['default'] })
    const first = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe(true)
    const late = pending.get('tunnel')
    expect(late?.stop()).toBe(false)
    void recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(late?.stop()).toBe(true)
    late?.reject('stopped')
    await vi.advanceTimersByTimeAsync(10)
    expect(log.filter((line) => line.includes('did not answer'))).toEqual([])
  })
})

describe('holdLine', () => {
  it('says how long requests waited when the settings came back', () => {
    expect(holdLine({ outcome: 'reapplied', heldMs: 87, requests: 3 })).toBe('[network-service] 3 requests waited 87 ms and went on')
    expect(holdLine({ outcome: 'reapplied', heldMs: 40, requests: 1 })).toBe('[network-service] 1 request waited 40 ms and went on')
  })

  it('says the settings were not back when the bound passed', () => {
    expect(holdLine({ outcome: 'timed-out', heldMs: 5000, requests: 2 })).toBe('[network-service] the settings were not sent again within 5000 ms: 2 requests went on without them')
  })
})

describe('the log line of a recovery', () => {
  it('says how long the new service took to answer and what was sent', async () => {
    let clock = 1_000
    const log: string[] = []
    const restart = new NetworkServiceRestart({ now: () => clock, boundMs: 5000, ended: () => {} })
    const recovery = new NetworkServiceRecovery<Target>({
      restart,
      primary: () => 'default',
      answers: async () => { clock += 40 },
      targets: () => ['default'],
      watch: () => () => {},
      graceMs: 1000,
      serviceSettings: () => [{ name: 'dns', reapply: () => { clock += 3; return 'secure, 1 server' } }, { name: 'nothing', reapply: () => undefined }],
      sessionSettings: () => [],
      now: () => clock,
      log: (line) => { log.push(line) },
      holdBegan: () => {}
    })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(log.at(-1)).toBe('[network-service] settings sent again 43 ms after the service ended, answering after 40 ms: dns (secure, 1 server)')
  })

  it('asks every session the app has, the default one first', async () => {
    const asked: Target[] = []
    const restart = new NetworkServiceRestart({ now: Date.now, boundMs: 5000, ended: () => {} })
    const recovery = new NetworkServiceRecovery<Target>({
      restart,
      primary: () => 'default',
      answers: async (target) => { asked.push(target) },
      targets: () => ['tunnel', 'default'],
      watch: () => () => {},
      graceMs: 1000,
      serviceSettings: () => [],
      sessionSettings: () => [],
      now: Date.now,
      log: () => {},
      holdBegan: () => {}
    })
    await recovery.onEnded({ reason: 'killed', exitCode: null })
    expect(asked).toEqual(['default', 'tunnel'])
  })
})

describe('untilAnswered', () => {
  it('returns at the first answer', async () => {
    const ask = vi.fn(async () => await Promise.resolve('ok'))
    expect(await untilAnswered(ask, { boundMs: 1000 })).toBe(1)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks again after a refusal, and after a call that is never answered', async () => {
    const calls: string[] = []
    const ask = async (): Promise<string> => {
      calls.push('call')
      if (calls.length === 1) throw new Error('ERR_FAILED')
      if (calls.length === 2) return await new Promise<string>(() => {})
      return 'answered'
    }
    const done = untilAnswered(ask, { boundMs: 5000, attemptMs: 250, retryMs: 5 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await done).toBe(3)
  })

  it('throws once the bound has passed with no answer', async () => {
    const done = untilAnswered(async () => { throw new Error('ERR_FAILED') }, { boundMs: 100, attemptMs: 250, retryMs: 20 })
    const caught = done.then(() => 'answered', (error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(500)
    expect(await caught).toMatch(/^no answer after \d+ tries$/)
  })
})
