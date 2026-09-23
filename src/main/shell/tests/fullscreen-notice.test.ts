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

const { createFullscreenNotice } = await import('../fullscreen-notice.js')

const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }

beforeEach(() => {
  vi.useFakeTimers()
  created.length = 0
  contentView.addChildView.mockClear()
  contentView.removeChildView.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('createFullscreenNotice', () => {
  it('shows a centred notice above the page, from a view that cannot run script', () => {
    const notice = createFullscreenNotice(contentView as never, () => 1000)
    notice.show()

    expect(created).toHaveLength(1)
    const view = created[0] as FakeNoticeView
    expect(view.options.webPreferences?.['javascript']).toBe(false)
    expect(view.options.webPreferences?.['sandbox']).toBe(true)
    expect(String(view.webContents.loadURL.mock.calls[0]?.[0])).toMatch(/^data:text\/html/)
    expect(contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 340, y: 24, width: 320, height: 44 })
  })

  it('takes itself down after a few seconds', () => {
    const notice = createFullscreenNotice(contentView as never, () => 1000)
    notice.show()
    vi.advanceTimersByTime(4_000)
    expect(contentView.removeChildView).toHaveBeenCalledTimes(1)
  })

  it('reuses one view across repeated entries, and never stacks it twice', () => {
    const notice = createFullscreenNotice(contentView as never, () => 1000)
    notice.show()
    notice.show()
    notice.hide()
    notice.show()
    expect(created).toHaveLength(1)
    expect(contentView.addChildView).toHaveBeenCalledTimes(2)
  })

  it('re-centres when the window changes width, and only while visible', () => {
    let width = 1000
    const notice = createFullscreenNotice(contentView as never, () => width)
    notice.show()
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
    const notice = createFullscreenNotice(contentView as never, () => 1000)
    notice.show()
    notice.dispose()
    expect((created[0] as FakeNoticeView).webContents.close).toHaveBeenCalledTimes(1)
  })
})
