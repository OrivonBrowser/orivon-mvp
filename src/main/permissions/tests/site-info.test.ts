import { describe, expect, it } from 'vitest'
import { APP, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Grant } from '../../../contracts/index.js'
import { buildSiteInfo } from '../site-info.js'

// The site-info popover's main page (owner reference: a Chrome-style
// per-site permissions surface). One row per capability the MANIFEST
// declares -- never one per LIVE GRANT the way buildAppPermissions's rows
// are: the whole point is to show a switch for something the site asked
// for and does NOT currently hold, which a grant-only row set cannot do.

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

describe('buildSiteInfo -- capability rows', () => {
  it('a declared, held capability renders as on, in the install prompt\'s own words', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const grants: Grant[] = [grant({ patterns: ['api.example.com:443'] })]

    const info = buildSiteInfo(APP, manifest, grants, [], true)

    expect(info.capabilityRows).toEqual([
      { capability: 'tcp.connect', on: true, canTurnOn: true, warning: false, message: 'Connect to api.example.com', patterns: ['api.example.com:443'] }
    ])
  })

  it('a declared, not-held capability renders as off, with the patterns turning it on would grant', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })

    const info = buildSiteInfo(APP, manifest, [], [], true)

    expect(info.capabilityRows).toEqual([
      { capability: 'fs', on: false, canTurnOn: true, warning: false, message: 'Store files in a private folder for this app on this device', patterns: [] }
    ])
  })

  it('canTurnOn is false when the origin is not registered this session, even for a declared, not-held capability', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })

    const info = buildSiteInfo(APP, manifest, [], [], false)

    expect(info.capabilityRows[0]?.canTurnOn).toBe(false)
  })

  it('a held capability can always be turned off, even when the origin somehow is not registered this session', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const grants: Grant[] = [grant()]

    const info = buildSiteInfo(APP, manifest, grants, [], false)

    expect(info.capabilityRows[0]).toMatchObject({ on: true, canTurnOn: true })
  })

  it('carries the warning flag through for an unlimited grant, the same visual signal the install prompt uses', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const grants: Grant[] = [grant({ patterns: ['*:*'] })]

    const info = buildSiteInfo(APP, manifest, grants, [], true)

    expect(info.capabilityRows[0]?.warning).toBe(true)
    expect(info.capabilityRows[0]?.message).toContain('Unlimited')
  })

  it('web.context renders as off with no patterns when not held -- app.requestGrant refuses to mint it, but the popover may still grant it (site-switches.js)', () => {
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })

    const info = buildSiteInfo(APP, manifest, [], [], true)

    expect(info.capabilityRows[0]).toMatchObject({ capability: 'web.context', on: false, canTurnOn: true, patterns: ['https://example.com'] })
  })

  it('a manifest declaring nothing renders no capability rows', () => {
    const info = buildSiteInfo(APP, manifestWith({}), [], [], true)
    expect(info.capabilityRows).toEqual([])
  })

  it('a grant for a capability the current manifest no longer declares is left out -- nothing left to switch', () => {
    // decideGrantRequest fails-closed for an undeclared capability, so no
    // row would be actionable; buildAppPermissions instead lists it
    // (revoke-only). The popover always follows the CURRENT manifest.
    const manifest = manifestWith({})
    const grants: Grant[] = [grant()]

    const info = buildSiteInfo(APP, manifest, grants, [], true)

    expect(info.capabilityRows).toEqual([])
  })
})

describe('buildSiteInfo -- picked paths', () => {
  it('renders one row per picked path, worded the same as the all-sites list', () => {
    const info = buildSiteInfo(APP, manifestWith({}), [], [{ id: 'pick-1', kind: 'file', path: '/home/person/notes.txt', pickedAt: 0 }], true)
    expect(info.pickedPathRows).toEqual([
      { pickId: 'pick-1', warning: false, message: 'Can read and change "/home/person/notes.txt", including emptying it.' }
    ])
  })
})

describe('buildSiteInfo -- asked', () => {
  it('true when the manifest declares at least one capability', () => {
    const info = buildSiteInfo(APP, manifestWith({ fs: { quotaBytes: 1 } }), [], [], true)
    expect(info.asked).toBe(true)
  })

  it('true when there is a picked path but no declared capability', () => {
    const info = buildSiteInfo(APP, manifestWith({}), [], [{ id: 'pick-1', kind: 'file', path: '/x', pickedAt: 0 }], true)
    expect(info.asked).toBe(true)
  })

  it('false for a manifest declaring nothing and no picks -- an ordinary site', () => {
    const info = buildSiteInfo(APP, manifestWith({}), [], [], true)
    expect(info.asked).toBe(false)
  })
})

describe('buildSiteInfo -- identity fields', () => {
  it('carries the origin and the manifest\'s claimed name', () => {
    const info = buildSiteInfo(APP, manifestWith({}), [], [], true)
    expect(info.origin).toBe(APP)
    expect(info.claimedName).toBe('Test app')
  })
})
