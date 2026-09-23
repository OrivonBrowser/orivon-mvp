import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeNoticeView {
  options: { webPreferences?: Record<string, unknown> }
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  webContents: EventEmitter & { loadURL: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>, isDestroyed: () => boolean }
}
const created: FakeNoticeView[] = []

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    WebContentsView: vi.fn().mockImplementation(function (this: FakeNoticeView, options: FakeNoticeView['options']) {
      this.options = options
      this.setBounds = vi.fn()
      this.setBackgroundColor = vi.fn()
      this.webContents = Object.assign(new Emitter(), { loadURL: vi.fn(async () => {}), close: vi.fn(), isDestroyed: () => false })
      created.push(this)
    })
  }
})

/** Its page finished loading, as Electron reports it. */
function finishLoad (view: FakeNoticeView | undefined): void {
  view?.webContents.emit('did-finish-load')
}

/** Shows `text` and lets its page load, the way a real notice appears. */
function showLoaded (notice: { show: (text: never) => void }, text: string): void {
  const before = created.length
  notice.show(text as never)
  for (const view of created.slice(before)) finishLoad(view)
}

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
    showLoaded(notice, NOTICES.pointerLock)

    expect(created).toHaveLength(1)
    const view = created[0] as FakeNoticeView
    expect(view.options.webPreferences?.['javascript']).toBe(false)
    expect(view.options.webPreferences?.['sandbox']).toBe(true)
    expect(String(view.webContents.loadURL.mock.calls[0]?.[0])).toMatch(/^data:text\/html/)
    expect(shownHtml(view)).toContain('Press <b>Esc</b> to show your cursor')
    expect(contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 340, y: 24, width: 320, height: 44 })
  })

  // Measured: a view that navigates while attached to the window takes
  // focus from the page under it, which ends a pointer lock the moment it
  // begins and sends a fullscreen page's keys to the notice.
  it('loads its page before attaching it, so it never takes focus from the page', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.pointerLock)
    const view = created[0] as FakeNoticeView
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(contentView.addChildView).not.toHaveBeenCalled()

    finishLoad(view)
    expect(contentView.addChildView).toHaveBeenCalledWith(view)
  })

  it('has one wording for each way a page can take over the screen', () => {
    expect(NOTICES.fullscreen).toBe('Press <b>Esc</b> to exit full screen')
    expect(NOTICES.holdEscToExitFullscreen).toBe('Press and hold <b>Esc</b> to exit full screen')
    expect(NOTICES.pointerLock).toBe('Press <b>Esc</b> to show your cursor')
  })

  it('takes itself down after a few seconds', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    showLoaded(notice, NOTICES.fullscreen)
    vi.advanceTimersByTime(4_000)
    expect(contentView.removeChildView).toHaveBeenCalledTimes(1)
  })

  it('never appears if it is hidden before its page loads', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    notice.show(NOTICES.fullscreen)
    notice.hide()
    finishLoad(created[0])
    expect(contentView.addChildView).not.toHaveBeenCalled()
  })

  // One notice per window, like Chrome's one bubble: a newer message
  // replaces the one on screen rather than stacking over it. Each message
  // has its own view, loaded before it is attached, since navigating the
  // attached one would take focus.
  it('replaces the message on screen, and restarts its time', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    showLoaded(notice, NOTICES.fullscreen)
    vi.advanceTimersByTime(3_000)
    showLoaded(notice, NOTICES.holdEscToExitFullscreen)

    const [first, second] = created as [FakeNoticeView, FakeNoticeView]
    expect(shownHtml(second)).toContain('Press and hold <b>Esc</b> to exit full screen')
    expect(contentView.removeChildView).toHaveBeenCalledWith(first)
    expect(contentView.addChildView).toHaveBeenLastCalledWith(second)
    expect(first.webContents.loadURL).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3_000)
    expect(contentView.removeChildView).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(contentView.removeChildView).toHaveBeenLastCalledWith(second)
  })

  it('keeps the message on screen until the next one has loaded', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    showLoaded(notice, NOTICES.fullscreen)
    notice.show(NOTICES.holdEscToExitFullscreen)
    expect(contentView.removeChildView).not.toHaveBeenCalled()
    finishLoad(created[1])
    expect(contentView.removeChildView).toHaveBeenCalledWith(created[0])
  })

  it('loads each message once, and never stacks a view twice', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    showLoaded(notice, NOTICES.fullscreen)
    notice.show(NOTICES.fullscreen)
    notice.hide()
    notice.show(NOTICES.fullscreen)
    expect(created).toHaveLength(1)
    expect((created[0] as FakeNoticeView).webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(contentView.addChildView).toHaveBeenCalledTimes(2)
  })

  it('re-centres when the window changes width, and only while visible', () => {
    let width = 1000
    const notice = createWindowNotice(contentView as never, () => width)
    showLoaded(notice, NOTICES.fullscreen)
    width = 1920
    notice.layout()
    const view = created[0] as FakeNoticeView
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 800, y: 24, width: 320, height: 44 })

    notice.hide()
    view.setBounds.mockClear()
    notice.layout()
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('closes every view it made on dispose', () => {
    const notice = createWindowNotice(contentView as never, () => 1000)
    showLoaded(notice, NOTICES.fullscreen)
    showLoaded(notice, NOTICES.pointerLock)
    notice.dispose()
    for (const view of created) expect(view.webContents.close).toHaveBeenCalledTimes(1)
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
    showLoaded(notice, NOTICES.pointerLock)
    win.emit('closed')
    expect((created[0] as FakeNoticeView).webContents.close).toHaveBeenCalledTimes(1)
    expect(noticeForWindow(win as never)).not.toBe(notice)
  })

  it('re-centres after the window is resized', () => {
    const win = fakeWindow()
    let width = 1000
    win.getContentBounds = () => ({ width })
    showLoaded(noticeForWindow(win as never), NOTICES.pointerLock)
    width = 1920
    win.emit('resize')
    vi.runOnlyPendingTimers()
    expect((created[0] as FakeNoticeView).setBounds).toHaveBeenLastCalledWith({ x: 800, y: 24, width: 320, height: 44 })
  })
})
