import { beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))
let own = true
vi.mock('../tab-partition.js', () => ({ partitionForTarget: () => own ? 'persist:site-x' : undefined }))

const { installSiteSessions } = await import('../install-site-sessions.js')

interface Fakes {
  changeHub: (origin: string) => void
  changeSetting: (key: string) => void
  settle: () => void
  install: () => void
}

function fakes (unreadable = false): Fakes & { records: Map<string, unknown> } {
  let onHub: ((origin: string) => void) | undefined
  let onSetting: ((change: { key: string }) => void) | undefined
  let release: () => void = () => {}
  const settled = new Promise<void>((resolve) => { release = resolve })
  const records = new Map<string, unknown>([['t1', { partition: undefined, isDashboardTab: false, internalPage: null, sleeping: null }]])
  const window = {
    tabs: {
      ids: () => ['t1'],
      record: (id: string) => records.get(id),
      liveWebContents: () => ({ getURL: () => 'https://news.example/a' })
    }
  }
  const ctx = {
    routes: {
      hub: { onChange: (listener: (origin: string) => void) => { onHub = listener; return () => {} }, unreadable: () => unreadable },
      controller: { settled: async () => { await settled } }
    }
  }
  const services = {
    windows: { all: () => [window], liveTabOrigins: () => ['https://news.example'] },
    settings: { onChange: (listener: (change: { key: string }) => void) => { onSetting = listener; return () => {} } }
  }
  return {
    records,
    changeHub: (origin) => { onHub?.(origin) },
    changeSetting: (key) => { onSetting?.({ key }) },
    settle: () => { release() },
    install: () => { installSiteSessions.install({} as never, services as never, ctx as never, {} as never) }
  }
}

beforeEach(() => { repartitionView.mockClear(); own = true })

describe('moving tabs when a website\'s tunnel changes', () => {
  it('waits for the sessions to follow the switch, then moves the tabs on that website into the session its state calls for', async () => {
    const world = fakes()
    world.install()
    world.changeHub('https://news.example')
    await Promise.resolve()
    expect(repartitionView).not.toHaveBeenCalled()
    world.settle()
    await vi.waitFor(() => { expect(repartitionView).toHaveBeenCalledWith('t1', world.records.get('t1'), 'https://news.example/a', 'persist:site-x') })
  })

  it('moves nothing for a website none of whose tabs is open', async () => {
    const world = fakes()
    world.install()
    world.settle()
    world.changeHub('https://other.example')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('moves the open websites when the tunnel is set while the list of settings cannot be read, and not otherwise', async () => {
    const readable = fakes(false)
    readable.install()
    readable.settle()
    readable.changeSetting('network.route.proxy')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()

    const broken = fakes(true)
    broken.install()
    broken.settle()
    broken.changeSetting('privacy.cookies')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()
    broken.changeSetting('network.route.proxy')
    await vi.waitFor(() => { expect(repartitionView).toHaveBeenCalledTimes(1) })
  })

  it('does nothing when routes are not running', () => {
    expect(() => { installSiteSessions.install({} as never, {} as never, {} as never, {} as never) }).not.toThrow()
  })
})
