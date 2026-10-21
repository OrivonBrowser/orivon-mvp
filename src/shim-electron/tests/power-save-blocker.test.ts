import { describe, expect, it, vi } from 'vitest'
import { ElectronShimError } from '../errors.js'
import { createPowerSaveBlocker } from '../power-save-blocker.js'

type Sentinel = EventTarget & { released: boolean, release: () => Promise<void> }

function sentinel (): Sentinel {
  const target = new EventTarget() as Sentinel
  target.released = false
  target.release = async () => { target.released = true; target.dispatchEvent(new Event('release')) }
  return target
}

function setup (options: { request?: (type: 'screen') => Promise<Sentinel>, noWakeLock?: boolean, visible?: boolean } = {}) {
  const sentinels: Sentinel[] = []
  const request = vi.fn(options.request ?? (async () => { const s = sentinel(); sentinels.push(s); return s }))
  const document = Object.assign(new EventTarget(), { visibilityState: options.visible === false ? 'hidden' : 'visible' })
  const warn = vi.fn()
  const blocker = createPowerSaveBlocker({
    navigator: options.noWakeLock === true ? {} : { wakeLock: { request } },
    document,
    warn
  })
  const setVisibility = (state: 'visible' | 'hidden'): void => {
    document.visibilityState = state
    document.dispatchEvent(new Event('visibilitychange'))
  }
  return { blocker, request, sentinels, document, warn, setVisibility }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('powerSaveBlocker.start', () => {
  it('returns increasing integer ids and requests one screen wake lock for any number of blockers', async () => {
    const { blocker, request } = setup()
    const a = blocker.start('prevent-display-sleep')
    const b = blocker.start('prevent-app-suspension')
    expect(Number.isInteger(a)).toBe(true)
    expect(b).toBeGreaterThan(a)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('maps prevent-app-suspension to the screen lock too', async () => {
    const { blocker, request } = setup()
    blocker.start('prevent-app-suspension')
    await flush()
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('refuses a type Electron does not know with invalid-usage', () => {
    const { blocker } = setup()
    expect(() => blocker.start('prevent-everything' as never)).toThrow(ElectronShimError)
  })

  it('does not throw and still returns an id when the request is refused', async () => {
    const { blocker, warn } = setup({ request: async () => { throw new DOMException('hidden', 'NotAllowedError') } })
    let id = 0
    expect(() => { id = blocker.start('prevent-display-sleep') }).not.toThrow()
    await flush()
    expect(blocker.isStarted(id)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the request throws synchronously, or when the page has no wakeLock', () => {
    const throwing = setup({ request: () => { throw new TypeError('boom') } })
    expect(() => throwing.blocker.start('prevent-display-sleep')).not.toThrow()
    const none = setup({ noWakeLock: true })
    expect(() => none.blocker.start('prevent-display-sleep')).not.toThrow()
    expect(none.warn).toHaveBeenCalledTimes(1)
  })

  it('asks while the page is hidden only after it becomes visible', async () => {
    const { blocker, request, setVisibility } = setup({ visible: false })
    blocker.start('prevent-display-sleep')
    await flush()
    expect(request).not.toHaveBeenCalled()
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('powerSaveBlocker.stop and isStarted', () => {
  it('isStarted reflects the app\'s ids: true after start, false after stop, false for an unknown id', () => {
    const { blocker } = setup()
    const id = blocker.start('prevent-display-sleep')
    expect(blocker.isStarted(id)).toBe(true)
    expect(blocker.isStarted(id + 100)).toBe(false)
    expect(blocker.stop(id)).toBe(true)
    expect(blocker.isStarted(id)).toBe(false)
    expect(blocker.stop(id)).toBe(false)
  })

  it('keeps the lock while one id is started and releases it when the last stops', async () => {
    const { blocker, sentinels } = setup()
    const a = blocker.start('prevent-display-sleep')
    const b = blocker.start('prevent-display-sleep')
    await flush()
    blocker.stop(a)
    await flush()
    expect(sentinels[0]?.released).toBe(false)
    blocker.stop(b)
    await flush()
    expect(sentinels[0]?.released).toBe(true)
  })

  it('releases a lock that was granted after the last id had already stopped', async () => {
    let grant: (s: Sentinel) => void = () => {}
    const late = sentinel()
    const { blocker } = setup({ request: async () => await new Promise<Sentinel>((resolve) => { grant = resolve }) })
    const id = blocker.start('prevent-display-sleep')
    blocker.stop(id)
    grant(late)
    await flush()
    expect(late.released).toBe(true)
  })

  it('does not ask again for a second start while the first request is still pending', async () => {
    const { blocker, request } = setup({ request: async () => await new Promise<Sentinel>(() => {}) })
    blocker.start('prevent-display-sleep')
    blocker.start('prevent-display-sleep')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('powerSaveBlocker keeps the lock across the platform releasing it', () => {
  it('asks again when the page becomes visible after the platform released the lock', async () => {
    const { blocker, request, sentinels, setVisibility } = setup()
    blocker.start('prevent-display-sleep')
    await flush()
    setVisibility('hidden')
    await sentinels[0]?.release()
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not ask again on visibilitychange while it still holds the lock, or when no id is started', async () => {
    const { blocker, request, setVisibility } = setup()
    setVisibility('visible')
    await flush()
    expect(request).not.toHaveBeenCalled()
    const id = blocker.start('prevent-display-sleep')
    await flush()
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    blocker.stop(id)
    await flush()
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
