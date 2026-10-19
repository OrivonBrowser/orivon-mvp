import { describe, expect, it } from 'vitest'
import { createWakeLockAsker } from '../wake-lock-asker.js'

const TAB = { id: 1 } as never
const OTHER = { id: 2 } as never
const asker = createWakeLockAsker({ isTab: (contents) => contents === TAB })

describe('createWakeLockAsker', () => {
  it('grants the screen wake lock to a tab\'s top frame, on both handlers', async () => {
    expect(await asker.request?.(TAB, 'screen-wake-lock', { isMainFrame: true })).toBe(true)
    expect(asker.check?.(TAB, 'screen-wake-lock', 'https://a.example', { isMainFrame: true })).toBe(true)
  })

  it('refuses an embedded frame, and details that do not say the frame is the top one', async () => {
    for (const details of [{ isMainFrame: false }, {}, undefined, null, { isMainFrame: 'true' }]) {
      expect(await asker.request?.(TAB, 'screen-wake-lock', details)).toBe(false)
      expect(asker.check?.(TAB, 'screen-wake-lock', 'https://a.example', details)).toBe(false)
    }
  })

  it('refuses a page that is not a tab, and a check Electron gives no contents for', async () => {
    expect(await asker.request?.(OTHER, 'screen-wake-lock', { isMainFrame: true })).toBe(false)
    expect(asker.check?.(OTHER, 'screen-wake-lock', 'https://a.example', { isMainFrame: true })).toBe(false)
    expect(asker.check?.(null, 'screen-wake-lock', 'https://a.example', { isMainFrame: true })).toBe(false)
  })

  it('leaves every other name, the system wake lock included, to the gate', () => {
    for (const permission of ['system-wake-lock', 'fullscreen', 'media', 'geolocation', 'idle-detection']) {
      expect(asker.request?.(TAB, permission, { isMainFrame: true })).toBeUndefined()
      expect(asker.check?.(TAB, permission, 'https://a.example', { isMainFrame: true })).toBeUndefined()
    }
  })
})
