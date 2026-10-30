import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { popupIsAbout, watchArrival } from '../popover-arrival.js'

function page (): EventEmitter {
  return new EventEmitter()
}

describe('watching a page that is still arriving', () => {
  it('reads the page taking the keyboard as its first page committing, when nothing was pressed in it', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    expect(hold.arrivedWithKeyboard()).toBe(false)
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(true)
  })

  it('reads a press in the page before it took the keyboard as the person clicking away', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    tab.emit('input-event', {}, { type: 'mouseDown' })
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(false)
  })

  it('reads a tap in the page before it took the keyboard as the person clicking away, as it reads a click', () => {
    for (const type of ['touchStart', 'gestureTapDown', 'gestureTap', 'pointerDown']) {
      const tab = page()
      const hold = watchArrival(tab as never, vi.fn())
      tab.emit('input-event', {}, { type })
      tab.emit('focus')
      expect(hold.arrivedWithKeyboard(), type).toBe(false)
    }
  })

  it('does not count the page taking the keyboard from the chrome while the popup was still loading, only from the popup', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    tab.emit('focus')
    hold.popupHoldsKeyboard()
    expect(hold.arrivedWithKeyboard()).toBe(false)
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(true)
  })

  it('does not take a key or a move of the pointer in the page for a press', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    tab.emit('input-event', {}, { type: 'mouseMove' })
    tab.emit('input-event', {}, { type: 'keyDown' })
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(true)
  })

  it('ends once, when the page has loaded, is destroyed, or the hold is ended, and listens to nothing after', () => {
    for (const ending of ['did-stop-loading', 'destroyed', 'manual']) {
      const tab = page()
      const onEnd = vi.fn()
      const hold = watchArrival(tab as never, onEnd)
      if (ending === 'manual') hold.end()
      else tab.emit(ending)
      hold.end()
      tab.emit('did-stop-loading')
      expect(onEnd, ending).toHaveBeenCalledTimes(1)
      expect(tab.listenerCount('focus'), ending).toBe(0)
      expect(tab.listenerCount('input-event'), ending).toBe(0)
      tab.emit('focus')
      expect(hold.arrivedWithKeyboard(), ending).toBe(false)
    }
  })
})

describe('whether a popup is still about the first page a tab committed', () => {
  const tabPopup = { tab: 't1', origin: '' }
  const sitePopup = { tab: null, origin: 'https://news.example' }

  it('is so for a popup opened for the tab that arrived, whatever its origin', () => {
    expect(popupIsAbout(tabPopup, { tabId: 't1', origin: 'https://news.example' })).toBe(true)
    expect(popupIsAbout(tabPopup, { tabId: 't1', origin: null })).toBe(true)
  })

  it('is so for a popup opened for the website its tab was loading only when that website arrives: another one (a redirect) leaves the panel about the wrong website', () => {
    const websitePopup = { tab: 't1', origin: '', shown: 'https://news.example' }
    expect(popupIsAbout(websitePopup, { tabId: 't1', origin: 'https://news.example' })).toBe(true)
    expect(popupIsAbout(websitePopup, { tabId: 't1', origin: 'https://other.example' })).toBe(false)
    expect(popupIsAbout(websitePopup, { tabId: 't1', origin: null })).toBe(false)
    expect(popupIsAbout(websitePopup, { tabId: 't2', origin: 'https://news.example' })).toBe(false)
    expect(popupIsAbout({ tab: 't1', origin: '', shown: '' }, { tabId: 't1', origin: 'https://news.example' }), 'a panel drawn for no website is right for whatever arrives, as before').toBe(true)
  })

  it('is not so for a popup opened for another tab', () => {
    expect(popupIsAbout(tabPopup, { tabId: 't2', origin: 'https://news.example' })).toBe(false)
  })

  it('is so for a popup opened for the website that arrived, on any tab', () => {
    expect(popupIsAbout(sitePopup, { tabId: 't1', origin: 'https://news.example' })).toBe(true)
    expect(popupIsAbout(sitePopup, { tabId: 't2', origin: 'https://news.example' })).toBe(true)
  })

  it('is not so for another website, nor for an arrival with no origin, nor for any change that is no first page', () => {
    expect(popupIsAbout(sitePopup, { tabId: 't1', origin: 'https://other.example' })).toBe(false)
    expect(popupIsAbout({ tab: null, origin: '' }, { tabId: 't1', origin: null })).toBe(false)
    expect(popupIsAbout(sitePopup, null)).toBe(false)
    expect(popupIsAbout(tabPopup, null)).toBe(false)
  })
})
