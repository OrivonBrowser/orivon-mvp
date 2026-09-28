import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type { InternalCaller } from '../internal-ipc.js'

const runner = {
  getConsentState: vi.fn(async () => 'undecided'),
  previewDisclosurePayload: vi.fn(async () => ({ installId: 'i', country: 'XX', version: '1', period: '2026-09', perApp: {} })),
  getSentHistory: vi.fn(async () => ({ entries: [{ payload: { installId: 'i' }, sentAtMs: 5 }] })),
  decideConsent: vi.fn(async (_app: unknown, _option: string) => {})
}
vi.mock('../../../telemetry/runner.js', () => runner)

const { telemetryDomain } = await import('../telemetry-domain.js')

const APP = {} as App
const CALLER = {} as InternalCaller

beforeEach(() => { for (const fn of Object.values(runner)) fn.mockClear() })

describe('the telemetry domain', () => {
  it('shows the choice, the literal payload and what has been sent, with the two options and neither chosen for the person', async () => {
    const reply = await telemetryDomain(APP, false).handle({ type: 'status' }, CALLER) as Record<string, unknown>
    expect(reply).toMatchObject({ private: false, consent: 'undecided', payload: { installId: 'i' }, sent: [{ sentAtMs: 5 }] })
    expect(reply['options']).toEqual([
      { id: 'keep-on', label: 'Keep on', resultingState: 'accepted' },
      { id: 'turn-off', label: 'Turn off', resultingState: 'declined' }
    ])
  })

  it('records the choice the person made, and only one of the two that exist', async () => {
    const domain = telemetryDomain(APP, false)
    expect(await domain.handle({ type: 'decide', option: 'keep-on' }, CALLER)).toEqual({ ok: true })
    expect(await domain.handle({ type: 'decide', option: 'turn-off' }, CALLER)).toEqual({ ok: true })
    expect(runner.decideConsent.mock.calls.map((call) => call[1])).toEqual(['keep-on', 'turn-off'])
    for (const option of ['everything', '', 7, null, { id: 'keep-on' }]) expect(await domain.handle({ type: 'decide', option }, CALLER)).toEqual({ ok: false })
    expect(runner.decideConsent).toHaveBeenCalledTimes(2)
  })

  it('has nothing to show and nothing to decide in a private session', async () => {
    const domain = telemetryDomain(APP, true)
    expect(await domain.handle({ type: 'status' }, CALLER)).toEqual({ private: true })
    expect(await domain.handle({ type: 'decide', option: 'keep-on' }, CALLER)).toBeUndefined()
    expect(runner.decideConsent).not.toHaveBeenCalled()
    expect(runner.getConsentState).not.toHaveBeenCalled()
  })

  it('is for Settings only, and answers nothing else', async () => {
    const domain = telemetryDomain(APP, false)
    expect(domain.pages).toEqual(['settings'])
    expect(await domain.handle({ type: 'send-now' }, CALLER)).toBeUndefined()
    expect(await domain.handle(null, CALLER)).toBeUndefined()
  })
})
