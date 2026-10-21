import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { TabScreens } from '../../app-setup/tab-screens.js'
import { createUpdateCover } from '../update-cover.js'
import type { UpdateOffer } from '../app-updates.js'

const ORIGIN = 'https://app.example'

const OFFER: UpdateOffer = { origin: ORIGIN, fromCid: 'a', toCid: 'b', fromVersion: '1.0.0', toVersion: '1.1.0', claimedName: 'Notes', level: undefined, verified: false, reasons: [], newDomain: undefined }

interface FakeTab { readonly contents: WebContents, readonly reloads: string[], destroyed: boolean, readonly screens: ReturnType<typeof fakeScreens> }

function fakeScreens (): { api: TabScreens, readonly calls: string[], moved: boolean } {
  const state = { calls: [] as string[], moved: false, api: undefined as unknown as TabScreens }
  state.api = {
    cover: (cover: unknown) => { state.calls.push(`cover ${JSON.stringify(cover)}`) },
    reloadFresh: () => { state.calls.push('reloadFresh') },
    end: () => { state.calls.push('end') },
    moved: () => state.moved
  } as unknown as TabScreens
  return state
}

function tab (hasScreens = true): FakeTab {
  const reloads: string[] = []
  const screens = fakeScreens()
  const self: FakeTab = { reloads, destroyed: false, screens, contents: undefined as never }
  ;(self as { contents: WebContents }).contents = {
    isDestroyed: () => self.destroyed,
    getURL: () => `${ORIGIN}/`,
    reloadIgnoringCache: () => { reloads.push('reloadIgnoringCache') },
    hasScreens
  } as unknown as WebContents
  return self
}

function rig (tabs: FakeTab[]): ReturnType<typeof createUpdateCover> {
  return createUpdateCover({
    tabsOn: () => tabs.filter((candidate) => !candidate.destroyed).map((candidate) => candidate.contents),
    screensFor: (contents) => {
      const found = tabs.find((candidate) => candidate.contents === contents)
      return found === undefined || (contents as unknown as { hasScreens: boolean }).hasScreens === false ? undefined : found.screens.api
    }
  })
}

describe('covering the tabs of an app being updated', () => {
  it('covers every open tab at once with the app\'s name and both versions', () => {
    const tabs = [tab(), tab()]
    rig(tabs)(ORIGIN, OFFER)
    for (const one of tabs) expect(one.screens.calls).toEqual([`cover ${JSON.stringify({ kind: 'updating', name: 'Notes', fromVersion: '1.0.0', toVersion: '1.1.0' })}`])
  })

  it('reloads each covered tab through its screens, which uncover it once the new page is ready', () => {
    const tabs = [tab(), tab()]
    rig(tabs)(ORIGIN, OFFER).reloadThenEnd()
    for (const one of tabs) {
      expect(one.screens.calls.at(-1)).toBe('reloadFresh')
      expect(one.reloads).toEqual([])
    }
  })

  it('reloads from the network a tab opened during the update, and one that has no screens', () => {
    const late = tab()
    const bare = tab(false)
    const tabs = [bare]
    const cover = rig(tabs)(ORIGIN, OFFER)
    tabs.push(late)
    cover.reloadThenEnd()
    expect(bare.reloads).toEqual(['reloadIgnoringCache'])
    expect(late.reloads).toEqual(['reloadIgnoringCache'])
    expect(late.screens.calls).toEqual([])
  })

  it('reloads a tab that went away and came back without a cover, instead of waiting on its ended screens', () => {
    const one = tab()
    const cover = rig([one])(ORIGIN, OFFER)
    one.screens.moved = true
    cover.reloadThenEnd()
    expect(one.reloads).toEqual(['reloadIgnoringCache'])
    expect(one.screens.calls).not.toContain('reloadFresh')
  })

  it('skips a tab that was destroyed, before or during the update', () => {
    const gone = tab()
    gone.destroyed = true
    const closing = tab()
    const cover = rig([gone, closing])(ORIGIN, OFFER)
    expect(gone.screens.calls).toEqual([])
    closing.destroyed = true
    expect(() => { cover.reloadThenEnd() }).not.toThrow()
    expect(closing.reloads).toEqual([])
  })

  it('end uncovers every tab and reloads none', () => {
    const tabs = [tab(), tab()]
    rig(tabs)(ORIGIN, OFFER).end()
    for (const one of tabs) {
      expect(one.screens.calls.at(-1)).toBe('end')
      expect(one.reloads).toEqual([])
    }
  })

  it('is settled by the first of end and reloadThenEnd', () => {
    const one = tab()
    const cover = rig([one])(ORIGIN, OFFER)
    cover.reloadThenEnd()
    cover.end()
    expect(one.screens.calls.filter((call) => call === 'end')).toEqual([])
    const two = tab()
    const other = rig([two])(ORIGIN, OFFER)
    other.end()
    other.reloadThenEnd()
    expect(two.screens.calls).not.toContain('reloadFresh')
    expect(two.reloads).toEqual([])
  })
})
