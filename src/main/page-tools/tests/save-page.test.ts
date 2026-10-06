import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { savePage } from '../save-page.js'
import type { SaveContents } from '../save-page.js'
import { fakeDeps, fakeWindow } from './support.js'

class FakeSession extends EventEmitter {}

function contents (contentType: string | Error = 'text/html', extra: Partial<SaveContents> = {}): SaveContents & { savePage: ReturnType<typeof vi.fn>, downloadURL: ReturnType<typeof vi.fn>, session: FakeSession } {
  const session = new FakeSession()
  return {
    id: 4,
    getURL: () => 'https://a.example/post',
    isCrashed: () => false,
    savePage: vi.fn(async () => {}),
    downloadURL: vi.fn(),
    session,
    executeJavaScriptInIsolatedWorld: async () => { if (contentType instanceof Error) throw contentType; return contentType },
    ...extra
  } as never
}

const page = (wc: SaveContents, url = 'https://a.example/post'): { wc: SaveContents, title: string, url: string } => ({ wc, title: 'A post', url })

describe('savePage, a web page', () => {
  it('offers both formats, starting in Downloads with the title', async () => {
    const { window } = fakeWindow()
    const deps = fakeDeps()
    await savePage(window, page(contents()), deps)
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({
      title: 'Save page as',
      defaultPath: '/home/me/Downloads/A post.html',
      filters: [expect.objectContaining({ name: 'Web page, complete (*.html)' }), expect.objectContaining({ name: 'Web page, single file (*.mhtml)' })]
    }))
  })

  it('starts at a name beside a local file allowed to use Orivon permissions, never at that file', async () => {
    const { window } = fakeWindow()
    const deps = { ...fakeDeps(), reservedPath: (path: string) => path === '/home/me/Downloads/A post.html' }
    await savePage(window, page(contents()), deps)
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({ defaultPath: '/home/me/Downloads/A post (1).html' }))
  })

  it('saves a complete page for .html and a single file for .mhtml, then names the file', async () => {
    for (const [path, format] of [['/out/a.html', 'HTMLComplete'], ['/out/a.mhtml', 'MHTML']] as const) {
      const { window, show } = fakeWindow()
      const wc = contents()
      await savePage(window, page(wc), fakeDeps(path))
      expect(wc.savePage).toHaveBeenCalledWith(path, format)
      expect(show).toHaveBeenLastCalledWith('toast', undefined, { code: 'saved', name: path.split('/').pop(), revealPath: path })
    }
  })

  it('writes nothing and shows nothing when the person cancels', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents()
    await savePage(window, page(wc), fakeDeps(null))
    expect(wc.savePage).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })

  it('says so when the save fails', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents()
    wc.savePage.mockRejectedValue(new Error('disk'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await savePage(window, page(wc), fakeDeps())
    expect(toasts()).toEqual(['saveFailed'])
  })

  it('goes by the address when the page cannot say what it is', async () => {
    const { window } = fakeWindow()
    const wc = contents(new Error('hung'))
    await savePage(window, page(wc), fakeDeps('/out/a.html'))
    expect(wc.savePage).toHaveBeenCalled()
  })

  it('adds .html to a name typed without an extension, and leaves one that has it', async () => {
    const { window } = fakeWindow()
    const bare = contents()
    await savePage(window, page(bare), fakeDeps('/out/report'))
    expect(bare.savePage).toHaveBeenCalledWith('/out/report.html', 'HTMLComplete')
    const named = contents()
    await savePage(window, page(named), fakeDeps('/out/report.mhtml'))
    expect(named.savePage).toHaveBeenCalledWith('/out/report.mhtml', 'MHTML')
  })

  it('reads the content type in a world the page cannot reach', async () => {
    const { window } = fakeWindow()
    const wc = contents()
    const read = vi.fn(async () => 'text/html')
    await savePage(window, page({ ...wc, executeJavaScriptInIsolatedWorld: read } as never), fakeDeps('/out/a.html'))
    expect(read).toHaveBeenCalledWith(1002, [{ code: 'document.contentType' }])
  })

  it('refuses a page that is not on the web, and a crashed one', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents()
    await savePage(window, page(wc, 'orivon://settings/'), fakeDeps())
    await savePage(window, page(contents('text/html', { isCrashed: () => true })), fakeDeps())
    expect(wc.savePage).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['cannotSave', 'saveFailed'])
  })
})

