import { describe, expect, it } from 'vitest'
import type { Grant } from '../../../contracts/index.js'
import type { PersistedApp } from '../../../broker/grants/ledger-storage.js'
import { persistedCapabilityRows, withUndeclaredHeld } from '../app-capability-rows.js'
import type { SiteCapabilityRow } from '../site-info.js'

const ORIGIN = 'https://app.example'
const fsRow: SiteCapabilityRow = { capability: 'fs', on: false, canTurnOn: true, warning: false, message: 'Store files', patterns: [] }

function grant (overrides: Partial<Grant>): Grant {
  return { id: 'g', origin: ORIGIN, capability: 'https.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

function app (grants: PersistedApp['grants'] = {}): PersistedApp {
  return { origin: ORIGIN, appName: 'App', grants, pickedPaths: {} }
}

describe('withUndeclaredHeld', () => {
  it('leaves the rows alone when every grant already has one', () => {
    expect(withUndeclaredHeld([{ ...fsRow, on: true }], [grant({ capability: 'fs', patterns: [] })])).toEqual([{ ...fsRow, on: true }])
  })

  it('adds an on row for a held capability the manifest no longer declares, so it can still be switched off', () => {
    const rows = withUndeclaredHeld([fsRow], [grant({})])
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({ capability: 'https.connect', on: true, canTurnOn: true, warning: false, message: 'Connect to api.example.com', patterns: ['api.example.com:443'] })
  })
})

describe('persistedCapabilityRows', () => {
  it('shows what the app holds as on, in the words of the install prompt', () => {
    expect(persistedCapabilityRows(app({ 'https.connect': { patterns: ['api.example.com:443'], grantedAt: 0 } }), [])).toEqual([
      { capability: 'https.connect', on: true, canTurnOn: true, warning: false, message: 'Connect to api.example.com', patterns: ['api.example.com:443'] }
    ])
  })

  it('shows what the person switched off as an off row that cannot be turned on until the app is open', () => {
    expect(persistedCapabilityRows(app(), ['fs'])).toEqual([
      { capability: 'fs', on: false, canTurnOn: false, warning: false, message: 'Store files in a private folder for this app on this device', patterns: [] }
    ])
  })

  it('skips a name that is not a capability and a refusal for something the app holds now', () => {
    const rows = persistedCapabilityRows(app({ fs: { patterns: [], grantedAt: 0 } }), ['fs', 'nonsense', '__proto__'])
    expect(rows.map((row) => [row.capability, row.on])).toEqual([['fs', true]])
  })
})
