import { describe, expect, it } from 'vitest'
import type { TabScreens } from '../tab-screens.js'
import { tabHost } from '../tab-host.js'

function rig (): { calls: string[], screens: TabScreens } {
  const calls: string[] = []
  const TAB = { window: {}, tabId: 't' } as never
  const screens: TabScreens = {
    blank: async () => { calls.push('blank') },
    sheet: async () => 'retry',
    end: () => { calls.push('end') },
    moved: () => false,
    signal: new AbortController().signal,
    tab: () => TAB,
    navigate: (url) => { calls.push(`navigate:${url}`) },
    leavePage: () => { calls.push('leavePage') },
    stop: () => { calls.push('stop') }
  }
  return { calls, screens }
}

describe('tabHost: a first visit in the tab the page is already running in', () => {
  it('enters by loading the address again, read at the moment of entering', () => {
    const { calls, screens } = rig()
    let address = 'https://a.example/one'
    const host = tabHost(screens, () => address)
    address = 'https://a.example/two'
    host.enter()
    expect(calls).toEqual(['navigate:https://a.example/two'])
  })

  it('leaves the page as the ordinary website it is when the app is not entered, and only ends its screens', () => {
    const { calls, screens } = rig()
    const host = tabHost(screens, () => 'https://a.example/')
    host.plain()
    host.end()
    expect(calls).toEqual(['end', 'end'])
  })

  it('hands the sheet and the tab to the tab\'s screens', async () => {
    const { screens } = rig()
    const host = tabHost(screens, () => 'x')
    await expect(host.sheet({ kind: 'download-failed', name: 'L', reason: 'x' })).resolves.toBe('retry')
    expect(host.tab?.()).toBeDefined()
  })
})
