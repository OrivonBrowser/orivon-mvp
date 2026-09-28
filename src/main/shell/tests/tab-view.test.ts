import { describe, expect, it, vi } from 'vitest'
import { originFromUrl } from '../../../broker/policy/origin.js'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import type { Broker } from '../../../broker/broker-contracts.js'

// tab-view.ts imports WebContentsView from 'electron' at module scope, so
// even these pure functions cannot be imported without mocking it first --
// same reasoning tabs.test.ts states for itself.
vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

// The serve registry is a real module-level Set in the loader; mocking it
// here keeps these tests about the RULE rather than about registration.
const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { partitionChanged, partitionForTarget } = await import('../tab-view.js')

const APP = 'https://app.example'
const SITE = 'https://news.example'
const OTHER_SITE = 'https://search.example'

/**
 * Isolation follows CONSENT, not installation -- owner's decision,
 * 2026-09-16. `granted` is what actually decides; `registered` exists only
 * so a test can prove that installing something, on its own, does not.
 */
function brokerWith (opts: { granted?: string[], registered?: string[] }): Broker {
  return {
    app: {
      hasGrantsSync: (origin: string) => (opts.granted ?? []).includes(origin),
      isRegisteredSync: (origin: string) => (opts.registered ?? []).includes(origin)
    }
  } as unknown as Broker
}

const granted = (...origins: string[]): Broker => brokerWith({ granted: origins })
const appPartition = partitionFor(originFromUrl(APP) as string)

describe('partitionForTarget -- isolation follows consent, not installation', () => {
  it('gives an origin the user has granted its own partition', () => {
    expect(partitionForTarget(APP, granted(APP))).toBe(appPartition)
  })

  it('leaves an ordinary website on the shared default session', () => {
    expect(partitionForTarget(SITE, granted(APP))).toBeUndefined()
  })

  it('does NOT isolate an app merely because it is installed', () => {
    // The owner's rule, stated directly: "you still keep storage of an
    // application if you granted permission to do so, it doesn't matter if
    // you install it to run merely on local or not".
    expect(partitionForTarget(APP, brokerWith({ registered: [APP] }))).toBeUndefined()
  })

  it('isolates an origin served from the pinned cache even with no grant yet', () => {
    // ADR-0007 intercepts a cached bundle INSIDE the app's own partition, so
    // a served origin whose tab sat on the default session could not load at
    // all -- nothing there answers its scheme. This is the case that broke
    // e2e-serve-from-cache.
    served.add(APP)
    try {
      expect(partitionForTarget(APP, brokerWith({}))).toBe(appPartition)
    } finally {
      served.delete(APP)
    }
  })

  it('leaves everything on the default session when no broker is published yet', () => {
    expect(partitionForTarget(APP, undefined)).toBeUndefined()
  })

  it('has no partition for a target with no derivable origin', () => {
    expect(partitionForTarget('about:blank', granted(APP))).toBeUndefined()
  })
})

describe('partitionChanged -- when a navigation must swap the view', () => {
  it('does not swap between two ordinary websites, which is what keeps back/forward alive (A109)', () => {
    expect(partitionChanged(OTHER_SITE, undefined, granted(APP))).toBeUndefined()
  })

  it('does not swap for a same-origin navigation inside an app', () => {
    expect(partitionChanged(`${APP}/other`, appPartition, granted(APP))).toBeUndefined()
  })

  it('swaps an ordinary tab into an app partition when it reaches a granted app', () => {
    expect(partitionChanged(APP, undefined, granted(APP))).toEqual({ to: appPartition })
  })

  it('swaps an app tab back OUT to the default session when it leaves for an ordinary website', () => {
    // Without this the ordinary site would keep running inside the app's
    // isolated session -- its cookies, its storage, and the partition a real
    // capability grant is scoped to.
    expect(partitionChanged(SITE, appPartition, granted(APP))).toEqual({ to: undefined })
  })

  it('swaps straight from one app partition to another', () => {
    const second = 'https://other-app.example'
    expect(partitionChanged(second, appPartition, granted(APP, second)))
      .toEqual({ to: partitionFor(originFromUrl(second) as string) })
  })

  it('never swaps for a target with no derivable origin, whatever the tab is in', () => {
    expect(partitionChanged('about:blank', appPartition, granted(APP))).toBeUndefined()
    expect(partitionChanged('about:blank', undefined, granted(APP))).toBeUndefined()
  })
})
