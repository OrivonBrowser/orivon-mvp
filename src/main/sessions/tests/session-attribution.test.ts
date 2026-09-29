import { describe, expect, it, vi } from 'vitest'
import { originFromUrl } from '../../../broker/policy/origin.js'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { createSubsystemContext, publishBroker } from '../../registry.js'

// session-attribution.ts's own subsystem reaches into electron (app, session)
// at module scope and imports ../shell/tab-view.js, which itself imports
// WebContentsView from electron -- same shape tab-view.test.ts already mocks,
// reused here for the same reason: these tests are about the ATTRIBUTION
// RULE, not about wiring a real Electron session.
const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { webContentsCreatedListeners, sessionsByPartition, DEFAULT_SESSION } = vi.hoisted(() => ({
  webContentsCreatedListeners: [] as Array<(event: unknown, wc: unknown) => void>,
  sessionsByPartition: new Map<string, { name: string }>(),
  DEFAULT_SESSION: { name: 'default' }
}))

vi.mock('electron', () => ({
  WebContentsView: vi.fn(),
  app: {
    on: (name: string, listener: (event: unknown, wc: unknown) => void) => {
      if (name === 'web-contents-created') webContentsCreatedListeners.push(listener)
    }
  },
  session: {
    defaultSession: DEFAULT_SESSION,
    fromPartition: (partition: string) => {
      let s = sessionsByPartition.get(partition)
      if (s === undefined) {
        s = { name: partition }
        sessionsByPartition.set(partition, s)
      }
      return s
    }
  }
}))

const { sessionAttributionSubsystem } = await import('../session-attribution.js')
const { session } = await import('electron')

const APP = 'https://app.example'
const OTHER = 'https://other.example'
// Built through the SAME mocked session.fromPartition every production call
// goes through, never a separately-constructed literal -- attribution
// compares by reference, and a look-alike object would never be `===` to
// what the real predicate resolves.
const appPartitionSession = session.fromPartition(partitionFor(originFromUrl(APP) as string))

interface FakeWebContents {
  session: unknown
  on: (name: string, listener: (event: unknown, url: string) => void) => void
}

function fakeWebContents (initialSession: unknown): { wc: FakeWebContents, commit: (url: string) => void } {
  let didNavigate: ((event: unknown, url: string) => void) | undefined
  const wc: FakeWebContents = {
    session: initialSession,
    on: (name, listener) => { if (name === 'did-navigate') didNavigate = listener }
  }
  return { wc, commit: (url) => didNavigate?.(undefined, url) }
}

/**
 * One subsystem instance, over a MUTABLE grant set -- `granted` is read
 * fresh on every `expectedSession` call (inside session-attribution.ts's own
 * closure), so mutating it after a commit simulates a real `broker.grant()`/
 * revoke landing on the same running app, without ever re-publishing a
 * second, disagreeing `senderAttributed` (registry.ts refuses that).
 */
function attributionRig (granted: Set<string>): {
  attributed: (sender: unknown, origin: string) => boolean
  register: (wc: FakeWebContents) => void
} {
  const broker: Broker = { app: { hasGrantsSync: (origin: string) => granted.has(origin) } } as unknown as Broker
  const ctx = createSubsystemContext({} as never)
  publishBroker(ctx, broker)
  const before = webContentsCreatedListeners.length
  sessionAttributionSubsystem.afterReady?.(ctx)
  const listener = webContentsCreatedListeners[before]
  const attributed = ctx.senderAttributed
  if (attributed === undefined || listener === undefined) throw new Error('senderAttributed was not published')
  return { attributed, register: (wc) => { listener(undefined, wc) } }
}

describe('senderAttributed -- cache-served origins are checked live and strictly', () => {
  it('denies a sender outside the pinned partition even with no commit record at all', () => {
    served.add(APP)
    const { attributed } = attributionRig(new Set())
    const { wc } = fakeWebContents(DEFAULT_SESSION)

    expect(attributed(wc, APP)).toBe(false)
    served.delete(APP)
  })

  it('allows a sender already inside the pinned partition', () => {
    served.add(APP)
    const { attributed } = attributionRig(new Set())
    const { wc } = fakeWebContents(appPartitionSession)

    expect(attributed(wc, APP)).toBe(true)
    served.delete(APP)
  })

  it('never trusts a stale record for a cache-served origin', () => {
    served.add(APP)
    const { attributed, register } = attributionRig(new Set())
    const { wc, commit } = fakeWebContents(appPartitionSession)
    register(wc)
    commit(APP) // records attributed: true, in the right partition
    wc.session = DEFAULT_SESSION // then moves out of it without navigating

    expect(attributed(wc, APP)).toBe(false)
    served.delete(APP)
  })
})

describe('senderAttributed -- an already-committed document survives a grant or a revoke', () => {
  it('stays attributed after a grant moves its origin to a new partition', () => {
    const granted = new Set<string>()
    const { attributed, register } = attributionRig(granted)
    const { wc, commit } = fakeWebContents(DEFAULT_SESSION)
    register(wc)
    commit(APP) // ungranted at commit time: DEFAULT_SESSION was expected, and matched

    granted.add(APP) // the grant lands; the document never navigates
    expect(attributed(wc, APP)).toBe(true)
  })

  it('stays attributed after that grant is revoked again', () => {
    const granted = new Set([APP])
    const { attributed, register } = attributionRig(granted)
    const { wc, commit } = fakeWebContents(appPartitionSession)
    register(wc)
    commit(APP) // granted at commit time: the app partition was expected, and matched

    granted.delete(APP) // the origin's last grant is revoked; the document never navigates
    expect(attributed(wc, APP)).toBe(true)
  })

  it('falls back to the live check for a different origin the same WebContents never committed', () => {
    const { attributed, register } = attributionRig(new Set())
    const { wc, commit } = fakeWebContents(DEFAULT_SESSION)
    register(wc)
    commit(APP)

    // OTHER has no record on this WebContents, so the live check runs: OTHER
    // is ungranted too, so DEFAULT_SESSION is still expected, and matches.
    expect(attributed(wc, OTHER)).toBe(true)
  })

  it('a wrong-session commit stays denied, even after a fresh WebContents in the right partition takes over the tab', () => {
    // origin already granted, but this document commits into the default
    // session anyway -- a link/redirect/history navigation landing before
    // tab-view.ts's own did-navigate swap moves the tab.
    const { attributed, register } = attributionRig(new Set([APP]))
    const stale = fakeWebContents(DEFAULT_SESSION)
    register(stale.wc)
    stale.commit(APP)
    expect(attributed(stale.wc, APP)).toBe(false)

    // The swap replaces the view with a brand new WebContents rather than
    // fixing this one's record -- the new one's own commit is attributed,
    // and the stale one stays denied regardless.
    const fresh = fakeWebContents(appPartitionSession)
    register(fresh.wc)
    fresh.commit(APP)
    expect(attributed(fresh.wc, APP)).toBe(true)
    expect(attributed(stale.wc, APP)).toBe(false)
  })

  it('falls back to the live check when no did-navigate has ever landed for this WebContents', () => {
    const { attributed } = attributionRig(new Set())
    const { wc } = fakeWebContents(DEFAULT_SESSION)

    expect(attributed(wc, APP)).toBe(true)
  })
})
