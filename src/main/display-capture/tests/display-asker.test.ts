import { describe, expect, it, vi } from 'vitest'
import { createDisplayAsker, type DisplayAskerDeps } from '../display-asker.js'
import { ticketKey } from '../display-tickets.js'

const ORIGIN = 'https://share.example'
const KEY = ticketKey(1, 10, 2)

function tab (): never {
  return { id: 1, mainFrame: { processId: 10, routingId: 2 }, isDestroyed: () => false, getURL: () => `${ORIGIN}/` } as never
}

function setup (overrides: Partial<DisplayAskerDeps> = {}): { asker: ReturnType<typeof createDisplayAsker>, deps: DisplayAskerDeps } {
  const deps: DisplayAskerDeps = {
    tickets: { request: vi.fn(async () => await Promise.resolve(true)), awaitingDisplay: vi.fn(() => false), void: vi.fn() },
    isTab: () => true,
    mainFrameOrigin: () => ORIGIN,
    mayAsk: () => true,
    endUnexpectedCapture: vi.fn(),
    ...overrides
  }
  return { asker: createDisplayAsker(deps), deps }
}

const DISPLAY = { mediaTypes: [], isMainFrame: true, securityOrigin: ORIGIN, requestingUrl: `${ORIGIN}/` }

describe('the display asker: requests', () => {
  it('holds a media request with no device type against the tab\'s ticket key', async () => {
    const { asker, deps } = setup()
    expect(await asker.request?.(tab(), 'media', DISPLAY)).toBe(true)
    expect(deps.tickets.request).toHaveBeenCalledWith(KEY, expect.any(Function))
  })

  it('ends the requester\'s renderer when the tickets report a request with no ticket right after a served one', async () => {
    const { asker, deps } = setup({ tickets: { request: vi.fn(async (_key: string, onAftermath?: () => void) => { onAftermath?.(); return await Promise.resolve(false) }), awaitingDisplay: vi.fn(() => false), void: vi.fn() } })
    const contents = tab()
    expect(await asker.request?.(contents, 'media', DISPLAY)).toBe(false)
    expect(deps.endUnexpectedCapture).toHaveBeenCalledWith(contents, expect.stringContaining('no ticket'))
  })

  it('does not end the renderer for a plain refusal', async () => {
    const { asker, deps } = setup({ tickets: { request: async () => await Promise.resolve(false), awaitingDisplay: () => false, void: () => {} } })
    await asker.request?.(tab(), 'media', DISPLAY)
    expect(deps.endUnexpectedCapture).not.toHaveBeenCalled()
  })

  it('reads Electron\'s origin with its trailing slash as the same origin', async () => {
    const { asker, deps } = setup()
    expect(await asker.request?.(tab(), 'media', { ...DISPLAY, securityOrigin: `${ORIGIN}/` })).toBe(true)
    expect(deps.tickets.request).toHaveBeenCalledWith(KEY, expect.any(Function))
  })

  it('answers the ticket\'s refusal as a refusal', async () => {
    const { asker } = setup({ tickets: { request: async () => await Promise.resolve(false), awaitingDisplay: () => false, void: () => {} } })
    expect(await asker.request?.(tab(), 'media', DISPLAY)).toBe(false)
  })

  it.each([
    ['a camera request', { ...DISPLAY, mediaTypes: ['video'] }],
    ['a request with no media types', { isMainFrame: true, securityOrigin: ORIGIN }],
    ['media types that are not a list', { ...DISPLAY, mediaTypes: 'none' }]
  ])('leaves %s to the next asker', (_name, details) => {
    const { asker, deps } = setup()
    expect(asker.request?.(tab(), 'media', details)).toBeUndefined()
    expect(deps.tickets.request).not.toHaveBeenCalled()
  })

  it('leaves every other permission to the next asker', () => {
    const { asker } = setup()
    expect(asker.request?.(tab(), 'geolocation', DISPLAY)).toBeUndefined()
  })

  it('leaves a contents that is not a tab to the gate\'s own rules', () => {
    const { asker } = setup({ isTab: () => false })
    expect(asker.request?.(tab(), 'media', DISPLAY)).toBeUndefined()
  })

  it('leaves an extension\'s tab capture of this tab to the rule that decides it: the requester\'s origin is not the page\'s', () => {
    const { asker, deps } = setup()
    expect(asker.request?.(tab(), 'media', { ...DISPLAY, securityOrigin: 'chrome-extension://abcdefghijklmnop' })).toBeUndefined()
    expect(deps.tickets.request).not.toHaveBeenCalled()
  })

  it('leaves it to the next asker when the tab has no committed origin', () => {
    const { asker } = setup({ mainFrameOrigin: () => null })
    expect(asker.request?.(tab(), 'media', DISPLAY)).toBeUndefined()
  })

  it('refuses a same-origin subframe without consulting a ticket', async () => {
    const { asker, deps } = setup()
    expect(await asker.request?.(tab(), 'media', { ...DISPLAY, isMainFrame: false })).toBe(false)
    expect(deps.tickets.request).not.toHaveBeenCalled()
  })

  it('refuses a request whose frame flag is missing', async () => {
    const { asker } = setup()
    expect(await asker.request?.(tab(), 'media', { mediaTypes: [], securityOrigin: ORIGIN })).toBe(false)
  })
})

