import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { createStorageAccessAsker } from '../storage-access.js'

const tab = {} as unknown as WebContents
const embed = {} as unknown as WebContents

function asker (blocking: boolean): ReturnType<typeof createStorageAccessAsker> {
  return createStorageAccessAsker({ blocking: () => blocking, isTab: (contents) => contents === tab })
}

describe('the storage-access asker', () => {
  it('allows both names silently while every cookie is allowed', async () => {
    const a = asker(false)
    for (const name of ['storage-access', 'top-level-storage-access']) {
      expect(await a.request?.(tab, name, {})).toBe(true)
      expect(a.check?.(tab, name, 'https://x', {})).toBe(true)
    }
  })

  it('refuses both while third-party cookies are blocked', async () => {
    const a = asker(true)
    for (const name of ['storage-access', 'top-level-storage-access']) {
      expect(await a.request?.(tab, name, {})).toBe(false)
      expect(a.check?.(tab, name, 'https://x', {})).toBe(false)
    }
  })

  it('answers nothing for any other permission', () => {
    const a = asker(false)
    for (const name of ['media', 'geolocation', 'clipboard-read', 'notifications']) {
      expect(a.request?.(tab, name, {})).toBeUndefined()
      expect(a.check?.(tab, name, 'https://x', {})).toBeUndefined()
    }
  })

  it('answers nothing for a context that is not a tab, or has no contents', () => {
    const a = asker(false)
    expect(a.request?.(embed, 'storage-access', {})).toBeUndefined()
    expect(a.check?.(embed, 'storage-access', 'https://x', {})).toBeUndefined()
    expect(a.check?.(null, 'storage-access', 'https://x', {})).toBeUndefined()
  })

  it('reads the setting on every question', () => {
    let blocking = false
    const a = createStorageAccessAsker({ blocking: () => blocking, isTab: () => true })
    expect(a.check?.(tab, 'storage-access', '', {})).toBe(true)
    blocking = true
    expect(a.check?.(tab, 'storage-access', '', {})).toBe(false)
  })
})
