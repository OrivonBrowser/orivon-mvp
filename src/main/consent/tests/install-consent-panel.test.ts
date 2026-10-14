import { describe, expect, it } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import { buildSiteInfo } from '../../permissions/site-info.js'
import { describeInstallPanel, TOGETHER_NOTE } from '../install-consent-panel.js'

const ORIGIN = 'https://app.example'
const MANIFEST = manifestWith({ net: { https: { connect: ['a.example:443'] }, tcp: { connect: ['*:*'] } }, fs: {} })

describe('describeInstallPanel', () => {
  it('has one row per capability being decided, in the order given, with the words of the key popup', () => {
    const panel = describeInstallPanel(ORIGIN, MANIFEST, ['fs', 'https.connect', 'tcp.connect'])
    expect(panel.rows.map((row) => row.capability)).toEqual(['fs', 'https.connect', 'tcp.connect'])
    const info = buildSiteInfo(ORIGIN, MANIFEST, [], [], true)
    for (const row of panel.rows) {
      const popup = info.capabilityRows.find((candidate) => candidate.capability === row.capability)
      expect(popup, row.capability).toBeDefined()
      expect({ message: row.message, warning: row.warning }, row.capability).toEqual({ message: popup?.message, warning: popup?.warning })
    }
  })

  it('shows only the capabilities it is given, so what is held or refused already is not a row', () => {
    expect(describeInstallPanel(ORIGIN, MANIFEST, ['fs']).rows.map((row) => row.capability)).toEqual(['fs'])
  })

  it('warns when any row is unlimited, and not otherwise', () => {
    expect(describeInstallPanel(ORIGIN, MANIFEST, ['fs', 'tcp.connect']).warning).toBe(true)
    expect(describeInstallPanel(ORIGIN, MANIFEST, ['fs', 'https.connect']).warning).toBe(false)
  })

  it('ADR-0037: at Level 4 no row and no panel warns', () => {
    const panel = describeInstallPanel(ORIGIN, MANIFEST, ['fs', 'tcp.connect'], 4)
    expect(panel.warning).toBe(false)
    expect(panel.rows.some((row) => row.warning)).toBe(false)
  })

  it('puts the claimed name first and the address last in the detail, with the extensions line between', () => {
    const lines = describeInstallPanel(ORIGIN, MANIFEST, ['fs'], undefined, ['Ad Blocker']).detail.split('\n')
    expect(lines[0]).toMatch(/^Claims to be "/)
    expect(lines.at(-1)).toBe(ORIGIN)
    expect(lines.some((line) => line.startsWith('Extensions that can also act on this site: Ad Blocker'))).toBe(true)
  })

  it('carries the together line for an all-or-nothing app and none for a per-capability one', () => {
    expect(describeInstallPanel(ORIGIN, MANIFEST, ['fs']).note).toBe(TOGETHER_NOTE)
    expect(describeInstallPanel(ORIGIN, { ...MANIFEST, consentGranularity: 'per-capability' }, ['fs']).note).toBeUndefined()
  })
})
