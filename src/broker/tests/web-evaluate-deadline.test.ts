// WebContext.evaluate's optional per-call deadline, and the contract that a
// pending evaluate always settles when its context closes. Split from
// web-capability.test.ts (near its line budget); the fake host is the same.

import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../contracts/index.js'
import type { WebContextHost } from '../broker-contracts.js'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

const CONTEXT_ORIGIN = 'https://example.com'

interface FakeHost extends WebContextHost {
  readonly opened: Array<{ opener: string, origin: string, size: { width: number, height: number } }>
  readonly closed: string[]
  /** Test-only trigger for `onGone` -- simulates the host reporting that `id`'s own renderer died on its own (Finding 3). A no-op if nothing ever registered a listener. */
  simulateGone: (id: string, platformCode: string) => void
}

function fakeHost (overrides: Partial<WebContextHost> = {}): FakeHost {
  const opened: FakeHost['opened'] = []
  const closed: string[] = []
  let counter = 0
  let goneListener: ((id: string, platformCode: string) => void) | undefined
  return {
    opened,
    closed,
    open: async (opener, origin, size) => {
      opened.push({ opener, origin, size })
      counter += 1
      return `host-${String(counter)}`
    },
    evaluate: async (_id, script) => `evaluated:${script}`,
    close: async (id) => { closed.push(id) },
    onGone: (listener) => { goneListener = listener },
    simulateGone: (id, platformCode) => { goneListener?.(id, platformCode) },
    ...overrides
  }
}

function brokerWithHost (host: WebContextHost, patterns: readonly string[] = [CONTEXT_ORIGIN]): ReturnType<typeof createBroker> {
  const broker = createBroker(baseDeps({ webContextHost: host }))
  broker.registerApp(APP, manifestWith({ web: { contexts: patterns } }))
  return broker
}

async function grantedBroker (host: WebContextHost, patterns: readonly string[] = [CONTEXT_ORIGIN]): Promise<ReturnType<typeof createBroker>> {
  const broker = brokerWithHost(host, patterns)
  await broker.grant(APP, 'web.context', patterns)
  return broker
}

const hangs = (): Partial<WebContextHost> => ({ evaluate: async () => await new Promise(() => {}) })

describe('evaluate(script, { timeoutMs })', () => {
  it('rejects timeout at the caller\'s own shorter deadline, and closes the context', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost(hangs())
      const broker = await grantedBroker(host)
      const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      const pending = broker.web.evaluate(APP, { id: context.id, script: 'x', timeoutMs: 1_000 })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion

      expect(host.closed).toEqual(['host-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never extends the platform deadline -- a larger value is clamped to it', async () => {
    vi.useFakeTimers()
    try {
      const broker = await grantedBroker(fakeHost(hangs()))
      const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      const pending = broker.web.evaluate(APP, { id: context.id, script: 'x', timeoutMs: LIMITS.webContextEvaluateMs * 10 })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(LIMITS.webContextEvaluateMs + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a timeoutMs of %s as invalid without running anything', async (timeoutMs) => {
    const evaluate = vi.fn(async () => 'ran')
    const broker = await grantedBroker(fakeHost({ evaluate }))
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: 'x', timeoutMs })).rejects.toMatchObject({ code: 'invalid' })
    expect(evaluate).not.toHaveBeenCalled()
  })
})

describe('a pending evaluate settles when its context closes', () => {
  it('rejects closed when the app closes the context', async () => {
    const broker = await grantedBroker(fakeHost(hangs()))
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const pending = broker.web.evaluate(APP, { id: context.id, script: 'x' })
    await broker.web.close(APP, { id: context.id })

    await expect(pending).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects with the renderer\'s own failure when the context dies underneath it', async () => {
    const host = fakeHost(hangs())
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const pending = broker.web.evaluate(APP, { id: context.id, script: 'x' })
    host.simulateGone('host-1', 'crashed')

    await expect(pending).rejects.toMatchObject({ code: 'reset' })
  })
})
