import { describe, expect, it } from 'vitest'
import { dragModeFor } from '../drag-mode.js'

describe('dragModeFor', () => {
  it('is native on every platform but Linux', () => {
    expect(dragModeFor('darwin', {})).toBe('native')
    expect(dragModeFor('win32', {})).toBe('native')
  })

  it('is manual on Linux with no Wayland session in sight', () => {
    expect(dragModeFor('linux', {})).toBe('manual')
    expect(dragModeFor('linux', { XDG_SESSION_TYPE: 'x11' })).toBe('manual')
  })

  it('is native on Linux when the session is really Wayland', () => {
    expect(dragModeFor('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe('native')
    expect(dragModeFor('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('native')
  })

  it('agrees with run-headless.mjs\'s own virtual-display environment: manual, since that is what forces X11', () => {
    // scripts/run-headless.mjs strips WAYLAND_DISPLAY and downgrades
    // XDG_SESSION_TYPE to 'x11' precisely so ozone has only X11 left to
    // discover -- this is the environment a headless/e2e run actually sees.
    expect(dragModeFor('linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: undefined })).toBe('manual')
  })

  it('is manual on a real Wayland desktop once Electron is told to render through X11 anyway', () => {
    const waylandDesktop = { XDG_SESSION_TYPE: 'wayland' }
    // Without the switch or the hint, a native Wayland session still reads as native above.
    expect(dragModeFor('linux', waylandDesktop)).toBe('native')

    // `--ozone-platform=x11`, passed in the way `app.commandLine.getSwitchValue` reports it.
    expect(dragModeFor('linux', waylandDesktop, 'x11')).toBe('manual')
    // A switch for some other platform is not the same thing.
    expect(dragModeFor('linux', waylandDesktop, 'wayland')).toBe('native')

    // `ELECTRON_OZONE_PLATFORM_HINT=x11`, the environment variable Chromium itself reads for the
    // same choice, has the same effect with no switch at all.
    expect(dragModeFor('linux', { ...waylandDesktop, ELECTRON_OZONE_PLATFORM_HINT: 'x11' })).toBe('manual')
  })
})
