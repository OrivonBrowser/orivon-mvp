import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { toastOverlayFor } from '../toast-overlay.js'

const reveal = vi.fn()
const toastOverlay = toastOverlayFor(reveal)

function attached (): { handler: OverlayHandler, close: ReturnType<typeof vi.fn>, run: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  const run = vi.fn()
  const win = { window: { id: 'w' }, services: { commands: { run } }, send: vi.fn(), close } as unknown as OverlayWindow
  return { handler: toastOverlay.attach(win), close, run }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the toast overlay', () => {
  it('is a never-focused bar, 380 wide and 40 tall', () => {
    expect(toastOverlay).toMatchObject({ focus: 'never', layer: 'bar', placement: { kind: 'area', at: 'top-center', width: 380 }, height: { initial: 40, min: 40, max: 40 } })
  })

  it('answers a show with the view and closes itself after three seconds', () => {
    const { handler, close } = attached()
    expect(handler.show?.({ code: 'saved', name: 'a.png' })).toMatchObject({ text: 'Saved', name: 'a.png' })
    vi.advanceTimersByTime(2999)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('restarts the clock when a second message replaces the first', () => {
    const { handler, close } = attached()
    handler.show?.({ code: 'saved' })
    vi.advanceTimersByTime(2000)
    handler.show?.({ code: 'copied' })
    vi.advanceTimersByTime(2000)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('never closes by itself while work is going on, and stops its clock when a message replaces a timed one', () => {
    const { handler, close } = attached()
    handler.show?.({ code: 'saved' })
    handler.show?.({ code: 'savingPdf' })
    vi.advanceTimersByTime(60_000)
    expect(close).not.toHaveBeenCalled()
  })

  it('closes at once on a payload that is not a known message', () => {
    const { handler, close } = attached()
    expect(handler.show?.({ code: 'nope' })).toBeUndefined()
    expect(handler.show?.('saved')).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('runs the shown message\'s link, and nothing else the page asks for', () => {
    const { handler, run, close } = attached()
    handler.show?.({ code: 'saved' })
    handler.request({ type: 'action' })
    handler.request({ type: 'run', id: 'app.quit' })
    handler.request(null)
    expect(run).not.toHaveBeenCalled()

    handler.show?.({ code: 'noPrinter' })
    handler.request({ type: 'run', id: 'app.quit' })
    expect(run).not.toHaveBeenCalled()
    handler.request({ type: 'action' })
    expect(run).toHaveBeenCalledWith('page.pdf', { id: 'w' })
    expect(close).toHaveBeenCalled()
  })

  it('stays eight seconds when it offers something to do, and waits while the pointer is on it', () => {
    const { handler, close } = attached()
    handler.show?.({ code: 'noPrinter' })
    vi.advanceTimersByTime(7999)
    expect(close).not.toHaveBeenCalled()
    handler.request({ type: 'hold' })
    vi.advanceTimersByTime(60_000)
    expect(close).not.toHaveBeenCalled()
    handler.request({ type: 'release' })
    vi.advanceTimersByTime(7999)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not start a clock on release for work still going on', () => {
    const { handler, close } = attached()
    handler.show?.({ code: 'savingPdf' })
    handler.request({ type: 'release' })
    vi.advanceTimersByTime(60_000)
    expect(close).not.toHaveBeenCalled()
  })

  it('closes when dismissed', () => {
    const { handler, close } = attached()
    handler.show?.({ code: 'noPrinter' })
    handler.request({ type: 'dismiss' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('offers to show a saved file in its folder, and does so only for the path main gave it', () => {
    const { handler, close } = attached()
    expect(handler.show?.({ code: 'saved', name: 'a.png', revealPath: '/out/a.png' })).toMatchObject({ action: 'Show in folder' })
    handler.request({ type: 'action', path: '/etc/passwd' })
    expect(reveal).toHaveBeenCalledExactlyOnceWith('/out/a.png')
    expect(close).toHaveBeenCalled()
    reveal.mockClear()
    expect(handler.show?.({ code: 'saved', name: 'a.png' })).not.toHaveProperty('action')
    handler.request({ type: 'action' })
    expect(reveal).not.toHaveBeenCalled()
  })

  it('forgets the message and its clock once closed', () => {
    const { handler, run, close } = attached()
    handler.show?.({ code: 'noPrinter' })
    handler.closed?.('request')
    handler.request({ type: 'action' })
    vi.advanceTimersByTime(10_000)
    expect(run).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})
