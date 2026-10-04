// A window, its services and an overlay host that record what the panel does to them, for the host and handler tests.
import { vi } from 'vitest'
import type { WindowContext } from '../../shell/window-context.js'
import type { PanelWiring } from '../side-panel-host.js'

export interface FakeWindow {
  ctx: WindowContext
  wiring: PanelWiring
  /** What the panel did, in order. */
  log: string[]
  sent: unknown[]
  /** The window's size and settings, changed by a test. */
  state: { width: number, height: number, side: 'left' | 'right', fullscreen: boolean, kiosk: boolean, overlayOpen: boolean }
  children: unknown[]
  activeFocus: ReturnType<typeof vi.fn>
  relayout: ReturnType<typeof vi.fn>
  adopted: Array<{ close: () => void, restack?: (() => void) | undefined }>
}

export function fakeWindow (): FakeWindow {
  const state = { width: 1280, height: 800, side: 'right' as 'left' | 'right', fullscreen: false, kiosk: false, overlayOpen: false }
  const log: string[] = []
  const sent: unknown[] = []
  const children: unknown[] = []
  const activeFocus = vi.fn()
  const relayout = vi.fn(() => { log.push('relayout') })
  const adopted: FakeWindow['adopted'] = []
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: state.width, height: state.height }),
    contentView: {
      get children () { return children },
      addChildView: (view: unknown) => { if (!children.includes(view)) children.push(view); log.push('addChildView') },
      removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1); log.push('removeChildView') }
    }
  }
  const shell = {
    window,
    overlays: {
      show: vi.fn(() => { state.overlayOpen = true; log.push('show') }),
      close: vi.fn(() => { state.overlayOpen = false; log.push('close') }),
      isOpen: () => state.overlayOpen,
      send: vi.fn((_name: string, event: unknown) => { sent.push(event) }),
      toggle: vi.fn()
    },
    tabs: { activeWebContents: () => ({ focus: activeFocus, isDestroyed: () => false }), openInternal: vi.fn() },
    chromeHeight: () => 76,
    shortcutsSuspended: () => state.fullscreen,
    relayout
  }
  const services = {
    kiosk: false,
    isPrivate: false,
    settings: { get: () => state.side, onChange: vi.fn(() => () => {}) }
  }
  Object.defineProperty(services, 'kiosk', { get: () => state.kiosk })
  return {
    ctx: { window: shell, services } as unknown as WindowContext,
    wiring: {
      adopt: (panel, restack) => { adopted.push({ close: () => { panel.close() }, restack }) },
      area: () => {
        const left = state.side === 'left' ? 360 : 0
        const right = state.side === 'right' ? 360 : 0
        return { x: left, y: 76, width: state.width - left - right, height: state.height - 76 }
      }
    },
    log, sent, state, children, activeFocus, relayout, adopted
  }
}

export function fakeGuestView (): { view: never, destroy: () => void, bounds: unknown[], shown: boolean[] } {
  const bounds: unknown[] = []
  const shown: boolean[] = []
  let destroyed = false
  const view = { setBounds: (rect: unknown) => { bounds.push(rect) }, setVisible: (visible: boolean) => { shown.push(visible) }, webContents: { isDestroyed: () => destroyed } }
  return { view: view as never, destroy: () => { destroyed = true }, bounds, shown }
}
