import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { UpdateOffer } from '../update-notice.js'
import { answerOfOffer, updatesDomain } from '../updates-domain.js'

const CALLER = {} as InternalCaller
const OFFER: UpdateOffer = { current: '1.0.0', latest: 'v1.1.0', url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.1.0', pending: true }
const ANSWER = { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'https://github.com/x/y/releases/tag/v1.1.0' }

describe('the updates domain', () => {
  it('looks when asked and says what it found', async () => {
    const check = vi.fn(async () => ANSWER)
    expect(await updatesDomain(check, false).handle({ type: 'check' }, CALLER)).toEqual({ ok: true, answer: ANSWER })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('looks at nothing in a private session', async () => {
    const check = vi.fn(async () => ANSWER)
    expect(await updatesDomain(check, true).handle({ type: 'check' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(check).not.toHaveBeenCalled()
  })

  it('looks at nothing in a Store install, and opens no release page, since the Store delivers updates', async () => {
    const check = vi.fn(async () => ANSWER)
    const open = vi.fn()
    const domain = updatesDomain(check, false, () => {}, open, true)
    expect(await domain.handle({ type: 'check' }, CALLER)).toEqual({ ok: false, reason: 'store' })
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'store' })
    expect(check).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('is for Settings only, and answers nothing else', async () => {
    const domain = updatesDomain(async () => ANSWER, false)
    expect(domain.pages).toEqual(['settings'])
    expect(await domain.handle({ type: 'install' }, CALLER)).toBeUndefined()
    expect(await domain.handle(null, CALLER)).toBeUndefined()
  })

  it('opens the page of the release on offer, in the window that asked, whichever look found it', async () => {
    const open = vi.fn()
    const domain = updatesDomain(async () => ANSWER, false, () => {}, open, false, () => OFFER)
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(CALLER, 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.1.0')
  })

  it('opens nothing while no newer release is on offer, and follows the offer as it changes', async () => {
    const open = vi.fn()
    let offer: UpdateOffer | null = null
    const domain = updatesDomain(async () => ANSWER, false, () => {}, open, false, () => offer)
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    offer = OFFER
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: true })
    offer = null
    expect(await domain.handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'none' })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('answers what is on offer as a look would, and nothing when nothing is', async () => {
    let offer: UpdateOffer | null = OFFER
    const domain = updatesDomain(async () => ANSWER, false, () => {}, () => {}, false, () => offer)
    expect(await domain.handle({ type: 'state' }, CALLER)).toEqual({ ok: true, answer: { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: OFFER.url } })
    offer = null
    expect(await domain.handle({ type: 'state' }, CALLER)).toEqual({ ok: true, answer: null })
    expect(answerOfOffer(null)).toBeNull()
  })

  it('has nothing to say in a private session or a Store install when asked what is on offer, and does not look', async () => {
    const check = vi.fn(async () => ANSWER)
    expect(await updatesDomain(check, true, () => {}, () => {}, false, () => OFFER).handle({ type: 'state' }, CALLER)).toEqual({ ok: true, answer: null })
    expect(await updatesDomain(check, false, () => {}, () => {}, true, () => OFFER).handle({ type: 'state' }, CALLER)).toEqual({ ok: true, answer: null })
    expect(check).not.toHaveBeenCalled()
  })

  it('opens nothing in a private session', async () => {
    const open = vi.fn()
    expect(await updatesDomain(async () => ANSWER, true, () => {}, open).handle({ type: 'openRelease' }, CALLER)).toEqual({ ok: false, reason: 'private' })
    expect(open).not.toHaveBeenCalled()
  })
})
