import { describe, expect, it, vi } from 'vitest'

// The install subsystem tells the reload of a website's open pages (`../../sessions/stale-pages.ts`) which pages are the
// app's own and must not be loaded again. What it passes is the thing under test, so the reload is a pass-through that
// keeps the dependencies it was given.
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion: vi.fn(async () => ({ response: 1, checkboxChecked: false })) }))
vi.mock('electron', () => ({
  net: { fetch: vi.fn(async () => new Response('{}')) },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() } } }
}))
const given = vi.hoisted(() => ({ deps: undefined as undefined | { readonly isAppPage: (page: never) => boolean } }))
vi.mock('../../sessions/stale-pages.js', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions/stale-pages.js')>()
  return {
    ...actual,
    reloadStalePagesOfNewlyServed: ((deps: Parameters<typeof actual.reloadStalePagesOfNewlyServed>[0]) => {
      given.deps = deps as never
      return actual.reloadStalePagesOfNewlyServed(deps)
    }) as typeof actual.reloadStalePagesOfNewlyServed
  }
})

const { appInstallSubsystem } = await import('../app-install-subsystem.js')
const { createSubsystemContext, publishBroker, publishLoader } = await import('../../registry.js')
const { stubBroker } = await import('../../../broker/transport/tests/ipc.test-helpers.js')
const { carryPageUrl } = await import('../../../loader/electron/carry-page.js')
const { reloadStalePagesOfNewlyServed } = await vi.importActual<typeof import('../../sessions/stale-pages.js')>('../../sessions/stale-pages.js')

import type { App } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Loader } from '../../../loader/index.js'

const fakeApp = { getPath: () => '/nonexistent/orivon-test-profile' } as unknown as App
const fakeLoader = { pinFor: async () => null } as unknown as Loader

interface Page { readonly name: string, getURL: () => string }
const page = (name: string, url: string): Page => ({ name, getURL: () => url })

async function started (): Promise<NonNullable<typeof given.deps>> {
  const ctx = createSubsystemContext(fakeApp)
  publishBroker(ctx, stubBroker([]) as unknown as Broker)
  publishLoader(ctx, fakeLoader)
  await appInstallSubsystem.afterReady?.(ctx)
  if (given.deps === undefined) throw new Error('the subsystem never set up the reload of stale pages')
  return given.deps
}

describe('the pages the install subsystem keeps out of the reload of stale pages', () => {
  it('counts the hidden page of the storage carry as not a website\'s: a reload would end the carry it is in the middle of', async () => {
    const deps = await started()
    expect(deps.isAppPage(page('carry', carryPageUrl('https://wiki.eth', 'ab'.repeat(16))) as never)).toBe(true)
    expect(deps.isAppPage(page('website', 'https://wiki.eth/index.html') as never)).toBe(false)
  })

  it('reloads the website\'s page of the origin the shell starts to serve and leaves the carry\'s hidden page alone', async () => {
    const deps = await started()
    const carry = page('carry', carryPageUrl('https://wiki.eth', 'cd'.repeat(16)))
    const website = page('website', 'https://wiki.eth/')
    const reloaded: string[] = []
    let serving: string[] = []
    let notify = (): void => undefined
    reloadStalePagesOfNewlyServed<Page>({
      served: () => serving,
      pagesOf: () => [carry, website],
      isAppPage: deps.isAppPage as (page: Page) => boolean,
      reload: (target) => { reloaded.push(target.name) },
      onServingChange: (listener) => { notify = listener; return () => undefined }
    })
    serving = ['https://wiki.eth']
    notify()
    expect(reloaded).toEqual(['website'])
  })
})
