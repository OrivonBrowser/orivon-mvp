import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SetupSheet } from '../../install/first-visit.js'
import { blockOpenTabs } from '../block-tabs.js'
import type { TabRef, TabScreens, TabSetup } from '../tab-screens.js'

// An app found to be bad after its tabs were let in: each tab showing it is stopped and emptied whatever its
// beforeunload says, the other pages of its partition are closed, then each tab is covered with the warning and
// sent away when the person has read it.

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
    tab: () => ({ window: {}, tabId: 't' }) as unknown as TabRef,
    navigate: () => { calls.push('navigate') },
    leavePage: () => { calls.push('leavePage') },
    stop: () => { calls.push('stop') }
  }
}

/** The tab a visit let in, by reference: it names whatever contents the tab holds now. */
function refTo (contents: WebContents): TabRef {
  return { window: { tabs: { liveWebContents: () => contents } }, tabId: 'tab-1' } as unknown as TabRef
}

type Veto = (event: { preventDefault: () => void }) => void
interface FakeContents { vetoes: Map<string, Veto> }

function tab (calls: string[], url = `${ORIGIN}/page`): WebContents & FakeContents {
  const vetoes = new Map<string, Veto>()
  return {
    vetoes,
    stop: () => { calls.push('contents.stop') },
    close: () => { calls.push('contents.close') },
    getURL: () => url,
    isDestroyed: () => false,
    on: (event: string, listener: Veto) => { vetoes.set(event, listener) },
    off: (event: string) => { vetoes.delete(event) }
  } as unknown as WebContents & FakeContents
}

const none = (): readonly WebContents[] => []

describe('blockOpenTabs', () => {
  it('stops each tab, empties it, shows the warning and sends it away once the person has read it', async () => {
    const calls: string[] = []
    const setup: TabSetup = vi.fn(() => screensFake(calls))
    const blocking = blockOpenTabs({ tabsOn: () => [tab(calls)], pagesOf: none, setup: () => setup })(ORIGIN, SHEET, undefined)
    await blocking.emptied
    expect(calls.slice(0, 2)).toEqual(['contents.stop', 'blank'])
    await blocking.dismissed
    expect(calls).toEqual(['contents.stop', 'blank', 'sheet:blocked', 'leavePage'])
    expect(setup).toHaveBeenCalledWith(expect.anything(), `${ORIGIN}/page`)
  })

  it('overrules a page that asks to stay, so beforeunload cannot keep it alive, and stops overruling once the page is covered', async () => {
    const calls: string[] = []
    const kept = tab(calls)
    const blocking = blockOpenTabs({ tabsOn: () => [kept], pagesOf: none, setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined)
    const veto = kept.vetoes.get('will-prevent-unload')
    expect(veto).toBeDefined()
    const prevent = vi.fn()
    veto?.({ preventDefault: prevent })
    expect(prevent).toHaveBeenCalled()
    await blocking.dismissed
    expect(kept.vetoes.has('will-prevent-unload')).toBe(false)
  })

  it('closes every other page of the origin\'s partition, a popup or a host, and leaves the tabs to the sheet', async () => {
    const calls: string[] = []
    const covered = tab(calls)
    const popup = tab(calls, `${ORIGIN}/popup`)
    const blocking = blockOpenTabs({ tabsOn: () => [covered], pagesOf: () => [covered, popup], setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined)
    await blocking.emptied
    expect(calls.filter((call) => call === 'contents.close')).toHaveLength(1)
    await blocking.dismissed
  })

  it('does the same for every tab of the origin, in every window', async () => {
    const calls: string[] = []
    const blocking = blockOpenTabs({ tabsOn: () => [tab(calls), tab(calls)], pagesOf: none, setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined)
    await blocking.dismissed
    expect(calls.filter((call) => call === 'sheet:blocked')).toHaveLength(2)
    expect(calls.filter((call) => call === 'leavePage')).toHaveLength(2)
  })

  it('closes a contents no window holds as a tab, which has nowhere to show a sheet', async () => {
    const calls: string[] = []
    const blocking = blockOpenTabs({ tabsOn: () => [tab(calls)], pagesOf: none, setup: () => () => undefined })(ORIGIN, SHEET, undefined)
    await blocking.dismissed
    expect(calls).toEqual(['contents.stop', 'contents.close'])
  })

  it('covers the tab the visit let in even when its first page failed to load and so shows no address of the origin', async () => {
    const calls: string[] = []
    const failed = tab(calls, 'chrome-error://chromewebdata/')
    const setup: TabSetup = vi.fn(() => screensFake(calls))
    await blockOpenTabs({ tabsOn: none, pagesOf: none, setup: () => setup })(ORIGIN, SHEET, refTo(failed)).dismissed
    expect(calls).toEqual(['contents.stop', 'blank', 'sheet:blocked', 'leavePage'])
    expect(setup).toHaveBeenCalledWith(failed, `${ORIGIN}/`)
  })

  it('covers a tab once when it is both named and found', async () => {
    const calls: string[] = []
    const one = tab(calls)
    await blockOpenTabs({ tabsOn: () => [one], pagesOf: none, setup: () => () => screensFake(calls) })(ORIGIN, SHEET, refTo(one)).dismissed
    expect(calls.filter((call) => call === 'sheet:blocked')).toHaveLength(1)
  })

  it('does nothing, and does not throw, when no tab shows the origin or the shell is not up', async () => {
    await expect(blockOpenTabs({ tabsOn: none, pagesOf: none, setup: () => undefined })(ORIGIN, SHEET, undefined).dismissed).resolves.toBeUndefined()
  })

  it('does not wait on a tab that is already gone', async () => {
    const calls: string[] = []
    const gone = { stop: () => { throw new Error('Object has been destroyed') }, getURL: () => { throw new Error('Object has been destroyed') }, isDestroyed: () => true } as unknown as WebContents
    await blockOpenTabs({ tabsOn: () => [gone, tab(calls)], pagesOf: none, setup: () => () => screensFake(calls) })(ORIGIN, SHEET, undefined).dismissed
    expect(calls).toContain('sheet:blocked')
  })
})
