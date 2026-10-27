import { describe, expect, it, vi } from 'vitest'
import type { AskPlace } from '../../os/install-default-browser-ask.js'
import type { AskQuestion } from '../../shell/question/ask-question.js'
import { askInWindow, updatePlace } from '../update-window.js'

const RELEASE = { version: 'v0.0.12', url: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.12' }

function placeIn (over: { fullScreen?: boolean, htmlFullScreen?: boolean, destroyed?: boolean } = {}) {
  const createTab = vi.fn()
  const place = {
    window: {
      window: { isFullScreen: () => over.fullScreen === true, isDestroyed: () => over.destroyed === true },
      shortcutsSuspended: () => over.htmlFullScreen === true,
      tabs: { createTab }
    },
    tabId: 't1'
  } as unknown as AskPlace
  return { place, createTab }
}

describe('where the update question may be asked', () => {
  const windows = {} as never

  it('asks in the window in use', () => {
    const { place } = placeIn()
    expect(updatePlace(windows, false, () => place)).toEqual({ place })
  })

  it('waits, and says why, while no window is in use', () => {
    const result = updatePlace(windows, false, () => undefined)
    expect(result).toEqual({ waiting: expect.stringContaining('no window is in use') })
  })

  it('never interrupts a full-screen window, nor a page holding the screen', () => {
    expect(updatePlace(windows, false, () => placeIn({ fullScreen: true }).place)).toEqual({ waiting: 'the window is full screen' })
    expect(updatePlace(windows, false, () => placeIn({ htmlFullScreen: true }).place)).toEqual({ waiting: 'the window is full screen' })
  })

  it('does not even look for a window in a kiosk', () => {
    const look = vi.fn(() => placeIn().place)
    expect(updatePlace(windows, true, look)).toEqual({ waiting: 'this is a kiosk' })
    expect(look).not.toHaveBeenCalled()
  })
})

describe('asking about a release in a window', () => {
  const answering = (response: number, clicked?: true): AskQuestion => vi.fn(async () => ({ response, checkboxChecked: false, ...(clicked === true ? { clicked } : {}) }))

  it('asks in that window and tab, with the version shown without its v', async () => {
    const { place } = placeIn()
    const ask = answering(1, true)
    await askInWindow(place, RELEASE, '0.0.11', () => {}, ask)
    const [target, spec] = (ask as ReturnType<typeof vi.fn>).mock.calls[0] as [{ window: unknown, tabId: string }, { title: string, message: string, buttons: string[] }]
    expect(target).toEqual({ window: place.window, tabId: 't1' })
    expect(spec).toMatchObject({ title: 'Orivon 0.0.12 is available', message: 'You have 0.0.11.', buttons: ['Download from GitHub', 'Not now'] })
  })

  it('opens the release page in a tab of that window when the person asks for it', async () => {
    const { place, createTab } = placeIn()
    const log = vi.fn()
    await askInWindow(place, RELEASE, '0.0.11', log, answering(0, true))
    expect(createTab).toHaveBeenCalledWith(RELEASE.url)
    expect(log).toHaveBeenCalledWith('answer: the release page')
  })

  it('opens nothing on Not now, nor on a way out, and tells the two apart in the log', async () => {
    const notNow = placeIn()
    const logA = vi.fn()
    await askInWindow(notNow.place, RELEASE, '0.0.11', logA, answering(1, true))
    expect(notNow.createTab).not.toHaveBeenCalled()
    expect(logA).toHaveBeenCalledWith('answer: not now')
    const closed = placeIn()
    const logB = vi.fn()
    await askInWindow(closed.place, RELEASE, '0.0.11', logB, answering(1))
    expect(closed.createTab).not.toHaveBeenCalled()
    expect(logB).toHaveBeenCalledWith('answer: closed without a choice')
  })

  it('opens nothing in a window that was closed meanwhile', async () => {
    const { place, createTab } = placeIn({ destroyed: true })
    await askInWindow(place, RELEASE, '0.0.11', () => {}, answering(0, true))
    expect(createTab).not.toHaveBeenCalled()
  })
})
