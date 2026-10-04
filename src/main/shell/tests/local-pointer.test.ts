import { describe, expect, it, vi } from 'vitest'

const switches = new Map<string, string>()
vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: (name: string) => switches.get(name) ?? '' } } }))

const { isLocalPointer, pointerIsLocal } = await import('../local-pointer.js')

describe('isLocalPointer', () => {
  it('is true on the Wayland platform Chromium resolved, and nowhere else', () => {
    expect(isLocalPointer('wayland')).toBe(true)
    expect(isLocalPointer('x11')).toBe(false)
    expect(isLocalPointer('')).toBe(false)
    expect(isLocalPointer('headless')).toBe(false)
  })

  it('is true when the test seam forces it', () => {
    expect(isLocalPointer('x11', true)).toBe(true)
  })
})

describe('pointerIsLocal', () => {
  it('reads the platform from the ozone-platform switch', () => {
    switches.set('ozone-platform', 'wayland')
    expect(pointerIsLocal({})).toBe(true)
    switches.set('ozone-platform', 'x11')
    expect(pointerIsLocal({})).toBe(false)
  })

  it('ignores the test variable in a build without the test seams', () => {
    switches.set('ozone-platform', 'x11')
    expect(pointerIsLocal({ ORIVON_TEST_LOCAL_POINTER: '1' })).toBe(false)
  })
})
