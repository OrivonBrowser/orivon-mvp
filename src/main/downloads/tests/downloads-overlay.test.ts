import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { PEEK_CONTROLLERS } from '../peek-controller.js'
import { DOWNLOADS_OVERLAY, DOWNLOADS_PEEK_OVERLAY, downloadsOverlay, downloadsPeekOverlay } from '../downloads-overlay.js'
import type { DownloadEntry, DownloadState } from '../download-types.js'
import { attentionFor } from '../window-attention.js'

const entry = (id: string, state: DownloadState, startedAt = 1): DownloadEntry => ({
  id, url: 'https://a.example/f', referrer: '', fileName: id, savePath: `/dl/${id}`, mime: '', total: 10, received: 0, state, startedAt, danger: false
})

function rig (list: DownloadEntry[], peek = false) {
  let listener: (change: DownloadEntry | null) => void = () => {}
  const unsubscribed = vi.fn()
  const downloads = {
    list: vi.fn(() => list),
    onChange: vi.fn((next: typeof listener) => { listener = next; return unsubscribed }),
    pause: vi.fn(() => true), resume: vi.fn(() => true), cancel: vi.fn(() => true), retry: vi.fn(() => true), remove: vi.fn(() => true),
    keep: vi.fn((id: string) => list.some((each) => each.id === id && each.state === 'held')),
    discard: vi.fn(() => true),
    open: vi.fn(async () => true), showInFolder: vi.fn(() => true)
  }
  const tabs = { openInternal: vi.fn(), changed: vi.fn() }
  const window = { tabs }
  const services = { downloads }
  const send = vi.fn()
  const close = vi.fn()
  const win = { window, services, send, close } as unknown as OverlayWindow
  const handler = (peek ? downloadsPeekOverlay : downloadsOverlay).attach(win)
  return { handler, downloads, tabs, send, close, unsubscribed, fire: (change: DownloadEntry | null) => { listener(change) }, window, services }
}

describe('the overlay definitions', () => {
  it('declare a bubble that takes focus and a peek that never does', () => {
    expect(downloadsOverlay).toMatchObject({ name: DOWNLOADS_OVERLAY, focus: 'take', layer: 'popup', surface: 'panel', keep: 'fresh', placement: { kind: 'anchor', width: 360, align: 'right' }, height: { max: 460 } })
    expect(downloadsPeekOverlay).toMatchObject({ name: DOWNLOADS_PEEK_OVERLAY, focus: 'never', layer: 'popup', placement: { kind: 'anchor', width: 360, align: 'right' } })
  })

  it('keeps the peek open when a click in it hands focus back', () => {
    expect(downloadsPeekOverlay.closeOn.blur).toBe(false)
    expect(downloadsOverlay.closeOn.blur).toBe(true)
  })
})

