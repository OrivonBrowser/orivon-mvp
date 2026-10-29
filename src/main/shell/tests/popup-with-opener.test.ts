import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { hasOpener, isPageOpenedPopup, watchPopupOpener } from '../popup-with-opener.js'
import type { TabRecord } from '../tab-types.js'

interface FakePopup { view: { webContents: EventEmitter & { opener: unknown } }, record: Pick<TabRecord, 'view' | 'popupWithOpener'>, changed: ReturnType<typeof vi.fn> }

/** A popup as Chromium hands it over: `opener` is what the contents read at that moment. */
function adopted (opener: unknown): FakePopup {
  const view = { webContents: Object.assign(new EventEmitter(), { opener }) }
  const record: FakePopup['record'] = { view: view as never }
  const changed = vi.fn()
  watchPopupOpener(view as never, record, changed)
  return { view, record, changed }
}
const start = (isMainFrame = true): { isMainFrame: boolean } => ({ isMainFrame })

describe('a popup a page opened', () => {
  it('is recorded as soon as it is adopted holding its opener', () => {
    const { view, record, changed } = adopted({})
    expect(record.popupWithOpener).toBe(view)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('is recorded when its first navigation starts if Chromium gave it the opener after the adoption, and stays recorded when the opening page then cuts the link', () => {
    const { view, record, changed } = adopted(null)
    expect(record.popupWithOpener).toBeUndefined()
    view.webContents.opener = {}
    view.webContents.emit('did-start-navigation', start())
    expect(record.popupWithOpener).toBe(view)
    expect(changed).toHaveBeenCalledOnce()
    view.webContents.opener = null
    view.webContents.emit('did-start-navigation', start())
    expect(record.popupWithOpener, 'whatever the opener reads later').toBe(view)
  })

  it('is not recorded when it has none, as a link with a target opens its tab: that implies noopener', () => {
    const { view, record, changed } = adopted(null)
    view.webContents.emit('did-start-navigation', start())
    view.webContents.emit('did-start-navigation', start())
    expect(record.popupWithOpener).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it('is judged on the start of its main frame only, once: a frame inside the page does not settle it', () => {
    const { view, record } = adopted(null)
    view.webContents.opener = {}
    view.webContents.emit('did-start-navigation', start(false))
    expect(record.popupWithOpener).toBeUndefined()
    view.webContents.emit('did-start-navigation', start())
    expect(record.popupWithOpener).toBe(view)
    expect(view.webContents.listenerCount('did-start-navigation'), 'it stops listening').toBe(0)
  })
})

describe('which tabs are a popup a page opened', () => {
  const view = {}
  it('reads the opener the page holds now', () => {
    expect(hasOpener({ opener: { url: 'https://other.example/' } })).toBe(true)
    expect(hasOpener({ opener: null })).toBe(false)
    expect(hasOpener({})).toBe(false)
    expect(isPageOpenedPopup({ view: view as never }, { opener: {} })).toBe(true)
  })

  it('reads the record when the page has cut the link, for as long as the view is the tab\'s', () => {
    expect(isPageOpenedPopup({ view: view as never, popupWithOpener: view as never }, { opener: null })).toBe(true)
    expect(isPageOpenedPopup({ view: {} as never, popupWithOpener: view as never }, { opener: null }), 'the tab shows another view now').toBe(false)
  })

  it('is no tab the browser opened, or one a link with a target opened', () => {
    expect(isPageOpenedPopup({ view: view as never }, { opener: null })).toBe(false)
    expect(isPageOpenedPopup(undefined, undefined)).toBe(false)
  })
})
