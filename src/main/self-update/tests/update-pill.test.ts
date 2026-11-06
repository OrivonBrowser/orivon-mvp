import { describe, expect, it, vi } from 'vitest'
import { newTabUpdate, updatePillOf } from '../update-pill.js'
import type { UpdatePillSettings } from '../update-pill.js'
import type { UpdateNotice, UpdateOffer } from '../update-notice.js'

const OFFER: UpdateOffer = { current: '0.0.11', latest: 'v0.0.12', url: 'https://example.invalid/', pending: true }

describe('what the update button shows', () => {
  it('names both versions without the tag\'s v, whether or not the person was told', () => {
    expect(updatePillOf(OFFER, true, false)).toEqual({ latest: '0.0.12', current: '0.0.11' })
    expect(updatePillOf({ ...OFFER, pending: false }, true, false)).toEqual({ latest: '0.0.12', current: '0.0.11' })
    expect(updatePillOf({ ...OFFER, latest: '0.0.12' }, true, false)).toEqual({ latest: '0.0.12', current: '0.0.11' })
  })

  it('shows nothing with no release on offer', () => {
    expect(updatePillOf(null, true, false)).toBeNull()
  })

  it('shows nothing while the person has switched the look off', () => {
    expect(updatePillOf(OFFER, false, false)).toBeNull()
  })

  it('shows nothing in a kiosk, which is told through Settings only', () => {
    expect(updatePillOf(OFFER, true, true)).toBeNull()
  })
})

function setup (init: { offer?: UpdateOffer | null, checkOn?: boolean, kiosk?: boolean } = {}) {
  let offer: UpdateOffer | null = 'offer' in init ? init.offer ?? null : OFFER
  let checkOn = init.checkOn ?? true
  let noticeListener: (offer: UpdateOffer | null) => void = () => {}
  let settingListener: (change: { key: string }) => void = () => {}
  const stopNotice = vi.fn()
  const stopSetting = vi.fn()
  const askAgain = vi.fn(async () => {})
  const notice: Pick<UpdateNotice, 'offer' | 'onChange' | 'askAgain'> = {
    offer: () => offer,
    onChange: (listener) => { noticeListener = listener; return stopNotice },
    askAgain
  }
  const settings: UpdatePillSettings = {
    get: () => checkOn,
    onChange: (listener) => { settingListener = listener; return stopSetting }
  }
  return {
    update: newTabUpdate(notice, settings, init.kiosk ?? false),
    askAgain,
    stopNotice,
    stopSetting,
    offerIs: (next: UpdateOffer | null): void => { offer = next; noticeListener(next) },
    checkIs: (next: boolean): void => { checkOn = next; settingListener({ key: 'updates.check' }) },
    settingChanged: (key: string): void => { settingListener({ key }) }
  }
}

describe('the update button\'s source', () => {
  it('answers what is shown now', () => {
    expect(setup().update.shown()).toEqual({ latest: '0.0.12', current: '0.0.11' })
    expect(setup({ offer: null }).update.shown()).toBeNull()
    expect(setup({ kiosk: true }).update.shown()).toBeNull()
  })

  it('tells its listener when a release is found, and when the running version catches up', () => {
    const s = setup({ offer: null })
    const heard = vi.fn()
    s.update.onChange(heard)
    s.offerIs(OFFER)
    expect(heard).toHaveBeenCalledTimes(1)
    s.offerIs(null)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when the release only went from not told to told, which the button does not show', () => {
    const s = setup()
    const heard = vi.fn()
    s.update.onChange(heard)
    s.offerIs({ ...OFFER, pending: false })
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells its listener when the look is switched off and on, and for no other setting', () => {
    const s = setup()
    const heard = vi.fn()
    s.update.onChange(heard)
    s.settingChanged('appearance.theme')
    expect(heard).not.toHaveBeenCalled()
    s.checkIs(false)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(s.update.shown()).toBeNull()
    s.checkIs(true)
    expect(heard).toHaveBeenCalledTimes(2)
    expect(s.update.shown()).toEqual({ latest: '0.0.12', current: '0.0.11' })
  })

  it('stops both subscriptions when asked', () => {
    const s = setup()
    s.update.onChange(() => {})()
    expect(s.stopNotice).toHaveBeenCalledTimes(1)
    expect(s.stopSetting).toHaveBeenCalledTimes(1)
  })

  it('asks the notice again on a press, without waiting for the answer', () => {
    const s = setup()
    expect(s.update.ask()).toBeUndefined()
    expect(s.askAgain).toHaveBeenCalledTimes(1)
  })
})
