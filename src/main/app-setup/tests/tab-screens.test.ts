import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { isCoverClaimed } from '../../loading-screen/claim.js'
import { answerSheet } from '../setup-sheet-overlay.js'
import { createTabSetup } from '../tab-screens.js'

const WINDOW = {} as unknown as ShellWindow
const ADDRESS = 'https://abc.ipfs.orivon/'

function rig (): { contents: EventEmitter, asks: SlotAsk[], cancels: Array<ReturnType<typeof vi.fn>>, navigated: string[], setup: ReturnType<typeof createTabSetup> } {
  const contents = new EventEmitter()
  const asks: SlotAsk[] = []
  const cancels: Array<ReturnType<typeof vi.fn>> = []
  const navigated: string[] = []
  let tokens = 0
  const setup = createTabSetup({
    findTab: (candidate) => candidate === (contents as unknown as WebContents) ? { window: WINDOW, tabId: 't1' } : null,
    ask: (ask) => {
      asks.push(ask)
      const cancel = vi.fn(() => { ask.closed('request') })
      cancels.push(cancel)
      return { cancel }
    },
    prewarm: () => {},
    newToken: () => `token-${String(tokens++)}`,
    navigate: (_window, _tabId, url) => { navigated.push(url) }
  })
  return { contents, asks, cancels, navigated, setup }
}

const asContents = (contents: EventEmitter): WebContents => contents as unknown as WebContents

describe('createTabSetup', () => {
  it('has no screens for a web contents the window does not know', () => {
    const { setup } = rig()
    expect(setup(new EventEmitter() as unknown as WebContents, ADDRESS)).toBeUndefined()
  })

  it('covers the tab with the stage\'s words, and holds the protocol\'s own screen off', () => {
    const { contents, asks, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    screens.show({ kind: 'asking', name: 'Ledger' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ window: WINDOW, tabId: 't1', slot: 'cover', overlay: 'loading-screen' })
    expect(asks[0]!.payload).toMatchObject({ url: ADDRESS, text: { title: 'Opening Ledger', busy: true } })
    expect(isCoverClaimed(contents)).toBe(true)
    screens.show({ kind: 'verifying', name: 'Ledger' })
    expect(asks[1]!.payload).toMatchObject({ text: { title: 'Setting up Ledger' } })
    screens.end()
    expect(isCoverClaimed(contents)).toBe(false)
  })

  it('shows a sheet in the centre over a cover that has stopped moving, and answers what the page answered', async () => {
    const { contents, asks, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    screens.show({ kind: 'verifying', name: 'Ledger' })
    const answer = screens.sheet({ kind: 'download-failed', name: 'Ledger', reason: 'gateway 502' })
    const sheet = asks.find((ask) => ask.slot === 'center')!
    expect(sheet.overlay).toBe('app-setup-sheet')
    expect(sheet.payload).toMatchObject({ token: 'token-0', kind: 'download-failed', canRetry: true })
    expect(asks.at(-2)!.payload).toMatchObject({ text: { busy: false } })
    expect(answerSheet('token-0', 'retry')).toBe(true)
    await expect(answer).resolves.toBe('retry')
    expect(answerSheet('token-0', 'retry')).toBe(false)
  })

  it('answers leave when the sheet is closed without an answer', async () => {
    const { contents, asks, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    const answer = screens.sheet({ kind: 'blocked', name: 'Ledger', differing: ['/a.js'], differingCount: 1, rootMatches: true })
    asks.find((ask) => ask.slot === 'center')!.closed('tab-switch')
    await expect(answer).resolves.toBe('leave')
    expect(answerSheet('token-0', 'leave')).toBe(false)
  })

  it('takes every screen away at the end, and shows nothing afterwards', () => {
    const { contents, asks, cancels, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    screens.show({ kind: 'asking', name: 'L' })
    void screens.sheet({ kind: 'blocked', name: 'L', differing: [], differingCount: 0, rootMatches: false })
    screens.end()
    // The cover the sheet replaced is the slot's to end; the live cover and the sheet are this visit's.
    expect(cancels.at(-1)).toHaveBeenCalled()
    expect(cancels.at(-2)).toHaveBeenCalled()
    const before = asks.length
    screens.show({ kind: 'verifying', name: 'L' })
    expect(asks).toHaveLength(before)
  })

  it('knows the tab moved on when another page starts loading, and takes its screens away', async () => {
    const { contents, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    screens.show({ kind: 'asking', name: 'L' })
    const answer = screens.sheet({ kind: 'blocked', name: 'L', differing: [], differingCount: 0, rootMatches: false })
    expect(screens.moved()).toBe(false)
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(screens.moved()).toBe(false)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(screens.moved()).toBe(true)
    await expect(answer).resolves.toBe('leave')
    expect(isCoverClaimed(contents)).toBe(false)
  })

  it('knows the tab moved on when it is destroyed', () => {
    const { contents, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    contents.emit('destroyed')
    expect(screens.moved()).toBe(true)
  })

  it('goes into the app through the address bar\'s own path, so the tab swaps to the app\'s session before it loads', () => {
    const { contents, navigated, setup } = rig()
    const screens = setup(asContents(contents), ADDRESS)!
    screens.navigate('https://abc.ipfs.orivon/page')
    expect(navigated).toEqual(['https://abc.ipfs.orivon/page'])
  })
})
