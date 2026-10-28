import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETRY_MS } from '../../os/install-default-browser-ask.js'
import { installUpdateNotice } from '../install-update-notice.js'
import type { UpdateNotice, UpdateOffer } from '../update-notice.js'

const PENDING: UpdateOffer = { current: '0.0.11', latest: 'v0.0.12', url: 'https://example.invalid/', pending: true }

function installed (over: { tryAsk: () => Promise<void>, kiosk?: boolean }) {
  let offer: UpdateOffer | null = PENDING
  let listener: (offer: UpdateOffer | null) => void = () => {}
  const tryAsk = vi.fn(over.tryAsk)
  const notice = {
    offer: () => offer,
    tryAsk,
    runScheduled: vi.fn(async () => {}),
    onChange: (next: (offer: UpdateOffer | null) => void) => { listener = next; return () => {} }
  } as unknown as UpdateNotice
  const services = { browserUpdate: notice, kiosk: over.kiosk === true, settings: { get: () => true, onChange: () => () => {} } }
  installUpdateNotice.install({ once: () => {} } as never, services as never, {} as never, { isPrivate: false } as never)
  return {
    tryAsk,
    changeTo: (next: UpdateOffer | null) => { offer = next; listener(next) }
  }
}

describe('the update notice installer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('retries the question while a release waits, and a retry that rejects is logged instead of ending the browser', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = installed({ tryAsk: async () => { throw new Error('Object has been destroyed') } })
    r.changeTo(PENDING)
    await vi.advanceTimersByTimeAsync(2 * RETRY_MS)
    expect(r.tryAsk).toHaveBeenCalledTimes(2)
    expect(logged).toHaveBeenCalledWith('[self-update] the question failed:', expect.any(Error))
  })

  it('stops retrying once the release is told, and never retries in a kiosk', async () => {
    const r = installed({ tryAsk: async () => {} })
    r.changeTo(PENDING)
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(r.tryAsk).toHaveBeenCalledTimes(1)
    r.changeTo({ ...PENDING, pending: false })
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS)
    expect(r.tryAsk).toHaveBeenCalledTimes(1)

    const kiosk = installed({ tryAsk: async () => {}, kiosk: true })
    kiosk.changeTo(PENDING)
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS)
    expect(kiosk.tryAsk).not.toHaveBeenCalled()
  })
})
