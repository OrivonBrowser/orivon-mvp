import { describe, expect, it, vi } from 'vitest'
import { pdfCommand, pipCommand, printCommand, saveCommand, screenshotCommand, viewSourceCommand } from '../page-commands.js'
import { fakeDeps, fakeWindow } from './support.js'

function windowWith (wc: unknown, url = 'https://a.example/'): ReturnType<typeof fakeWindow> & { openTrusted: ReturnType<typeof vi.fn> } {
  const openTrusted = vi.fn(() => ['n', {}])
  const made = fakeWindow({
    tabs: {
      activeWebContents: () => wc,
      getState: () => ({ tabs: [{ id: 't', title: 'T', url }], activeTabId: 't' }),
      record: () => ({ partition: undefined, internalPage: null, isDashboardTab: false }),
      openTrusted,
      moveTab: vi.fn()
    }
  })
  return { ...made, openTrusted }
}

const live = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ isDestroyed: () => false, getURL: () => 'https://a.example/', isCrashed: () => false, ...extra })

describe('the page commands', () => {
  it('do nothing in a window with no page, and never throw', async () => {
    const { window, show } = windowWith(undefined)
    const deps = fakeDeps()
    await printCommand(window)
    await pdfCommand(window, deps)
    await saveCommand(window, deps)
    await viewSourceCommand(window)
    await screenshotCommand(window)
    await pipCommand(window)
    expect(show).not.toHaveBeenCalled()
    expect(deps.pickSave).not.toHaveBeenCalled()
  })

  it('print goes to the active page', async () => {
    const print = vi.fn()
    const { window } = windowWith(live({ getPrintersAsync: async () => [{}], print }))
    await printCommand(window)
    expect(print).toHaveBeenCalled()
  })

  it('save as PDF asks for the page\'s title as the file name', async () => {
    const { window } = windowWith(live({ printToPDF: async () => new Uint8Array(1) }))
    const deps = fakeDeps()
    await pdfCommand(window, deps)
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({ defaultPath: '/home/me/Downloads/T.pdf' }))
  })

  it('screenshot toggles its sheet, so the key closes it again', async () => {
    const { window } = windowWith(live())
    await screenshotCommand(window)
    expect(window.overlays.toggle).toHaveBeenCalledWith('screenshot')
  })

  it('view source opens the page\'s address', async () => {
    const { window, openTrusted } = windowWith(live())
    await viewSourceCommand(window)
    expect(openTrusted).toHaveBeenCalledWith('view-source:https://a.example/')
  })

  it('view source says so when the page has no source to show, instead of doing nothing', async () => {
    const { window, openTrusted, toasts } = windowWith(live({ getURL: () => 'orivon://settings/' }))
    await viewSourceCommand(window)
    expect(openTrusted).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['noSource'])
  })

  it('picture in picture says there is no video when no frame has one', async () => {
    const { window, toasts } = windowWith(live({ mainFrame: { framesInSubtree: [{ executeJavaScript: async () => false }] } }))
    await pipCommand(window)
    expect(toasts()).toEqual(['noVideo'])
  })

  it('a failure ends in the log, not as a rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window } = windowWith(live({ getPrintersAsync: () => { throw new Error('sync') } }))
    await expect(printCommand(window)).resolves.toBeUndefined()
  })
})
