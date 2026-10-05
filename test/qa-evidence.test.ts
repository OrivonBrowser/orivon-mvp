// The collectors in qa-evidence.mjs, driven with a fake app and page so no
// Electron launches. What a real launch records is proven in
// e2e-qa-evidence.test.ts; this covers the bookkeeping a real run cannot reach.
//
// Run: npx vitest run --config test/vitest.e2e.config.ts test/qa-evidence.test.ts

import { describe, expect, it, vi } from 'vitest'
import { attachCollectors, bundleFor, collected, errorsSince, holdEvidence, mark } from './support/qa-evidence.mjs'

type Handler = (...args: unknown[]) => void

function fakePage (url = 'http://127.0.0.1:1/'): { page: unknown, emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Handler[]>()
  const page = {
    url: () => url,
    on: (event: string, fn: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]) }
  }
  return { page, emit: (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) } }
}

function fakeApp (pages: unknown[], log = () => ''): { app: unknown } {
  const app = {
    windows: () => pages,
    on: () => {},
    evaluate: async () => [],
    context: () => ({ tracing: { start: async () => {}, stop: async () => {} } }),
    process: () => ({ pid: 1 }),
    log
  }
  attachCollectors(app, { mainLog: log })
  return { app }
}

const consoleMessage = (type: string, text: string): unknown => ({ type: () => type, text: () => text, location: () => ({}) })

describe('mark and errorsSince', () => {
  it('see only what was recorded after the mark', () => {
    const { page, emit } = fakePage()
    const { app } = fakeApp([page])
    emit('console', consoleMessage('error', 'before'))
    const since = mark(app)
    emit('console', consoleMessage('error', 'after'))
    emit('console', consoleMessage('warning', 'a warning is not an error'))
    emit('pageerror', new Error('thrown after'))
    expect(errorsSince(app, since).map((e: { text: string }) => e.text)).toEqual(['after', 'thrown after'])
  })

  it('keep working once the capped list has started dropping its oldest entries', () => {
    const { page, emit } = fakePage()
    const { app } = fakeApp([page])
    for (let i = 0; i < 600; i++) emit('console', consoleMessage('error', `early ${String(i)}`))
    expect(collected(app)?.console).toHaveLength(500)
    const since = mark(app)
    emit('console', consoleMessage('error', 'late one'))
    emit('pageerror', new Error('late two'))
    expect(errorsSince(app, since).map((e: { text: string }) => e.text)).toEqual(['late one', 'late two'])
  })
})

describe('the main log of an app that is still running', () => {
  it('reaches the bundle without the caller passing it', async () => {
    const { page } = fakePage()
    const { app } = fakeApp([page], () => 'line the main process printed')
    const bundle = await bundleFor(app, { alive: false })
    expect(bundle?.mainLog).toBe('line the main process printed')
  })
})

describe('holding evidence at close', () => {
  it('gives up after its budget instead of delaying the close of an app that never answers', async () => {
    vi.useFakeTimers()
    try {
      const { page } = fakePage()
      const { app } = fakeApp([page], () => 'log')
      ;(app as { evaluate: () => Promise<never> }).evaluate = () => new Promise(() => {})
      const done = holdEvidence(app, {})
      await vi.advanceTimersByTimeAsync(4_000)
      await expect(done).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
