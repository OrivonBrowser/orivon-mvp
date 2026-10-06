import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachHistory, historyAddress } from '../attach-history.js'
import type { HistoryService } from '../history-service.js'

class FakeContents extends EventEmitter {
  url = 'https://a.example/'
  title = 'Title'
  destroyed = false
  getURL (): string { return this.url }
  getTitle (): string { return this.title }
  isDestroyed (): boolean { return this.destroyed }
}

function attached (recordable = true): { contents: FakeContents, visit: ReturnType<typeof vi.fn>, titled: ReturnType<typeof vi.fn> } {
  const contents = new FakeContents()
  const visit = vi.fn()
  const titled = vi.fn()
  attachHistory(contents as unknown as WebContents, { visit, titled } as unknown as HistoryService, { recordable: () => recordable })
  return { contents, visit, titled }
}

describe('historyAddress', () => {
  it('keeps the addresses a person could open again, and shows a protocol address as the person typed it', () => {
    expect(historyAddress('https://a.example/x?y=1#z')).toBe('https://a.example/x?y=1#z')
    expect(historyAddress('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
  })

  it('keeps a local file by its path, as the page the person could open again', () => {
    expect(historyAddress('file:///home/x/notes/page.html?q=1#top')).toBe('file:///home/x/notes/page.html?q=1#top')
  })

  it('refuses a page that is not one', () => {
    for (const url of ['file://nas/share/page.html', 'file:////nas/share/page.html', 'about:blank', 'orivon://settings/', 'chrome-error://chromewebdata/', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://a.example/1', 'not a url', '']) {
      expect(historyAddress(url), url).toBeNull()
    }
  })
})

describe('attachHistory', () => {
  it('records a page a tab reaches, with the title it has by then', () => {
    const { contents, visit } = attached()
    contents.emit('did-navigate', {}, 'https://a.example/page', 200)
    expect(visit).toHaveBeenCalledExactlyOnceWith('https://a.example/page', 'Title')
  })

  it('records a change of address within a page, but not one inside a frame', () => {
    const { contents, visit } = attached()
    contents.emit('did-navigate-in-page', {}, 'https://a.example/#/route', true)
    contents.emit('did-navigate-in-page', {}, 'https://ads.example/frame', false)
    expect(visit).toHaveBeenCalledExactlyOnceWith('https://a.example/#/route', 'Title')
  })

  it('records a change of address inside a page no more than once a second, so a page cannot fill the list', () => {
    const contents = new FakeContents()
    const visit = vi.fn()
    const clock = { now: 10_000 }
    attachHistory(contents as unknown as WebContents, { visit, titled: vi.fn() } as unknown as HistoryService, { recordable: () => true }, () => clock.now)

    for (let n = 0; n < 500; n += 1) {
      clock.now += 2
      contents.emit('did-navigate-in-page', {}, `https://a.example/#${String(n)}`, true)
    }
    expect(visit).toHaveBeenCalledTimes(1)

    clock.now += 1000
    contents.emit('did-navigate-in-page', {}, 'https://a.example/#later', true)
    contents.emit('did-navigate', {}, 'https://a.example/real', 200)
    expect(visit).toHaveBeenCalledTimes(3)
  })

  it('records a page that reloads itself once, while the person going back to it later is a new visit', () => {
    const contents = new FakeContents()
    const visit = vi.fn()
    const clock = { now: 10_000 }
    attachHistory(contents as unknown as WebContents, { visit, titled: vi.fn() } as unknown as HistoryService, { recordable: () => true }, () => clock.now)
    for (let n = 0; n < 100; n += 1) {
      clock.now += 5000
      contents.emit('did-navigate', {}, 'https://status.example/board', 200)
    }
    expect(visit).toHaveBeenCalledTimes(1)
    contents.emit('did-navigate', {}, 'https://status.example/other', 200)
    contents.emit('did-navigate', {}, 'https://status.example/board', 200)
    expect(visit).toHaveBeenCalledTimes(3)
    clock.now += 31 * 60_000
    contents.emit('did-navigate', {}, 'https://status.example/board', 200)
    expect(visit).toHaveBeenCalledTimes(4)
  })

  it('does not record an error page, a page that is not one to return to, or one in no tab', () => {
    const { contents, visit } = attached()
    contents.emit('did-navigate', {}, 'https://a.example/missing', 404)
    contents.emit('did-navigate', {}, 'https://a.example/error', 500)
    contents.emit('did-navigate', {}, 'chrome-error://chromewebdata/', 0)
    contents.emit('did-navigate', {}, 'file://nas/dashboard/index.html', 0)
    expect(visit).not.toHaveBeenCalled()

    const shell = attached(false)
    shell.contents.emit('did-navigate', {}, 'https://a.example/', 200)
    shell.contents.emit('page-title-updated', {}, 'New title')
    expect(shell.visit).not.toHaveBeenCalled()
    expect(shell.titled).not.toHaveBeenCalled()
  })

  it('records a load that had no response, as a cached page does', () => {
    const { contents, visit } = attached()
    contents.emit('did-navigate', {}, 'https://a.example/cached', 0)
    expect(visit).toHaveBeenCalledTimes(1)
  })

  it('gives the page its title when it settles on one', () => {
    const { contents, titled } = attached()
    contents.url = 'https://a.example/page'
    contents.emit('page-title-updated', {}, 'Settled')
    expect(titled).toHaveBeenCalledExactlyOnceWith('https://a.example/page', 'Settled')
  })

  it('does nothing once the page is gone', () => {
    const { contents, visit, titled } = attached()
    contents.destroyed = true
    contents.emit('did-navigate', {}, 'https://a.example/', 200)
    contents.emit('page-title-updated', {}, 'Late')
    expect(visit).not.toHaveBeenCalled()
    expect(titled).not.toHaveBeenCalled()
  })

  it('keeps the first five title changes of a page and starts counting again on the next one', () => {
    const { contents, titled } = attached()
    contents.emit('did-navigate', {}, 'https://a.example/inbox', 200)
    for (let i = 1; i <= 8; i++) contents.emit('page-title-updated', {}, `(${i}) Inbox`)
    expect(titled.mock.calls.map((call) => call[1])).toEqual(['(1) Inbox', '(2) Inbox', '(3) Inbox', '(4) Inbox', '(5) Inbox'])
    contents.emit('did-navigate', {}, 'https://a.example/sent', 200)
    contents.emit('page-title-updated', {}, 'Sent')
    expect(titled).toHaveBeenLastCalledWith('https://a.example/', 'Sent')
    expect(titled).toHaveBeenCalledTimes(6)
  })
})
