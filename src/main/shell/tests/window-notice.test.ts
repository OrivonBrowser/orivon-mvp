import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeNoticeView {
  options: { webPreferences?: Record<string, unknown> }
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  webContents: { loadURL: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>, isDestroyed: () => boolean }
}
const created: FakeNoticeView[] = []

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: FakeNoticeView, options: FakeNoticeView['options']) {
    this.options = options
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
    this.webContents = { loadURL: vi.fn(async () => {}), close: vi.fn(), isDestroyed: () => false }
    created.push(this)
  })
}))

const { createWindowNotice, noticeForWindow, NOTICES } = await import('../window-notice.js')

const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }

/** The page the notice view was last given, decoded. */
function shownHtml (view: FakeNoticeView): string {
  const url = String(view.webContents.loadURL.mock.calls.at(-1)?.[0])
  return decodeURIComponent(url.slice(url.indexOf(',') + 1))
}

beforeEach(() => {
  vi.useFakeTimers()
  created.length = 0
  contentView.addChildView.mockClear()
  contentView.removeChildView.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('createWindowNotice', () => {
  it('shows a centred notice above the page, from a view that cannot run script', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.pointerLock)

    expect(created).toHaveLength(1)
    const view = created[0] as FakeNoticeView
    expect(view.options.webPreferences?.['javascript']).toBe(false)
    expect(view.options.webPreferences?.['sandbox']).toBe(true)
    expect(String(view.webContents.loadURL.mock.calls[0]?.[0])).toMatch(/^data:text\/html/)
    expect(shownHtml(view)).toContain('Press <b>Esc</b> to show your cursor')
    expect(contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 340, y: 24, width: 320, height: 44 })
  })

  it('has one wording for each way a page can take over the screen', () => {
    expect(NOTICES.fullscreen).toBe('Press <b>Esc</b> to exit full screen')
    expect(NOTICES.holdEscToExitFullscreen).toBe('Press and hold <b>Esc</b> to exit full screen')
    expect(NOTICES.pointerLock).toBe('Press <b>Esc</b> to show your cursor')
  })

  it('takes itself down after a few seconds', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    vi.advanceTimersByTime(4_000)
    expect(contentView.removeChildView).toHaveBeenCalledTimes(1)
  })

  // One notice per window, like Chrome's one bubble: a newer message
  // replaces the one on screen rather than stacking a second view over it.
  it('replaces the message on screen, in the same view, and restarts its time', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    vi.advanceTimersByTime(3_000)
    notice.show(NOTICES.holdEscToExitFullscreen)

    expect(created).toHaveLength(1)
    expect(contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(shownHtml(created[0] as FakeNoticeView)).toContain('Press and hold <b>Esc</b> to exit full screen')
    vi.advanceTimersByTime(3_000)
    expect(contentView.removeChildView).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(contentView.removeChildView).toHaveBeenCalledTimes(1)
  })

  it('does not reload the same message', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    notice.show(NOTICES.fullscreen)
    expect((created[0] as FakeNoticeView).webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('reuses one view across repeated showings, and never stacks it twice', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    notice.show(NOTICES.fullscreen)
    notice.hide()
    notice.show(NOTICES.pointerLock)
    expect(created).toHaveLength(1)
    expect(contentView.addChildView).toHaveBeenCalledTimes(2)
  })

  it('re-centres when the window changes width, and only while visible', () => {
    let width = 1000
    const notice = createWindowNotice(contentView as never, () => width)
    notice.show(NOTICES.fullscreen)
    width = 1920
    notice.layout()
    const view = created[0] as FakeNoticeView
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 800, y: 24, width: 320, height: 44 })

    notice.hide()
    view.setBounds.mockClear()
    notice.layout()
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('closes its own webContents on dispose', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    notice.dispose()
    expect((created[0] as FakeNoticeView).webContents.close).toHaveBeenCalledTimes(1)
  })
})

describe('noticeForWindow', () => {
  function fakeWindow (): EventEmitter & { contentView: typeof contentView, getContentBounds: () => { width: number } } {
    return Object.assign(new EventEmitter(), { contentView, getContentBounds: () => ({ width: 1000 }) })
  }

  it('is one notice per window', () => {
    const win = fakeWindow()
    expect(noticeForWindow(win as never)).toBe(noticeForWindow(win as never))
    expect(noticeForWindow(fakeWindow() as never)).not.toBe(noticeForWindow(win as never))
  })

  it('is disposed with its window, and a later window gets a fresh one', () => {
    const win = fakeWindow()
    const notice = noticeForWindow(win as never)
    notice.show(NOTICES.pointerLock)
    win.emit('closed')
    expect((created[0] as FakeNoticeView).webContents.close).toHaveBeenCalledTimes(1)
    expect(noticeForWindow(win as never)).not.toBe(notice)
  })

  it('re-centres after the window is resized', () => {
    const win = fakeWindow()
    let width = 1000
    win.getContentBounds = () => ({ width })
    noticeForWindow(win as never).show(NOTICES.pointerLock)
    width = 1920
    win.emit('resize')
    vi.runOnlyPendingTimers()
    expect((created[0] as FakeNoticeView).setBounds).toHaveBeenLastCalledWith({ x: 800, y: 24, width: 320, height: 44 })
  })
})
