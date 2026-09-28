import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { InternalCaller } from '../internal-ipc.js'
import { INTERNAL_PAGES } from '../internal-pages.js'
import { pagesDomain } from '../pages-domain.js'

const CONTENTS = {} as WebContents
const CALLER = { page: 'settings', contents: CONTENTS } as InternalCaller

function setup (found = true): { call: (command: unknown) => unknown, openInternal: ReturnType<typeof vi.fn> } {
  const openInternal = vi.fn()
  const domain = pagesDomain({ findTab: (contents) => contents === CONTENTS && found ? { window: { tabs: { openInternal } } as never, tabId: 'tab-1' } : null })
  return { call: (command) => domain.handle(command, CALLER), openInternal }
}

describe('the pages domain', () => {
  it('is for every shell page', () => {
    expect(pagesDomain({ findTab: () => null }).pages).toEqual(INTERNAL_PAGES)
  })

  it('opens a shell page in the window the asking page is in', () => {
    const { call, openInternal } = setup()
    expect(call({ type: 'open', page: 'history' })).toEqual({ ok: true })
    call({ type: 'open', page: 'settings', path: '/privacy' })
    expect(openInternal.mock.calls).toEqual([['history', '/'], ['settings', '/privacy']])
  })

  it('opens nothing for a page that is not one of the shell\'s, a path that is not a place inside it, or a sender in no window', () => {
    const { call, openInternal } = setup()
    call({ type: 'open', page: 'nope' })
    call({ type: 'open', page: 'https://evil.example/' })
    call({ type: 'open', page: 7 })
    call({ type: 'close', page: 'history' })
    call(null)
    call({ type: 'open', page: 'settings', path: 'https://evil.example/' })
    expect(openInternal.mock.calls).toEqual([['settings', '/']])

    const orphan = setup(false)
    orphan.call({ type: 'open', page: 'history' })
    expect(orphan.openInternal).not.toHaveBeenCalled()
  })
})
