import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { appMediaGrants, bindAppMediaGrants } from '../../display-capture/bindings.js'
import type { SubsystemContext } from '../../registry.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { installMediaGrants } from '../install-media-grants.js'

const APP = 'https://app.example'

interface Tab { url: string, destroyed: boolean, getURL: () => string, isDestroyed: () => boolean, on: () => void }

function makeTab (url = `${APP}/`): Tab {
  const tab: Tab = { url, destroyed: false, getURL: () => tab.url, isDestroyed: () => tab.destroyed, on: () => {} }
  return tab
}

function install (granted: Set<string>, requestGrant: SubsystemContext['requestGrant']): void {
  const ctx = {
    broker: { app: { heldSync: (_origin: string, kind: string) => granted.has(kind), hasGrantsSync: () => false, isRegisteredSync: (origin: string) => origin === APP } },
    requestGrant,
    windowForSender: () => 'the window'
  } as unknown as SubsystemContext
  const services = { windows: { findTab: () => ({}) }, settings: { get: () => 'ask' }, siteSettings: { get: () => undefined } } as unknown as ShellServices
  installMediaGrants.install({} as never, services, ctx, {} as never)
}

describe('installMediaGrants', () => {
  it('binds the grants the display gate reads, over the broker\'s ledger', () => {
    bindAppMediaGrants(undefined)
    expect(appMediaGrants.held(APP, 'media.screen')).toBe(false)
    install(new Set(['media.screen']), undefined)
    expect(appMediaGrants.held(APP, 'media.screen')).toBe(true)
    expect(appMediaGrants.held(APP, 'media.camera')).toBe(false)
    bindAppMediaGrants(undefined)
  })

  it('asks through the request-grant flow in the tab that asked, naming the kind', async () => {
    const asked: Array<{ origin: string, capability: string, caller: { id?: unknown, contents?: () => unknown, window: () => unknown, stillOn: (origin: string) => boolean } }> = []
    install(new Set(), (async (origin, request, caller) => {
      asked.push({ origin, capability: request.capability, caller: caller as never })
      return true
    }))
    const tab = makeTab()
    expect(await appMediaGrants.request(tab as unknown as WebContents, APP, 'media.camera')).toBe(true)
    expect(asked).toHaveLength(1)
    const [first] = asked
    expect(first?.origin).toBe(APP)
    expect(first?.capability).toBe('media.camera')
    expect(first?.caller.id).toBe(tab)
    expect(first?.caller.contents?.()).toBe(tab)
    expect(first?.caller.window()).toBe('the window')
    expect(first?.caller.stillOn(APP)).toBe(true)
    tab.url = 'https://elsewhere.example/'
    expect(first?.caller.stillOn(APP)).toBe(false)
    tab.url = `${APP}/`
    tab.destroyed = true
    expect(first?.caller.stillOn(APP)).toBe(false)
    bindAppMediaGrants(undefined)
  })

  it('is false before the request-grant flow exists', async () => {
    install(new Set(), undefined)
    expect(await appMediaGrants.request(makeTab() as unknown as WebContents, APP, 'media.microphone')).toBe(false)
    bindAppMediaGrants(undefined)
  })
})
