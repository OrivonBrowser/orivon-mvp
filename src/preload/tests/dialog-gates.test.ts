// The sandbox refusal Chromium makes before a page's dialog reaches the browser, which the page-dialog wrapper
// has to repeat because it takes the call first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  origin: string
  top: unknown
  parent: unknown
  frameElement: unknown
}

const element = (sandbox: string | null): unknown => ({
  hasAttribute: (name: string) => name === 'sandbox' && sandbox !== null,
  sandbox: { contains: (token: string) => (sandbox ?? '').split(' ').includes(token) }
})

function top (origin = 'https://page.example'): FakeWindow {
  const win: FakeWindow = {
    origin,
    top: undefined,
    parent: undefined,
    frameElement: null
  }
  win.top = win
  win.parent = win
  return win
}
function child (parent: FakeWindow, origin: string, frameElement: unknown): FakeWindow {
  return { ...top(origin), top: parent.top, parent, frameElement }
}
function setUp (win: FakeWindow, mainFrame: boolean, protocol = 'https:'): void {
  vi.stubGlobal('window', win)
  vi.stubGlobal('location', { protocol })
  Object.defineProperty(process, 'isMainFrame', { value: mainFrame, configurable: true })
}

const original = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
let gates: typeof import('../dialog-gates.js')

beforeEach(async () => {
  vi.resetModules()
  gates = await import('../dialog-gates.js')
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (original === undefined) Reflect.deleteProperty(process, 'isMainFrame')
  else Object.defineProperty(process, 'isMainFrame', original)
})

describe('a dialog from a sandboxed document', () => {
  it('is dismissed in a top frame whose own CSP sandbox gave it an opaque origin, but not in a data: or about:blank page', () => {
    setUp(top('null'), true, 'https:')
    expect(gates.sandboxedWithoutModals()).toBe(true)
    setUp(top('null'), true, 'data:')
    expect(gates.sandboxedWithoutModals()).toBe(false)
    setUp(top('null'), true, 'about:')
    expect(gates.sandboxedWithoutModals()).toBe(false)
  })

  it('is dismissed in a subframe with an opaque origin, whatever its URL', () => {
    const parent = top()
    setUp(child(parent, 'null', null), false, 'https:')
    expect(gates.sandboxedWithoutModals()).toBe(true)
    setUp(child(parent, 'null', null), false, 'about:')
    expect(gates.sandboxedWithoutModals()).toBe(true)
  })

  it('is dismissed when a readable ancestor frame element sandboxes without allow-modals, and allowed with it or without a sandbox', () => {
    const grandparent = top()
    const parent = child(grandparent, 'https://page.example', element('allow-scripts allow-same-origin'))
    setUp(child(parent, 'https://page.example', element(null)), false)
    expect(gates.sandboxedWithoutModals()).toBe(true)

    const okParent = child(grandparent, 'https://page.example', element('allow-scripts allow-same-origin allow-modals'))
    setUp(child(okParent, 'https://page.example', null), false)
    expect(gates.sandboxedWithoutModals()).toBe(false)
  })

  it('stops at the first ancestor it cannot read and does not guess', () => {
    const parent = top('https://other.example')
    Object.defineProperty(parent, 'frameElement', { get: () => { throw new Error('SecurityError') } })
    setUp(child(parent, 'https://page.example', null), false)
    expect(gates.sandboxedWithoutModals()).toBe(false)
  })

  it('allows an ordinary top frame and an ordinary same-origin subframe', () => {
    const parent = top()
    setUp(parent, true)
    expect(gates.sandboxedWithoutModals()).toBe(false)
    setUp(child(parent, 'https://page.example', element(null)), false)
    expect(gates.sandboxedWithoutModals()).toBe(false)
  })
})
