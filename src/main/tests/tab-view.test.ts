import { describe, expect, it } from 'vitest'
import { originFromUrl } from '../../broker/policy/origin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import type { Broker } from '../../broker/broker-contracts.js'

// tab-view.ts imports WebContentsView from 'electron' at module scope, so
// even these pure functions cannot be imported without mocking it first --
// same reasoning tabs.test.ts states for itself.
import { vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: vi.fn() }))
const { partitionChanged, partitionForTarget } = await import('../tab-view.js')

const APP = 'https://app.example'
const SITE = 'https://news.example'
const OTHER_SITE = 'https://search.example'

/** Only `APP` is an installed Orivon app. Everything else is an ordinary
 * website, which is the case the whole isolate-only-apps rule turns on. */
function brokerWith (...appOrigins: string[]): Broker {
  return {
    app: { isRegisteredSync: (origin: string) => appOrigins.includes(origin) }
  } as unknown as Broker
}

const appPartition = partitionFor(originFromUrl(APP) as string)

describe('partitionForTarget -- only an installed app gets its own session', () => {
  it('gives an installed app its own partition', () => {
    expect(partitionForTarget(APP, brokerWith(APP))).toBe(appPartition)
  })

  it('leaves an ordinary website on the shared default session', () => {
    expect(partitionForTarget(SITE, brokerWith(APP))).toBeUndefined()
  })

  it('leaves everything on the default session when no broker is published yet', () => {
    expect(partitionForTarget(APP, undefined)).toBeUndefined()
  })

  it('has no partition for a target with no derivable origin', () => {
    expect(partitionForTarget('about:blank', brokerWith(APP))).toBeUndefined()
  })
})

describe('partitionChanged -- when a navigation must swap the view', () => {
  it('does not swap between two ordinary websites, which is what keeps back/forward alive (A109)', () => {
    expect(partitionChanged(OTHER_SITE, undefined, brokerWith(APP))).toBeUndefined()
  })

  it('does not swap for a same-origin navigation inside an app', () => {
    expect(partitionChanged(`${APP}/other`, appPartition, brokerWith(APP))).toBeUndefined()
  })

  it('swaps an ordinary tab into an app partition when it reaches an installed app', () => {
    expect(partitionChanged(APP, undefined, brokerWith(APP))).toEqual({ to: appPartition })
  })

  it('swaps an app tab back OUT to the default session when it leaves for an ordinary website', () => {
    // Without this the ordinary site would keep running inside the app's
    // isolated session -- its cookies, its storage, and (build step 4) the
    // partition a real capability grant is scoped to.
    expect(partitionChanged(SITE, appPartition, brokerWith(APP))).toEqual({ to: undefined })
  })

  it('swaps straight from one app partition to another', () => {
    const second = 'https://other-app.example'
    const broker = brokerWith(APP, second)
    expect(partitionChanged(second, appPartition, broker))
      .toEqual({ to: partitionFor(originFromUrl(second) as string) })
  })

  it('never swaps for a target with no derivable origin, whatever the tab is in', () => {
    expect(partitionChanged('about:blank', appPartition, brokerWith(APP))).toBeUndefined()
    expect(partitionChanged('about:blank', undefined, brokerWith(APP))).toBeUndefined()
  })
})
