import { beforeEach, describe, expect, it, vi } from 'vitest'

const frame = vi.hoisted(() => ({ insertCSS: vi.fn(() => 'key') }))
vi.mock('electron', () => ({ webFrame: frame }))

beforeEach(() => { frame.insertCSS.mockClear() })

describe('installNoDragRegions', () => {
  it('inserts one user-origin sheet, so no author rule of the page can outrank it', async () => {
    const { installNoDragRegions } = await import('../no-drag-regions.js')
    installNoDragRegions()
    expect(frame.insertCSS).toHaveBeenCalledOnce()
    expect((frame.insertCSS.mock.calls[0] as unknown as unknown[])[1]).toEqual({ cssOrigin: 'user' })
  })

  it('makes every element and pseudo-element no-drag in both spellings of the property, important', async () => {
    const { NO_DRAG_REGIONS_CSS } = await import('../no-drag-regions.js')
    expect(NO_DRAG_REGIONS_CSS).toContain('*, *::before, *::after')
    expect(NO_DRAG_REGIONS_CSS).toContain('-webkit-app-region: no-drag !important')
    expect(NO_DRAG_REGIONS_CSS).toContain('; app-region: no-drag !important')
    expect(NO_DRAG_REGIONS_CSS).not.toMatch(/app-region:\s*drag/)
  })
})
