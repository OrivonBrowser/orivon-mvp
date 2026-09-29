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
})
