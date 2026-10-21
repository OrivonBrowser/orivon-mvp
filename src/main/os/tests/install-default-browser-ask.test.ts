import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { APP_OPEN_BEAT_MS, DAY_MS, firstSight } from '../default-browser-ask.js'
import type { AskState } from '../default-browser-ask.js'
import type { DefaultBrowserHost, Launcher } from '../default-browser.js'
import { askPlace, createDefaultBrowserCheck, installDefaultBrowserAsk, RETRY_MS } from '../install-default-browser-ask.js'
import type { AskPlace } from '../install-default-browser-ask.js'

// Local wall-clock time, so the second calendar day means the same in every zone the test runs in.
const NOW = new Date(2027, 0, 15, 14, 0, 0).getTime()
const HOUR_MS = 60 * 60 * 1000
const PLACE = { window: {}, tabId: 't1' } as unknown as AskPlace

interface Setup { run: () => Promise<number>, written: AskState[], asked: ReturnType<typeof vi.fn>, host: DefaultBrowserHost & { isDefault: ReturnType<typeof vi.fn>, setDefault: ReturnType<typeof vi.fn> }, place: ReturnType<typeof vi.fn> }

function setup (over: { state?: AskState | string, now?: number, appOpenedAt?: number, place?: AskPlace | undefined, response?: number, registered?: boolean, launcher?: Launcher } = {}): Setup {
  const written: AskState[] = []
  const registered = { value: over.registered ?? false }
  const host = {
    platform: 'linux' as const,
    launcher: over.launcher ?? 'installed',
    isDefault: vi.fn(async () => registered.value),
    setDefault: vi.fn(() => { registered.value = true; return true }),
    openSettings: vi.fn(async () => {})
  }
  const text = typeof over.state === 'string' ? over.state : over.state === undefined ? undefined : JSON.stringify(over.state)
  const asked = vi.fn(async () => ({ response: over.response ?? 1, checkboxChecked: false }))
  const place = vi.fn(() => ('place' in over ? over.place : PLACE))
  const run = createDefaultBrowserCheck({
    now: () => over.now ?? NOW,
    appOpenedAt: () => over.appOpenedAt,
    read: () => text,
    write: (written_) => { written.push(JSON.parse(written_) as AskState) },
    host,
    place,
    ask: asked,
    wait: async () => {}
  })
  return { run, written, asked, host, place }
}

const seen = (daysAgo: number, askedDaysAgo = daysAgo): AskState => ({ firstSeenAt: NOW - daysAgo * DAY_MS, lastAskedAt: NOW - askedDaysAgo * DAY_MS, stopped: false })

