import { describe, expect, it, vi } from 'vitest'
import { openQr, qrAddressFor, qrAvailable, QR_OVERLAY } from '../qr-open.js'

const tab = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'a', isNewTab: false, isInternal: false, displayUrl: 'https://example.com/a', ...extra })

function windowWith (tabs: Array<Record<string, unknown>>, activeTabId: string | null = 'a'): { tabs: never, overlays: { show: ReturnType<typeof vi.fn> } } {
  return { tabs: { getState: () => ({ tabs, activeTabId }) } as never, overlays: { show: vi.fn() } }
}

describe('qrAddressFor', () => {
  it('is the address the person reads', () => {
    expect(qrAddressFor(tab() as never)).toBe('https://example.com/a')
    expect(qrAddressFor(tab({ displayUrl: 'ipfs://bafy/x' }) as never)).toBe('ipfs://bafy/x')
  })

  it('refuses a tab with no page to share', () => {
    expect(qrAddressFor(undefined)).toBeUndefined()
    expect(qrAddressFor(tab({ isNewTab: true }) as never)).toBeUndefined()
    expect(qrAddressFor(tab({ isInternal: true, displayUrl: 'orivon://settings/' }) as never)).toBeUndefined()
    expect(qrAddressFor(tab({ displayUrl: '' }) as never)).toBeUndefined()
  })

  it('refuses an address too long for the sheet to carry, rather than opening it empty', () => {
    const long = `data:text/plain,${'x'.repeat(40_000)}`
    expect(qrAddressFor(tab({ displayUrl: long }) as never)).toBeUndefined()
    expect(qrAvailable(windowWith([tab({ displayUrl: long })]))).toBe(false)
  })
})

describe('openQr', () => {
  it('shows the sheet with the active tab\'s address, read in main', () => {
    const win = windowWith([tab({ id: 'b', displayUrl: 'https://other.example/' }), tab()])
    openQr(win as never)
    expect(win.overlays.show).toHaveBeenCalledWith(QR_OVERLAY, undefined, { url: 'https://example.com/a' })
  })

  it('does nothing on the new-tab page, an internal page, or with no active tab', () => {
    for (const win of [windowWith([tab({ isNewTab: true })]), windowWith([tab({ isInternal: true })]), windowWith([tab()], null)]) {
      openQr(win as never)
      expect(win.overlays.show).not.toHaveBeenCalled()
    }
  })

  it('reports availability the same way', () => {
    expect(qrAvailable(windowWith([tab()]) as never)).toBe(true)
    expect(qrAvailable(windowWith([tab({ isNewTab: true })]) as never)).toBe(false)
  })
})
