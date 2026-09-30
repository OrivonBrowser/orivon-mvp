// The view's construction: the same contract the toolbar popovers keep (a
// theme-coloured background before the first attach, a locked navigation, a
// preload that is gated on the exact address) for a view the host builds.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { calls, theme, state } = vi.hoisted(() => ({
  calls: [] as string[],
  theme: { dark: false },
  state: { options: null as unknown, contents: null as Record<string, ReturnType<typeof vi.fn> | number | { handle: ReturnType<typeof vi.fn> }> | null }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  webContents: { getFocusedWebContents: () => null },
  nativeTheme: { get shouldUseDarkColors () { return theme.dark }, on: vi.fn() },
  WebContentsView: vi.fn().mockImplementation(function (this: Record<string, unknown>, options: unknown) {
    state.options = options
    this.webContents = state.contents = {
      id: 7,
      ipc: { handle: vi.fn() },
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(() => { calls.push('lock') }),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      close: vi.fn(),
      focus: vi.fn(),
      send: vi.fn()
    }
    this.setBackgroundColor = vi.fn((color: string) => { calls.push(`background:${color}`) })
    this.setBorderRadius = vi.fn((radius: number) => { calls.push(`radius:${String(radius)}`) })
    this.setBounds = vi.fn()
  })
}))
vi.mock('../../shell/shell-session.js', () => ({ SHELL_PARTITION: 'persist:orivon-shell' }))

const { createOverlayView, overlayUrl } = await import('../overlay-view.js')

const PORT = { ready: vi.fn(), request: vi.fn(), size: vi.fn(), close: vi.fn() }
const spec = (surface: 'panel' | 'menu' = 'panel'): Parameters<typeof createOverlayView>[0] =>
  ({ dirname: '/app/out/main', def: { name: 'demo', surface }, port: PORT, onBlur: vi.fn(), onFocus: vi.fn() })

afterEach(() => { calls.length = 0; theme.dark = false })

describe('overlayUrl', () => {
  it('names the overlay and its surface after the entry', () => {
    expect(overlayUrl('/app/out/main', { name: 'tab-search', surface: 'panel' }))
      .toBe('file:///app/out/renderer/overlay/index.html?overlay=tab-search&surface=panel')
  })
})

describe('createOverlayView', () => {
  it('paints the surface colour and locks navigation before anything can attach it', () => {
    createOverlayView(spec('panel'))
    expect(calls.slice(0, 2)).toEqual(['background:#e5e5ec', 'lock'])
  })

  it('takes the menu surface\'s colour, and the dark one under a dark theme', () => {
    theme.dark = true
    createOverlayView(spec('menu'))
    expect(calls[0]).toBe('background:#2b2c31')
  })

  it('is sandboxed, isolated, in the shell partition, and told its own exact address', () => {
    createOverlayView(spec())
    expect(state.options).toMatchObject({ webPreferences: {
      preload: '/app/out/preload/overlay.js', partition: 'persist:orivon-shell', sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--orivon-overlay-url=file:///app/out/renderer/overlay/index.html?overlay=demo&surface=panel']
    } })
  })

  it('has rounded corners and handles the overlay channel on its own webContents', () => {
    createOverlayView(spec())
    expect(calls).toContain('radius:10')
    expect((state.contents?.['ipc'] as { handle: ReturnType<typeof vi.fn> }).handle).toHaveBeenCalledTimes(1)
  })

  it('reports blur and focus to the host', () => {
    const s = spec()
    createOverlayView(s)
    const on = state.contents?.['on'] as ReturnType<typeof vi.fn>
    expect(on.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(['blur', 'focus']))
  })

  it('repaints on a theme change', () => {
    const view = createOverlayView(spec())
    calls.length = 0
    theme.dark = true
    view.refreshBackground()
    expect(calls).toEqual(['background:#1e1f24'])
  })

  it('focuses at once when loaded, and after loading when not, unless no longer wanted', () => {
    const view = createOverlayView(spec())
    const contents = state.contents as { focus: ReturnType<typeof vi.fn>, isLoading: ReturnType<typeof vi.fn>, once: ReturnType<typeof vi.fn> }
    view.focusWhenReady(() => true)
    expect(contents.focus).toHaveBeenCalledTimes(1)
    contents.isLoading.mockReturnValue(true)
    let wanted = true
    view.focusWhenReady(() => wanted)
    expect(contents.focus).toHaveBeenCalledTimes(1)
    wanted = false
    ;(contents.once.mock.calls[0]?.[1] as () => void)()
    expect(contents.focus).toHaveBeenCalledTimes(1)
  })
})
