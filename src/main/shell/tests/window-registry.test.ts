import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { WindowRegistry, type ShellWindow } from '../window-registry.js'

function fakeWindow (ownsTab: (contents: WebContents) => string | null): ShellWindow {
  return { window: {}, chrome: {}, tabs: { findTabIdByWebContents: ownsTab } } as unknown as ShellWindow
}

const CONTENTS_A = {} as WebContents
const CONTENTS_B = {} as WebContents

describe('WindowRegistry', () => {
  it('finds a tab in whichever window holds it', () => {
    const registry = new WindowRegistry()
    const first = fakeWindow((c) => (c === CONTENTS_A ? 'tab-1' : null))
    const second = fakeWindow((c) => (c === CONTENTS_B ? 'tab-9' : null))
    registry.add(first)
    registry.add(second)

    expect(registry.findTab(CONTENTS_A)).toEqual({ window: first, tabId: 'tab-1' })
    expect(registry.findTab(CONTENTS_B)).toEqual({ window: second, tabId: 'tab-9' })
  })

  it('finds nothing for a webContents no window holds, such as a page that is not a tab', () => {
    const registry = new WindowRegistry()
    registry.add(fakeWindow(() => null))

    expect(registry.findTab({} as WebContents)).toBeNull()
  })

  it('forgets a window once its removal has run', () => {
    const registry = new WindowRegistry()
    const window = fakeWindow((c) => (c === CONTENTS_A ? 'tab-1' : null))
    const forget = registry.add(window)
    expect(registry.all()).toEqual([window])

    forget()

    expect(registry.all()).toEqual([])
    expect(registry.findTab(CONTENTS_A)).toBeNull()
  })
})