describe('savePage, a file the tab shows', () => {
  /** `chain`: the addresses the download came through; by default it is the one asked for. */
  const download = (wc: ReturnType<typeof contents>, state: string, sourceId = 4, chain?: string[]): void => {
    wc.downloadURL.mockImplementation((asked: string) => {
      const item = Object.assign(new EventEmitter(), { setSavePath: vi.fn(), cancel: vi.fn(), getURLChain: () => chain ?? [asked] })
      wc.session.emit('will-download', {}, item, { id: sourceId })
      queueMicrotask(() => { item.emit('done', {}, state) })
      ;(wc as unknown as { item: unknown }).item = item
    })
  }

  it('downloads it into the chosen path through the tab\'s session and reports when it is done', async () => {
    const { window, show } = fakeWindow()
    const wc = contents('application/pdf')
    download(wc, 'completed')
    await savePage(window, page(wc, 'https://a.example/doc.pdf'), fakeDeps('/out/doc.pdf'))
    expect(wc.savePage).not.toHaveBeenCalled()
    expect(wc.downloadURL).toHaveBeenCalledWith('https://a.example/doc.pdf')
    expect(((wc as unknown as { item: { setSavePath: ReturnType<typeof vi.fn> } }).item).setSavePath).toHaveBeenCalledWith('/out/doc.pdf')
    expect(show).toHaveBeenLastCalledWith('toast', undefined, { code: 'saved', name: 'doc.pdf', revealPath: '/out/doc.pdf' })
    expect(wc.session.listenerCount('will-download')).toBe(0)
  })

  it('says so when the download does not complete', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents('image/png')
    download(wc, 'interrupted')
    await savePage(window, page(wc, 'https://a.example/a.png'), fakeDeps('/out/a.png'))
    expect(toasts()).toEqual(['saveFailed'])
  })

  it('takes a redirected download by the address it was asked for, and leaves a download the page started itself alone', async () => {
    const { window } = fakeWindow()
    const redirected = contents('application/pdf')
    download(redirected, 'completed', 4, ['https://a.example/doc.pdf', 'https://cdn.example/x.pdf'])
    await savePage(window, page(redirected, 'https://a.example/doc.pdf'), fakeDeps('/out/doc.pdf'))
    expect(((redirected as unknown as { item: { setSavePath: ReturnType<typeof vi.fn> } }).item).setSavePath).toHaveBeenCalledWith('/out/doc.pdf')

    vi.useFakeTimers()
    try {
      const own = contents('application/pdf')
      download(own, 'completed', 4, ['https://a.example/from-the-page.zip'])
      const done = savePage(window, page(own, 'https://a.example/doc.pdf'), fakeDeps('/out/doc.pdf'))
      await vi.advanceTimersByTimeAsync(11_000)
      await done
      expect(((own as unknown as { item: { setSavePath: ReturnType<typeof vi.fn> } }).item).setSavePath).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on a download that stops making progress, and cancels it', async () => {
    const { window, toasts } = fakeWindow()
    vi.useFakeTimers()
    try {
      const wc = contents('application/pdf')
      let item: (EventEmitter & { cancel: ReturnType<typeof vi.fn> }) | undefined
      wc.downloadURL.mockImplementation((asked: string) => {
        item = Object.assign(new EventEmitter(), { setSavePath: vi.fn(), cancel: vi.fn(), getURLChain: () => [asked] })
        wc.session.emit('will-download', {}, item, { id: 4 })
      })
      const done = savePage(window, page(wc, 'https://a.example/doc.pdf'), fakeDeps('/out/doc.pdf'))
      await vi.advanceTimersByTimeAsync(50_000)
      item?.emit('updated')
      await vi.advanceTimersByTimeAsync(50_000)
      expect(item?.cancel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(11_000)
      await done
      expect(item?.cancel).toHaveBeenCalledTimes(1)
      expect(toasts()).toEqual(['saveFailed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves another tab\'s download alone', async () => {
    const { window } = fakeWindow()
    vi.useFakeTimers()
    try {
      const wc = contents('application/pdf')
      download(wc, 'completed', 99)
      const done = savePage(window, page(wc, 'https://a.example/doc.pdf'), fakeDeps('/out/doc.pdf'))
      await vi.advanceTimersByTimeAsync(11_000)
      await done
      expect(((wc as unknown as { item: { setSavePath: ReturnType<typeof vi.fn> } }).item).setSavePath).not.toHaveBeenCalled()
      expect(wc.session.listenerCount('will-download')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
