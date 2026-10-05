import { beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
const partitionChanged = vi.fn<(target: string, current: string | undefined) => { to: string | undefined } | undefined>()
const appTabFlagChanged = vi.fn<() => boolean>()
vi.mock('../tab-parking.js', () => ({ repartitionView: (...args: unknown[]) => repartitionView(...args) }))
vi.mock('../tab-partition.js', () => ({ partitionChanged: (target: string, current: string | undefined) => partitionChanged(target, current), appTabFlagChanged: () => appTabFlagChanged() }))

const { loadInTab, repartitionForTarget } = await import('../load-in-tab.js')

const loadURL = vi.fn(async () => {})
const record = (partition: string | undefined): never => ({ partition, view: { webContents: { loadURL } }, host: { broker: undefined } }) as never

beforeEach(() => {
  repartitionView.mockReset()
  loadURL.mockClear()
  partitionChanged.mockReset().mockReturnValue(undefined)
  appTabFlagChanged.mockReset().mockReturnValue(false)
})

describe('repartitionForTarget', () => {
  it('swaps to the target\'s session, which can itself be the default one', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    const tab = record('persist:app')
    expect(repartitionForTarget('t1', tab, 'https://site.eth/')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', undefined)
  })

  it('swaps within the session when only the app-tab flag differs', () => {
    appTabFlagChanged.mockReturnValue(true)
    const tab = record('persist:app')
    expect(repartitionForTarget('t1', tab, 'https://site.eth/')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', 'persist:app')
  })

  it('does nothing when the session and the flag are the tab\'s', () => {
    expect(repartitionForTarget('t1', record(undefined), 'https://site.eth/')).toBe(false)
    expect(repartitionView).not.toHaveBeenCalled()
  })
})

describe('loadInTab', () => {
  it('loads the address in the tab\'s own view when its session fits', () => {
    loadInTab('t1', record(undefined), 'https://site.eth/')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://site.eth/')
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('moves a tab in a cache-served app\'s session to the default one instead of loading there', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    loadInTab('t1', record('persist:app'), 'https://site.eth/')
    expect(repartitionView).toHaveBeenCalledWith('t1', expect.anything(), 'https://site.eth/', undefined)
    expect(loadURL).not.toHaveBeenCalled()
  })
})
