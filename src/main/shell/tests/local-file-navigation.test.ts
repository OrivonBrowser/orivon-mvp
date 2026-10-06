import { describe, expect, it, vi } from 'vitest'
import { fileNavigationFor, watchFileNavigation } from '../local-file-navigation.js'

const page = 'file:///home/u/notes/index.html'
const sibling = 'file:///home/u/notes/other.html'
const web = 'https://example.com/'

describe('fileNavigationFor', () => {
  it('lets a local page go to another local file, which the session fence then places', () => {
    expect(fileNavigationFor({ target: sibling, current: page, isMainFrame: true, byPage: true })).toBe('allow')
  })

  it('opens a file the person dropped on a page that is not a local file, as a local file', () => {
    expect(fileNavigationFor({ target: sibling, current: web, isMainFrame: true, byPage: false })).toBe('open')
    expect(fileNavigationFor({ target: sibling, current: '', isMainFrame: true, byPage: false })).toBe('open')
  })

  it('refuses a page that is not a local file when a page, not the person, started the navigation', () => {
    expect(fileNavigationFor({ target: sibling, current: web, isMainFrame: true, byPage: true })).toBe('refuse')
  })

  it('refuses a file address with a host or a share, from anywhere', () => {
    expect(fileNavigationFor({ target: 'file://server/share/a.html', current: page, isMainFrame: true, byPage: true })).toBe('refuse')
    expect(fileNavigationFor({ target: 'file://server/share/a.html', current: web, isMainFrame: true, byPage: false })).toBe('refuse')
    expect(fileNavigationFor({ target: 'file:////server/share/a.html', current: web, isMainFrame: true, byPage: false })).toBe('refuse')
  })

  it.each([
    ['a web address', web, true],
    ['a frame', sibling, false]
  ])('has no say about %s', (_name, target, isMainFrame) => {
    expect(fileNavigationFor({ target, current: page, isMainFrame, byPage: true })).toBe('ignore')
  })
})

describe('watchFileNavigation', () => {
  function listen (current: string) {
    let handler: ((event: { url: string, isMainFrame: boolean, initiator?: unknown, preventDefault: () => void }) => void) | undefined
    const wc = { on: (_name: string, listener: typeof handler) => { handler = listener }, getURL: () => current }
    const opened = vi.fn()
    watchFileNavigation(wc as never, opened)
    return { opened, send: (event: { url: string, initiator?: unknown }) => {
      const preventDefault = vi.fn()
      handler?.({ isMainFrame: true, preventDefault, ...event })
      return preventDefault
    } }
  }

  it('prevents a dropped file\'s navigation and opens it as a local file', () => {
    const { opened, send } = listen(web)
    expect(send({ url: sibling, initiator: null })).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledExactlyOnceWith(sibling)
  })

  it('prevents a page\'s own navigation to a file and opens nothing', () => {
    const { opened, send } = listen(web)
    expect(send({ url: sibling, initiator: {} })).toHaveBeenCalledOnce()
    expect(opened).not.toHaveBeenCalled()
  })

  it('leaves a local page\'s link to a sibling alone', () => {
    const { opened, send } = listen(page)
    expect(send({ url: sibling, initiator: {} })).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  })
})
