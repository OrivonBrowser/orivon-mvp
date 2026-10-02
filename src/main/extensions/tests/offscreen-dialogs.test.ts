import { describe, expect, it, vi } from 'vitest'

const { viewOptions } = vi.hoisted(() => ({ viewOptions: { current: undefined as unknown } }))

vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      isDestroyed: () => false,
      close: vi.fn()
    }

    constructor (options: unknown) { viewOptions.current = options }
  }
}))

const { OffscreenAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/offscreen.js')

describe('OffscreenAPI: page dialogs (UPSTREAM.md patch 62)', () => {
  it('builds the document with dialogs disabled: nobody watches it, so a native box could never be answered', async () => {
    const handlers = new Map<string, (event: unknown, parameters: unknown) => Promise<unknown>>()
    const ctx = {
      router: { apiHandler: () => (name: string, fn: (event: unknown, parameters: unknown) => Promise<unknown>) => { handlers.set(name, fn) } },
      session: { addListener: vi.fn() }
    }
    new OffscreenAPI(ctx as never)
    const id = 'a'.repeat(32)
    await handlers.get('offscreen.createDocument')?.(
      { extension: { id } },
      { url: 'offscreen.html', reasons: ['TESTING'], justification: 'a test' }
    )
    expect(viewOptions.current).toMatchObject({ webPreferences: { disableDialogs: true, sandbox: true } })
  })
})
