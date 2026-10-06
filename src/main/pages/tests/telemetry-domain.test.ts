import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../internal-ipc.js'

const runner = {
  getTelemetryStatus: vi.fn(async (): Promise<unknown> => ({ off: undefined, status: { consent: 'undecided', region: 'EU', installId: null, usage: { period: '2026-10' }, sites: { sites: {} }, sent: [{ sentAtMs: 5 }] } })),
  setTelemetryOn: vi.fn(async (_on: boolean, _source: string) => true),
  eraseTelemetry: vi.fn(async () => true)
}
vi.mock('../../../telemetry/runner.js', () => runner)

const { telemetryDomain } = await import('../telemetry-domain.js')

const CALLER = {} as InternalCaller

beforeEach(() => { for (const fn of Object.values(runner)) fn.mockClear() })

describe('the telemetry domain', () => {
  it('shows the choice, the literal reports and what has been sent, with undecided shown as undecided', async () => {
    const reply = await telemetryDomain(false).handle({ type: 'status' }, CALLER)
    expect(reply).toMatchObject({ private: false, consent: 'undecided', installId: null, usage: { period: '2026-10' }, sent: [{ sentAtMs: 5 }] })
  })

  it('says why telemetry is not running when it is not, and offers nothing else', async () => {
    runner.getTelemetryStatus.mockResolvedValueOnce({ off: 'development' })
    expect(await telemetryDomain(false).handle({ type: 'status' }, CALLER)).toEqual({ private: false, off: 'development' })
  })

  it('turns telemetry on or off for the person, with a real boolean and nothing else', async () => {
    const domain = telemetryDomain(false)
    expect(await domain.handle({ type: 'set', on: true }, CALLER)).toEqual({ ok: true })
    expect(await domain.handle({ type: 'set', on: false }, CALLER)).toEqual({ ok: true })
    expect(runner.setTelemetryOn.mock.calls).toEqual([[true, 'settings'], [false, 'settings']])
    for (const on of ['yes', 1, null, undefined, {}]) expect(await domain.handle({ type: 'set', on }, CALLER)).toEqual({ ok: false })
    expect(runner.setTelemetryOn).toHaveBeenCalledTimes(2)
  })

  it('asks for the data to be deleted and reports whether the server confirmed', async () => {
    const domain = telemetryDomain(false)
    expect(await domain.handle({ type: 'erase' }, CALLER)).toEqual({ ok: true })
    runner.eraseTelemetry.mockResolvedValueOnce(false)
    expect(await domain.handle({ type: 'erase' }, CALLER)).toEqual({ ok: false })
  })

  it('has nothing to show and nothing to change in a private session', async () => {
    const domain = telemetryDomain(true)
    expect(await domain.handle({ type: 'status' }, CALLER)).toEqual({ private: true })
    expect(await domain.handle({ type: 'set', on: true }, CALLER)).toBeUndefined()
    expect(await domain.handle({ type: 'erase' }, CALLER)).toBeUndefined()
    for (const fn of Object.values(runner)) expect(fn).not.toHaveBeenCalled()
  })

  it('is for Settings only, and answers nothing else', async () => {
    const domain = telemetryDomain(false)
    expect(domain.pages).toEqual(['settings'])
    expect(await domain.handle({ type: 'send-now' }, CALLER)).toBeUndefined()
    expect(await domain.handle(null, CALLER)).toBeUndefined()
  })
})
