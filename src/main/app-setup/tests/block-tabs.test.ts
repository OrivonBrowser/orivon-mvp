import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SetupSheet } from '../../install/first-visit.js'
import { blockOpenTabs } from '../block-tabs.js'
import type { TabRef, TabScreens, TabSetup } from '../tab-screens.js'

// An app found to be bad after its tabs were let in: each tab showing it is stopped, emptied, covered with the
// warning, and sent away when the person has read it.

const ORIGIN = 'https://abc.ipfs.orivon'
const SHEET: SetupSheet = { kind: 'blocked', name: 'Ledger', differing: ['/app.js'], differingCount: 1, rootMatches: true }

function screensFake (calls: string[], choice: 'leave' | 'retry' = 'leave'): TabScreens {
  return {
    show: () => { calls.push('show') },
    blank: async () => { calls.push('blank') },
    sheet: async (sheet) => { calls.push(`sheet:${sheet.kind}`); return choice },
    end: () => { calls.push('end') },
    moved: () => false,
    signal: new AbortController().signal,
    navigate: () => { calls.push('navigate') },
    tab: () => ({ window: {}, tabId: 't' }) as unknown as TabRef,
    leavePage: () => { calls.push('leavePage') },
    stop: () => { calls.push('stop') }
  }
}

/** The tab a visit let in, by reference: it names whatever contents the tab holds now. */
function refTo (contents: WebContents): TabRef {
  return { window: { tabs: { liveWebContents: () => contents } }, tabId: 'tab-1' } as unknown as TabRef
}

function tab (calls: string[]): WebContents {
  return { stop: () => { calls.push('contents.stop') }, getURL: () => `${ORIGIN}/page`, isDestroyed: () => false } as unknown as WebContents
}

describe('blockOpenTabs', () => {
  it('stops each tab, empties it, shows the warning and sends it away once the person has read it', async () => {
    const calls: string[] = []
    const setup: TabSetup = vi.fn(() => screensFake(calls))
    await blockOpenTabs({ tabsOn: () => [tab(calls)], setup: () => setup })(ORIGIN, SHEET, undefined)
    expect(calls).toEqual(['contents.stop', 'blank', 'sheet:blocked', 'leavePage'])
    expect(setup).toHaveBeenCalledWith(expect.anything(), `${ORIGIN}/page`)
  })

  it('does the same for every tab of the origin, in every window', async () => {
    const calls: string[] = []
    await blockOpenTabs({ tabsOn: () => [tab(calls), tab(calls)], setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined)
    expect(calls.filter((call) => call === 'sheet:blocked')).toHaveLength(2)
    expect(calls.filter((call) => call === 'leavePage')).toHaveLength(2)
  })

  it('stops a contents no window holds as a tab, which has nowhere to show a sheet', async () => {
    const calls: string[] = []
    await blockOpenTabs({ tabsOn: () => [tab(calls)], setup: () => () => undefined })(ORIGIN, SHEET, undefined)
    expect(calls).toEqual(['contents.stop'])
  })

  it('covers the tab the visit let in even when its first page failed to load and so shows no address of the origin', async () => {
    const calls: string[] = []
    const failed = { stop: () => { calls.push('contents.stop') }, getURL: () => 'chrome-error://chromewebdata/', isDestroyed: () => false } as unknown as WebContents
    const setup: TabSetup = vi.fn(() => screensFake(calls))
    await blockOpenTabs({ tabsOn: () => [], setup: () => setup })(ORIGIN, SHEET, refTo(failed))
    expect(calls).toEqual(['contents.stop', 'blank', 'sheet:blocked', 'leavePage'])
    expect(setup).toHaveBeenCalledWith(failed, `${ORIGIN}/`)
  })

  it('covers a tab once when it is both named and found', async () => {
    const calls: string[] = []
    const one = tab(calls)
    await blockOpenTabs({ tabsOn: () => [one], setup: () => () => screensFake(calls) })(ORIGIN, SHEET, refTo(one))
    expect(calls.filter((call) => call === 'sheet:blocked')).toHaveLength(1)
  })

  it('does nothing, and does not throw, when no tab shows the origin or the shell is not up', async () => {
    await expect(blockOpenTabs({ tabsOn: () => [], setup: () => undefined })(ORIGIN, SHEET, undefined)).resolves.toBeUndefined()
  })

  it('does not wait on a tab that is already gone', async () => {
    const calls: string[] = []
    const gone = { stop: () => { throw new Error('Object has been destroyed') }, getURL: () => { throw new Error('Object has been destroyed') }, isDestroyed: () => true } as unknown as WebContents
    await blockOpenTabs({ tabsOn: () => [gone, tab(calls)], setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined)
    expect(calls).toContain('sheet:blocked')
  })
})
