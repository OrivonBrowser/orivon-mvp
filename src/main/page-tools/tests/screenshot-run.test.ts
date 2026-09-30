import { describe, expect, it, vi } from 'vitest'
import type { CaptureContents } from '../screenshot.js'
import { MAX_FULL_PAGE_PIXELS } from '../screenshot.js'
import { takeScreenshot } from '../screenshot-run.js'
import { fakeDeps, fakeWindow } from './support.js'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function contents (over: Partial<CaptureContents> = {}): CaptureContents {
  return {
    capturePage: async () => ({ toPNG: () => png, isEmpty: () => false }),
    isDevToolsOpened: () => false,
    isCrashed: () => false,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => false,
      sendCommand: async (method: string) => method === 'Page.getLayoutMetrics' ? { cssContentSize: { width: 100, height: 50_000 } } : method === 'Runtime.evaluate' ? { result: { value: 1 } } : { data: Buffer.from(png).toString('base64') }
    },
    ...over
  }
}

describe('takeScreenshot', () => {
  it('copies the picture to the clipboard and says so', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps()
    await takeScreenshot(window, contents(), { area: 'visible', to: 'copy' }, deps)
    expect(deps.copyImage).toHaveBeenCalledWith(png)
    expect(toasts()).toEqual(['copied'])
  })

  it('says the copy failed when the clipboard refuses, and when it never answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = fakeWindow()
    const deps = fakeDeps()
    deps.copyImage.mockRejectedValue(new Error('no display'))
    await takeScreenshot(refused.window, contents(), { area: 'visible', to: 'copy' }, deps)
    expect(refused.toasts()).toEqual(['copyFailed'])

    vi.useFakeTimers()
    try {
      const hung = fakeWindow()
      const stuck = fakeDeps()
      stuck.copyImage.mockReturnValue(new Promise(() => {}))
      const done = takeScreenshot(hung.window, contents(), { area: 'visible', to: 'copy' }, stuck)
      await vi.advanceTimersByTimeAsync(2500)
      await done
      expect(hung.toasts()).toEqual(['copyFailed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves a PNG under the dated default name in Downloads and names it', async () => {
    const { window, show } = fakeWindow()
    const deps = fakeDeps('/out/shot.png')
    await takeScreenshot(window, contents(), { area: 'visible', to: 'save' }, deps)
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({ defaultPath: '/home/me/Downloads/Screenshot 2026-09-30 at 14.05.09.png' }))
    expect(deps.files.get('/out/shot.png')).toEqual(png)
    expect(show).toHaveBeenLastCalledWith('toast', undefined, { code: 'saved', name: 'shot.png', revealPath: '/out/shot.png' })
  })

  it('writes nothing and shows nothing when the save dialog is cancelled', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps(null)
    await takeScreenshot(window, contents(), { area: 'visible', to: 'save' }, deps)
    expect(deps.files.size).toBe(0)
    expect(toasts()).toEqual([])
  })

  it('says the first part was saved when a very long page is cut', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps('/out/long.png')
    await takeScreenshot(window, contents(), { area: 'full', to: 'save' }, deps)
    expect(toasts()).toEqual(['longPage'])
    expect(MAX_FULL_PAGE_PIXELS).toBe(16_384)
  })

  it('says so when the picture cannot be taken, and asks for no file', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps()
    await takeScreenshot(window, contents({ capturePage: async () => { throw new Error('viz') } }), { area: 'visible', to: 'save' }, deps)
    expect(toasts()).toEqual(['shotFailed'])
    expect(deps.pickSave).not.toHaveBeenCalled()
  })

  it('says so when the file cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps('/out/shot.png')
    deps.writeFile = async () => { throw new Error('disk') }
    await takeScreenshot(window, contents(), { area: 'visible', to: 'save' }, deps)
    expect(toasts()).toEqual(['shotFailed'])
  })
})