describe('showing the bubble', () => {
  it('answers with at most six rows, held first, without paths', () => {
    const list = [...Array.from({ length: 7 }, (_, index) => entry(`f${String(index)}`, 'completed')), entry('h', 'held')]
    const { handler } = rig(list)
    const shown = handler.show?.(undefined) as { rows: DownloadEntry[] }
    expect(shown.rows).toHaveLength(6)
    expect(shown.rows[0]?.id).toBe('h')
    expect(shown.rows.every((row) => row.savePath === '')).toBe(true)
  })

  it('clears the button\'s dot, and a peek leaves it for the person to see', () => {
    const made = rig([entry('a', 'progressing')])
    attentionFor(made.window as never, made.downloads).note(entry('a', 'completed'))
    expect(attentionFor(made.window as never, made.downloads).value()).toBe('done')
    made.handler.show?.(undefined)
    expect(attentionFor(made.window as never, made.downloads).value()).toBe('none')
    expect(made.tabs.changed).toHaveBeenCalled()

    const peeked = rig([entry('a', 'progressing')], true)
    attentionFor(peeked.window as never, peeked.downloads).note(entry('a', 'completed'))
    peeked.handler.show?.(undefined)
    expect(attentionFor(peeked.window as never, peeked.downloads).value()).toBe('done')
  })

  it('sends the rows again when the list changes, and stops listening when it closes', () => {
    const { handler, send, fire, unsubscribed } = rig([entry('a', 'progressing')])
    handler.show?.(undefined)
    fire(entry('a', 'completed'))
    expect(send).toHaveBeenCalledWith({ type: 'rows', rows: [expect.objectContaining({ id: 'a' })] })
    handler.closed?.('request')
    expect(unsubscribed).toHaveBeenCalledTimes(1)
  })

  it('does not stack a second subscription when it is shown again', () => {
    const { handler, unsubscribed } = rig([])
    handler.show?.(undefined)
    handler.show?.(undefined)
    expect(unsubscribed).toHaveBeenCalledTimes(1)
  })

  it('tells the peek controller when the peek opens, the pointer moves and it closes', () => {
    const controller = { opened: vi.fn(), pointer: vi.fn(), closed: vi.fn() }
    const services = {
      downloads: { list: () => [], onChange: () => () => {} },
      windows: undefined
    }
    PEEK_CONTROLLERS.set(services, controller as never)
    const window = { tabs: { changed: vi.fn(), openInternal: vi.fn() } }
    const handler = downloadsPeekOverlay.attach({ window, services, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow)
    handler.show?.(undefined)
    void handler.request({ type: 'hold' })
    void handler.request({ type: 'release' })
    handler.closed?.('request')
    expect(controller.opened).toHaveBeenCalledWith(window)
    expect(controller.pointer.mock.calls).toEqual([[window, true], [window, false]])
    expect(controller.closed).toHaveBeenCalledWith(window)
  })
})

describe('requests from the page', () => {
  it('runs each action on the download it names', async () => {
    const { handler, downloads } = rig([entry('a', 'progressing')])
    for (const type of ['pause', 'resume', 'cancel', 'retry', 'remove', 'discard'] as const) {
      expect(await handler.request({ type, id: 'a' })).toEqual({ ok: true })
      expect(downloads[type]).toHaveBeenCalledWith('a')
    }
  })

  it('refuses Keep on a download that is not held', async () => {
    const { handler, downloads } = rig([entry('a', 'completed'), entry('h', 'held')])
    expect(await handler.request({ type: 'keep', id: 'a' })).toEqual({ ok: false })
    expect(await handler.request({ type: 'keep', id: 'h' })).toEqual({ ok: true })
    expect(downloads.keep).toHaveBeenCalledTimes(2)
  })

  it('closes the bubble after opening a file or showing it, and only when that worked', async () => {
    const { handler, downloads, close } = rig([entry('a', 'completed')])
    await handler.request({ type: 'open', id: 'a' })
    await handler.request({ type: 'showInFolder', id: 'a' })
    expect(close).toHaveBeenCalledTimes(2)
    downloads.open.mockResolvedValueOnce(false)
    await handler.request({ type: 'open', id: 'a' })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('closes and opens the Downloads page on "Show all downloads"', async () => {
    const { handler, tabs, close } = rig([])
    await handler.request({ type: 'openPage' })
    expect(close).toHaveBeenCalled()
    expect(tabs.openInternal).toHaveBeenCalledWith('downloads')
  })

  it('ignores anything that is not one of the requests', async () => {
    const { handler, downloads } = rig([entry('a', 'held')])
    for (const bad of [undefined, null, 'keep', { type: 'keep' }, { type: 'keep', id: 'a', path: '/x' }, { type: 'deleteFile', id: 'a' }, { type: 'discard', id: 7 }]) {
      expect(await handler.request(bad)).toBeUndefined()
    }
    expect(downloads.keep).not.toHaveBeenCalled()
    expect(downloads.discard).not.toHaveBeenCalled()
  })
})
