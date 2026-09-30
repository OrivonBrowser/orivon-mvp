import { describe, expect, it, vi } from 'vitest'
import { firstWindowOptions } from '../first-window.js'
import type { ShellServices } from '../shell-services.js'

const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const saved = { bounds: { x: 100, y: 80, width: 900, height: 620 }, maximized: false }

function services (extra: { kiosk?: boolean, saved?: unknown, home?: string } = {}): ShellServices {
  return {
    kiosk: extra.kiosk ?? false,
    windowState: { get: () => extra.saved ?? null },
    settings: { get: (key: string) => (key === 'home.url' ? (extra.home ?? '') : undefined) }
  } as unknown as ShellServices
}

function opened (first: ((tabs: never) => void) | undefined): Array<[string, boolean]> {
  const createTab = vi.fn()
  first?.({ createTab } as never)
  return createTab.mock.calls.map(([url, active]) => [url as string, active as boolean])
}

describe('firstWindowOptions', () => {
  it('opens as it always does when nothing was saved and nothing was asked', () => {
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon'], displays: [display] })).toEqual({})
  })

  it('restores the saved place and the maximised state', () => {
    expect(firstWindowOptions({ services: services({ saved }), isPrivate: false, argv: [], displays: [display] }))
      .toEqual({ place: { x: 100, y: 80, width: 900, height: 620 } })
    expect(firstWindowOptions({ services: services({ saved: { ...saved, maximized: true } }), isPrivate: false, argv: [], displays: [display] }))
      .toEqual({ place: { x: 100, y: 80, width: 900, height: 620 }, maximized: true })
  })

  it('does not restore a place in a private session or a kiosk', () => {
    expect(firstWindowOptions({ services: services({ saved }), isPrivate: true, argv: [], displays: [display] })).toEqual({})
    expect(firstWindowOptions({ services: services({ saved, kiosk: true }), isPrivate: false, argv: [], displays: [display] })).toEqual({})
  })

  it('opens the addresses on the command line as tabs, the first in front', () => {
    const plan = firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon', '--x', 'https://a.example/', 'file:///etc/passwd', 'http://b.example/'] })
    expect(opened(plan.first)).toEqual([['https://a.example/', true], ['http://b.example/', false]])
  })

  it('opens at most eight, and only web addresses', () => {
    const argv = Array.from({ length: 12 }, (_, n) => `https://${String(n)}.example/`)
    expect(opened(firstWindowOptions({ services: services(), isPrivate: false, argv }).first)).toHaveLength(8)
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['javascript:alert(1)', 'data:text/html,x', 'orivon://settings', 'notaurl'] }).first).toBeUndefined()
  })

  it('opens an address given to a private session too', () => {
    const plan = firstWindowOptions({ services: services(), isPrivate: true, argv: ['--orivon-private', 'https://a.example/'] })
    expect(opened(plan.first)).toEqual([['https://a.example/', true]])
  })

  it('shows a kiosk the address it was given, else its home page, else the new tab page', () => {
    const kiosk = { kiosk: true, home: 'example.com' }
    expect(opened(firstWindowOptions({ services: services(kiosk), isPrivate: false, argv: ['https://a.example/'] }).first)).toEqual([['https://a.example/', true]])
    expect(opened(firstWindowOptions({ services: services(kiosk), isPrivate: false, argv: [] }).first)).toEqual([['https://example.com/', true]])
    expect(firstWindowOptions({ services: services({ kiosk: true }), isPrivate: false, argv: [] }).first).toBeUndefined()
  })

  it('does not open the home page for an ordinary start', () => {
    expect(firstWindowOptions({ services: services({ home: 'example.com' }), isPrivate: false, argv: [] }).first).toBeUndefined()
  })
})
