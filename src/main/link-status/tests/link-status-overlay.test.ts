import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { forgetLinkStatus, linkStatusFor } from '../link-status-for.js'
import { linkStatusOverlay } from '../link-status-overlay.js'

vi.mock('../link-status-for.js', () => {
  const status = { width: vi.fn(), pointerEntered: vi.fn(), closed: vi.fn() }
  return { linkStatusFor: vi.fn(() => status), forgetLinkStatus: vi.fn(), status }
})
const { status } = await import('../link-status-for.js') as unknown as { status: Record<'width' | 'pointerEntered' | 'closed', ReturnType<typeof vi.fn>> }

const window = { window: {} }
const handler = linkStatusOverlay.attach(window as unknown as OverlayWindow)

describe('the link bubble overlay', () => {
  it('never takes the keyboard, lies with the bars and keeps its view for the life of the window', () => {
    expect(linkStatusOverlay).toMatchObject({ focus: 'never', layer: 'bar', keep: 'resident' })
  })

  it('is closed by a tab switch and a layout change, and not by a blur, nor by the front tab\'s address changing (its own tab\'s navigation ends it, in the signal)', () => {
    expect(linkStatusOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: true })
  })

  it('places itself, so what its page reports of its height is nothing', () => {
    expect(linkStatusOverlay.placement.kind).toBe('exact')
  })

  it('hands its page the view it was shown with', () => {
    const view = { seq: 1, text: 'https://example.com/', side: 'left', room: 600, inset: { left: 6, right: 0 } }
    expect(handler.show?.(view)).toBe(view)
  })

  it('takes the measured width of a text from its page', () => {
    handler.request({ type: 'width', seq: 3, width: 188 })
    expect(status.width).toHaveBeenCalledWith(3, 188)
  })

  it.each([
    ['no object', 'width'],
    ['a null', null],
    ['an unknown command', { type: 'close' }],
    ['a width of a string', { type: 'width', seq: 1, width: '188' }],
    ['a width that is not a number', { type: 'width', seq: 1, width: Number.NaN }],
    ['an infinite width', { type: 'width', seq: 1, width: Number.POSITIVE_INFINITY }],
    ['a negative width', { type: 'width', seq: 1, width: -1 }],
    ['a width no screen has', { type: 'width', seq: 1, width: 1e12 }],
    ['a sequence that is not a number', { type: 'width', seq: '1', width: 100 }],
    ['a sequence that is not whole', { type: 'width', seq: 1.5, width: 100 }],
    ['a width with no sequence', { type: 'width', width: 100 }]
  ])('refuses %s', (_name, command) => {
    status.width.mockClear()
    expect(handler.request(command)).toBeUndefined()
    expect(status.width).not.toHaveBeenCalled()
  })

  it('tells the bubble the pointer is on it', () => {
    handler.request({ type: 'pointer' })
    expect(status.pointerEntered).toHaveBeenCalledOnce()
  })

  it('tells the bubble the host closed it, whatever the reason', () => {
    handler.closed?.('tab-switch')
    expect(status.closed).toHaveBeenCalledOnce()
  })

  it('drops its window\'s bubble when the window is gone', () => {
    handler.disposed?.()
    expect(forgetLinkStatus).toHaveBeenCalledWith(window.window)
    expect(linkStatusFor).toHaveBeenCalledWith(window.window)
  })
})