describe('the display asker: checks', () => {
  const MAIN = { isMainFrame: true }

  it('answers the display permission from the policy', () => {
    expect(setup().asker.check?.(tab(), 'display-capture', ORIGIN, MAIN)).toBe(true)
    expect(setup({ mayAsk: () => false }).asker.check?.(tab(), 'display-capture', ORIGIN, MAIN)).toBe(false)
  })

  it('refuses a frame that is not the top frame, and a frame embedded by another origin', () => {
    const { asker } = setup()
    expect(asker.check?.(tab(), 'display-capture', ORIGIN, { isMainFrame: false })).toBe(false)
    expect(asker.check?.(tab(), 'display-capture', 'https://frame.example', { isMainFrame: true, embeddingOrigin: ORIGIN })).toBe(false)
  })

  it('answers for the top frame whose embedder Electron names as the page itself', () => {
    expect(setup().asker.check?.(tab(), 'display-capture', `${ORIGIN}/`, { isMainFrame: true, embeddingOrigin: `${ORIGIN}/` })).toBe(true)
  })

  it('refuses an origin that is not the one the tab committed', () => {
    expect(setup().asker.check?.(tab(), 'display-capture', 'https://other.example', MAIN)).toBe(false)
  })

  it('leaves another permission, a null contents and a non-tab to the next asker', () => {
    const { asker } = setup()
    expect(asker.check?.(tab(), 'geolocation', ORIGIN, MAIN)).toBeUndefined()
    expect(asker.check?.(null, 'display-capture', ORIGIN, MAIN)).toBeUndefined()
    expect(setup({ isTab: () => false }).asker.check?.(tab(), 'display-capture', ORIGIN, MAIN)).toBeUndefined()
  })

  it('never answers the media check, which stays refused by the gate', () => {
    expect(setup().asker.check?.(tab(), 'media', ORIGIN, { ...MAIN, mediaType: 'video' })).toBeUndefined()
  })
})

describe('the display asker: after a grant', () => {
  it('ends the capture and voids the ticket when the display handler did not take the choice', () => {
    const { asker, deps } = setup({ tickets: { request: vi.fn(), awaitingDisplay: vi.fn(() => true), void: vi.fn() } })
    const contents = tab()
    asker.afterGrant?.(contents, 'media', DISPLAY)
    expect(deps.tickets.void).toHaveBeenCalledWith(KEY)
    expect(deps.endUnexpectedCapture).toHaveBeenCalledWith(contents, expect.stringContaining('no display handler'))
  })

  it('does nothing when the display handler took the choice', () => {
    const { asker, deps } = setup()
    asker.afterGrant?.(tab(), 'media', DISPLAY)
    expect(deps.endUnexpectedCapture).not.toHaveBeenCalled()
  })

  it('does nothing for a grant of a camera or another permission', () => {
    const { asker, deps } = setup({ tickets: { request: vi.fn(), awaitingDisplay: vi.fn(() => true), void: vi.fn() } })
    asker.afterGrant?.(tab(), 'media', { ...DISPLAY, mediaTypes: ['video'] })
    asker.afterGrant?.(tab(), 'geolocation', DISPLAY)
    expect(deps.endUnexpectedCapture).not.toHaveBeenCalled()
  })
})
