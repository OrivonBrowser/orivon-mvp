// nativeTheme is one process-wide EventEmitter; a direct `nativeTheme.on
// ('updated', ...)` per window/popover pushed its listener count past
// Node's default max (10) from a handful of ordinary windows, printing
// `MaxListenersExceededWarning [NativeTheme]` and burying a real leak
// warning under a false one. onThemeUpdated fans one real listener out to a
// registry instead -- installed once, module-level, for the whole process's
// life, so each test below resets modules first: the "one real listener"
// state deliberately has no reset of its own.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeThemeListeners } = vi.hoisted(() => ({ nativeThemeListeners: [] as Array<() => void> }))

vi.mock('electron', () => ({
  nativeTheme: {
    on: (_event: 'updated', listener: () => void) => { nativeThemeListeners.push(listener) },
    removeListener: () => {}
  }
}))

beforeEach(() => {
  nativeThemeListeners.length = 0
  vi.resetModules()
})

describe('onThemeUpdated: one real nativeTheme listener for the whole process', () => {
  it('adding 6 windows-worth of listeners installs the real one exactly once', async () => {
    const { onThemeUpdated } = await import('../theme-colors.js')
    for (let i = 0; i < 6; i++) onThemeUpdated(vi.fn())
    expect(nativeThemeListeners).toHaveLength(1)
  })

  it('fans a real theme change out to every still-registered listener, and only those', async () => {
    const { onThemeUpdated } = await import('../theme-colors.js')
    const a = vi.fn()
    const b = vi.fn()
    const unregisterA = onThemeUpdated(a)
    onThemeUpdated(b)
    unregisterA()

    nativeThemeListeners[0]?.()

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
