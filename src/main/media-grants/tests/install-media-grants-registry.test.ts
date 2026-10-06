import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { siteAsks } from '../../sessions/site-asks.js'
import type { SubsystemContext } from '../../registry.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { installMediaGrants } from '../install-media-grants.js'

// Its own file: the registry is one per process, so what an installer adds to it cannot be undone by the next test.

const APP = 'https://app.example'

describe('installMediaGrants and the per-site asker registry', () => {
  it('adds an asker that answers a registered app\'s camera and microphone checks from its grants', () => {
    const ctx = {
      broker: { app: { heldSync: (_origin: string, kind: string) => kind === 'media.camera', hasGrantsSync: () => false, isRegisteredSync: (origin: string) => origin === APP } }
    } as unknown as SubsystemContext
    const blocked = new Set<string>()
    const services = { windows: { findTab: () => ({}) }, settings: { get: (key: string) => blocked.has(key) ? 'block' : 'ask' }, siteSettings: { get: (origin: string, kind: string) => blocked.has(`${origin}:${kind}`) ? 'block' : undefined } } as unknown as ShellServices
    installMediaGrants.install({} as never, services, ctx, {} as never)

    const tab = { getURL: () => `${APP}/`, on: () => {} } as unknown as WebContents
    const details = { isMainFrame: true, mediaType: 'video', securityOrigin: `${APP}/` }
    expect(siteAsks.check(tab, 'media', APP, details)).toBe(true)
    expect(siteAsks.check(tab, 'media', APP, { ...details, mediaType: 'audio' })).toBe(false)
    expect(siteAsks.check(tab, 'media', 'https://site.example', { ...details, securityOrigin: 'https://site.example/' })).toBeUndefined()

    // The origin is registered and holds no grant, so site settings show it as a website: the person's block on it wins.
    blocked.add(`${APP}:camera`)
    expect(siteAsks.check(tab, 'media', APP, details)).toBe(false)
    expect(siteAsks.check(tab, 'media', APP, { ...details, mediaType: 'audio' })).toBe(false)
    blocked.delete(`${APP}:camera`)
    expect(siteAsks.check(tab, 'media', APP, details)).toBe(true)
    blocked.add('sites.camera')
    expect(siteAsks.check(tab, 'media', APP, details)).toBe(false)
  })
})
