import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkServiceRecovery, holdLine, untilAnswered } from '../network-service-recovery.js'
import type { Reapplier } from '../network-service-recovery.js'
import { NetworkServiceRestart } from '../network-service-restart.js'

type Target = string

function build (options: { ready?: () => Promise<void>, reappliers?: Array<Reapplier<Target>>, targets?: Target[] } = {}): { recovery: NetworkServiceRecovery<Target>, restart: NetworkServiceRestart, log: string[], order: string[] } {
  const log: string[] = []
  const order: string[] = []
  const restart = new NetworkServiceRestart({ now: Date.now, boundMs: 5000, ended: (report) => { order.push(`ended:${report.outcome}`) } })
  const recovery = new NetworkServiceRecovery<Target>({
    restart,
    ready: async () => { order.push('ready'); await (options.ready?.() ?? Promise.resolve()) },
    targets: () => options.targets ?? ['default', 'tunnel'],
    reappliers: () => options.reappliers ?? [],
    now: Date.now,
    log: (line) => { log.push(line) },
    holdBegan: () => { order.push('hold') }
  })
  return { recovery, restart, log, order }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a network-service restart', () => {
  it('holds requests, waits for the new service, sends each setting, then lets the requests go', async () => {
    const sent: string[] = []
    const reappliers: Array<Reapplier<Target>> = [
      { name: 'certificate check', reapply: (targets) => { sent.push(`check:${targets.join('+')}`); return `${String(targets.length)} sessions` } },
      { name: 'secure DNS', reapply: () => { sent.push('dns'); return 'secure' } }
    ]
    const { recovery, restart, order, log } = build({ reappliers })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(order).toEqual(['hold', 'ready', 'ended:reapplied'])
    expect(sent).toEqual(['check:default+tunnel', 'dns'])
    expect(restart.isHolding()).toBe(false)
    expect(log[0]).toContain('ended (killed, exit code 9)')
    expect(log[1]).toContain('certificate check (2 sessions), secure DNS (secure)')
  })

  it('keeps requests waiting while the new service is not up, and sends nothing before it is', async () => {
    let up: () => void = () => {}
    const sent: string[] = []
    const { recovery, restart } = build({
      ready: async () => { await new Promise<void>((resolve) => { up = resolve }) },
      reappliers: [{ name: 'dns', reapply: () => { sent.push('dns'); return 'x' } }]
    })
    const done = recovery.onEnded({ reason: 'crashed', exitCode: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(restart.isHolding()).toBe(true)
    expect(sent).toEqual([])
    up()
    await done
    expect(sent).toEqual(['dns'])
    expect(restart.isHolding()).toBe(false)
  })

  it('still sends a setting when the service cannot be waited for, and says it could not tell', async () => {
    const sent: string[] = []
    const { recovery, log } = build({
      ready: async () => { throw new Error('no answer') },
      reappliers: [{ name: 'dns', reapply: () => { sent.push('dns'); return 'x' } }]
    })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(sent).toEqual(['dns'])
    expect(log.some((line) => line.includes('could not tell when the new service was up'))).toBe(true)
  })

  it('goes on to the other settings when one throws, and names the one that was not sent', async () => {
    const sent: string[] = []
    const { recovery, log, restart } = build({
      reappliers: [
        { name: 'certificate check', reapply: () => { throw new Error('session gone') } },
        { name: 'secure DNS', reapply: () => { sent.push('dns'); return 'secure' } }
      ]
    })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(sent).toEqual(['dns'])
    expect(restart.isHolding()).toBe(false)
    expect(log.some((line) => line.includes('could not send the certificate check again: Error: session gone'))).toBe(true)
    expect(log.at(-1)).toContain('not sent: certificate check')
  })

  it('says "none to send" for a setting with nothing to give a new service', async () => {
    const { recovery, log } = build({ reappliers: [{ name: 'secure DNS', reapply: () => undefined }] })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(log.at(-1)).toContain('none to send')
  })

  it('leaves the hold to the later restart when the service ends again before the settings are sent', async () => {
    let up: () => void = () => {}
    const sent: string[] = []
    let waits = 0
    const { recovery, restart, log } = build({
      ready: async () => {
        waits += 1
        if (waits === 1) await new Promise<void>((resolve) => { up = resolve })
      },
      reappliers: [{ name: 'dns', reapply: () => { sent.push('dns'); return 'x' } }]
    })
    const first = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(10)
    const second = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await second
    expect(restart.isHolding()).toBe(false)
    up()
    await first
    expect(log.some((line) => line.includes('ended again before its settings were sent'))).toBe(true)
  })

  it('lets the requests go at the bound when the new service never answers, and still sends the settings when it does', async () => {
    let up: () => void = () => {}
    const sent: string[] = []
    const { recovery, restart, order } = build({
      ready: async () => { await new Promise<void>((resolve) => { up = resolve }) },
      reappliers: [{ name: 'dns', reapply: () => { sent.push('dns'); return 'x' } }]
    })
    const done = recovery.onEnded({ reason: 'killed', exitCode: 9 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(restart.isHolding()).toBe(false)
    expect(order).toContain('ended:timed-out')
    expect(sent).toEqual([])
    up()
    await done
    expect(sent).toEqual(['dns'])
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
      ready: async () => { clock += 40 },
      targets: () => ['default'],
      reappliers: () => [{ name: 'dns', reapply: () => { clock += 3; return 'secure, 1 server' } }, { name: 'nothing', reapply: () => undefined }],
      now: () => clock,
      log: (line) => { log.push(line) },
      holdBegan: () => {}
    })
    await recovery.onEnded({ reason: 'killed', exitCode: 9 })
    expect(log.at(-1)).toBe('[network-service] settings sent again 43 ms after the service ended, answering after 40 ms: dns (secure, 1 server)')
  })

  it('hands the sessions to the wait, so it can ask each of them', async () => {
    const asked: Target[][] = []
    const restart = new NetworkServiceRestart({ now: Date.now, boundMs: 5000, ended: () => {} })
    const recovery = new NetworkServiceRecovery<Target>({
      restart,
      ready: async (targets) => { asked.push([...targets]) },
      targets: () => ['default', 'tunnel'],
      reappliers: () => [],
      now: Date.now,
      log: () => {},
      holdBegan: () => {}
    })
    await recovery.onEnded({ reason: 'killed', exitCode: null })
    expect(asked).toEqual([['default', 'tunnel']])
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