describe('the weekly default-browser check', () => {
  it('writes a first sight once a window is in use on a profile it has not seen, asks nothing, and looks again within the hour', async () => {
    const s = setup()
    expect(await s.run()).toBe(HOUR_MS)
    expect(s.written).toEqual([firstSight(NOW)])
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.host.isDefault).not.toHaveBeenCalled()
  })

  it('does not start the clock while no window is in use, the welcome screen and its popup included, and looks again soon', async () => {
    const s = setup({ place: undefined })
    expect(await s.run()).toBe(RETRY_MS)
    expect(s.written).toEqual([])
    expect(s.host.isDefault).not.toHaveBeenCalled()
  })

  it('never asks on the first day while no app has opened, however long the browser has been in use', async () => {
    const s = setup({ state: firstSight(NOW - 10 * HOUR_MS) })
    expect(await s.run()).toBe(HOUR_MS)
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.host.isDefault).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('asks once, with all three buttons, a beat after the first app opened, and the answer starts the weekly count', async () => {
    const openedAt = NOW - APP_OPEN_BEAT_MS + 1_000
    const early = setup({ state: firstSight(NOW - 60_000), appOpenedAt: openedAt })
    expect(await early.run()).toBe(1_000)
    expect(early.asked).not.toHaveBeenCalled()

    const s = setup({ state: firstSight(NOW - 60_000), appOpenedAt: NOW - APP_OPEN_BEAT_MS, response: 1 })
    expect(await s.run()).toBe(HOUR_MS)
    const spec = (s.asked.mock.calls[0] as [AskPlace, { buttons: string[], title: string }])[1]
    expect(spec.title).toBe('Make Orivon your default browser?')
    expect(spec.buttons).toEqual(['Make default', 'Not now', 'Don\'t ask again'])
    expect(s.written).toEqual([{ firstSeenAt: NOW - 60_000, lastAskedAt: NOW, stopped: false }])

    // The app opened again later in the same run: the weekly count governs now.
    const again = setup({ state: { firstSeenAt: NOW - 60_000, lastAskedAt: NOW, stopped: false }, appOpenedAt: NOW - APP_OPEN_BEAT_MS })
    await again.run()
    expect(again.asked).not.toHaveBeenCalled()
  })

  it('waits for a window to ask in after an app opened, and asks nothing meanwhile', async () => {
    const s = setup({ state: firstSight(NOW - 60_000), appOpenedAt: NOW - APP_OPEN_BEAT_MS, place: undefined })
    expect(await s.run()).toBe(RETRY_MS)
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('starts the clock and asks at once when an app opened before the profile was first seen in use', async () => {
    const s = setup({ appOpenedAt: NOW - APP_OPEN_BEAT_MS, response: 1 })
    await s.run()
    expect(s.asked).toHaveBeenCalledTimes(1)
    expect(s.written).toEqual([firstSight(NOW), { firstSeenAt: NOW, lastAskedAt: NOW, stopped: false }])
  })

  it('asks on the second calendar day without any app opening', async () => {
    const yesterdayEvening = new Date(2027, 0, 14, 23, 0, 0).getTime()
    const s = setup({ state: firstSight(yesterdayEvening), response: 1 })
    await s.run()
    expect(s.asked).toHaveBeenCalledTimes(1)
    expect(s.written).toEqual([{ firstSeenAt: yesterdayEvening, lastAskedAt: NOW, stopped: false }])
  })

  it('stops for good when the person chooses "Don\'t ask again" on the very first ask', async () => {
    const s = setup({ state: firstSight(NOW - 60_000), appOpenedAt: NOW - APP_OPEN_BEAT_MS, response: 2 })
    await s.run()
    expect(s.written).toEqual([{ firstSeenAt: NOW - 60_000, lastAskedAt: null, stopped: true }])
    const later = setup({ state: s.written[0] as AskState, now: NOW + 30 * DAY_MS, appOpenedAt: NOW })
    await later.run()
    expect(later.asked).not.toHaveBeenCalled()
  })

  it('keeps an already asked profile on its weekly count, whether or not an app opens', async () => {
    const s = setup({ state: seen(2), appOpenedAt: NOW - APP_OPEN_BEAT_MS })
    expect(await s.run()).toBe(HOUR_MS)
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('does not query the system or look for a window before an ask is due, and looks again within the hour', async () => {
    const s = setup({ state: seen(6) })
    expect(await s.run()).toBe(HOUR_MS)
    expect(s.host.isDefault).not.toHaveBeenCalled()
    expect(s.place).not.toHaveBeenCalled()
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('asks again a week after the last ask, and Not now writes the time of the ask', async () => {
    const s = setup({ state: seen(8, 8), response: 1 })
    await s.run()
    expect(s.asked).toHaveBeenCalledTimes(1)
    const spec = (s.asked.mock.calls[0] as [AskPlace, { buttons: string[], cancelId: number, guarded: number[], kind: string }])[1]
    expect(spec.buttons).toEqual(['Make default', 'Not now', 'Don\'t ask again'])
    expect(spec).toMatchObject({ kind: 'notice', cancelId: 1, guarded: [0] })
    // A prompt that appears unprompted must not put a key meant for the page on the button that changes the system.
    expect((spec as { focus?: unknown }).focus).toBe('dialog')
    expect(s.written).toEqual([{ firstSeenAt: NOW - 8 * DAY_MS, lastAskedAt: NOW, stopped: false }])
    expect(s.host.setDefault).not.toHaveBeenCalled()
  })

  it('stops the ask for good when "Don\'t ask again" is chosen', async () => {
    const s = setup({ state: seen(15, 8), response: 2 })
    await s.run()
    expect(s.written).toEqual([{ firstSeenAt: NOW - 15 * DAY_MS, lastAskedAt: NOW - 8 * DAY_MS, stopped: true }])
  })

  it('never asks once stopped', async () => {
    const s = setup({ state: { ...seen(40, 30), stopped: true } })
    await s.run()
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.host.isDefault).not.toHaveBeenCalled()
  })

  it('treats a cancel like Not now', async () => {
    const s = setup({ state: seen(8), response: 1 })
    await s.run()
    expect(s.written[0]?.lastAskedAt).toBe(NOW)
  })

  it('registers when the person says Make default, and still records the ask', async () => {
    const s = setup({ state: seen(8), response: 0 })
    await s.run()
    expect(s.host.setDefault.mock.calls).toEqual([['http'], ['https']])
    expect(s.written).toEqual([{ firstSeenAt: NOW - 8 * DAY_MS, lastAskedAt: NOW, stopped: false }])
  })

  it('records an ask silently when Orivon already is the default', async () => {
    const s = setup({ state: seen(8), registered: true })
    await s.run()
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.written).toEqual([{ firstSeenAt: NOW - 8 * DAY_MS, lastAskedAt: NOW, stopped: false }])
  })

  it('waits, records nothing, and looks again soon when no window is in a state to be asked in', async () => {
    const s = setup({ state: seen(8), place: undefined })
    expect(await s.run()).toBe(RETRY_MS)
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.host.isDefault).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('asks nothing of a run that cannot register', async () => {
    const s = setup({ state: seen(8), launcher: 'source' })
    await s.run()
    expect(s.asked).not.toHaveBeenCalled()
    expect(s.written).toEqual([])
  })

  it('treats a corrupt file as a profile not seen yet: a first sight, and nothing asked', async () => {
    const s = setup({ state: 'garbage{' })
    expect(await s.run()).toBe(HOUR_MS)
    expect(s.written).toEqual([firstSight(NOW)])
    expect(s.asked).not.toHaveBeenCalled()
  })

  it('does not ask twice while a question is open', async () => {
    let answer: (value: { response: number, checkboxChecked: boolean }) => void = () => {}
    const s = setup({ state: seen(8) })
    s.asked.mockImplementation(async () => await new Promise((resolve) => { answer = resolve }))
    const first = s.run()
    await vi.waitFor(() => { expect(s.asked).toHaveBeenCalledTimes(1) })
    await s.run()
    expect(s.asked).toHaveBeenCalledTimes(1)
    answer({ response: 1, checkboxChecked: false })
    await first
  })
})

function windowFake (over: { focused?: boolean, tabFocused?: boolean, visible?: boolean, minimized?: boolean, destroyed?: boolean, active?: string | null, restoreOpen?: boolean } = {}): ShellWindow {
  return {
    window: { isDestroyed: () => over.destroyed ?? false, isVisible: () => over.visible ?? true, isMinimized: () => over.minimized ?? false, isFocused: () => over.focused ?? true },
    chrome: { webContents: { isFocused: () => false } },
    tabs: { getState: () => ({ activeTabId: 'active' in over ? over.active : 't1' }), activeWebContents: () => ({ isFocused: () => over.tabFocused ?? false }) },
    overlays: { isOpen: (name: string) => name === 'restore' && over.restoreOpen === true }
  } as unknown as ShellWindow
}

const place = (target: ShellWindow | undefined, intro = false): ReturnType<typeof askPlace> => askPlace({ focused: () => target }, () => intro)

describe('where the ask may be shown', () => {
  it('is the active tab of the window in use', () => {
    const target = windowFake()
    expect(place(target)).toEqual({ window: target, tabId: 't1' })
  })

  it('accepts a window whose page has the focus when the window itself was never activated', () => {
    expect(place(windowFake({ focused: false, tabFocused: true }))).toBeDefined()
  })

  it('waits when there is no window, it is not in use, hidden, minimised, gone or has no tab', () => {
    expect(place(undefined)).toBeUndefined()
    expect(place(windowFake({ focused: false }))).toBeUndefined()
    expect(place(windowFake({ visible: false }))).toBeUndefined()
    expect(place(windowFake({ minimized: true }))).toBeUndefined()
    expect(place(windowFake({ destroyed: true }))).toBeUndefined()
    expect(place(windowFake({ active: null }))).toBeUndefined()
  })

  it('waits under the welcome screen and beside the restore bar', () => {
    expect(place(windowFake(), true)).toBeUndefined()
    expect(place(windowFake({ restoreOpen: true }))).toBeUndefined()
  })

  it('waits while the tab has a sheet or a prompt on screen or waiting, such as an app\'s consent question', () => {
    const target = windowFake()
    expect(askPlace({ focused: () => target }, () => false, () => true)).toBeUndefined()
    expect(askPlace({ focused: () => target }, () => false, (window, tabId) => window === target && tabId === 't1')).toBeUndefined()
    expect(askPlace({ focused: () => target }, () => false, () => false)).toEqual({ window: target, tabId: 't1' })
  })
})

describe('the installer', () => {
  it('starts nothing for another profile, a private session or a kiosk', () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    for (const [profileId, isPrivate, kiosk] of [['0123456789ab', false, false], ['private', true, false], ['default', false, true]] as const) {
      installDefaultBrowserAsk.install({} as never, { kiosk, windows: {} } as never, {} as never, { profileId, isPrivate, dir: '/x' } as never)
    }
    expect(timers).not.toHaveBeenCalled()
    timers.mockRestore()
  })
})
