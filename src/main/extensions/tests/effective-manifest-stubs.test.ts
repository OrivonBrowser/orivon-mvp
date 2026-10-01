import { describe, expect, it } from 'vitest'
import { effectiveManifest, MANIFEST_STAGES } from '../effective-manifest.js'
import { normalizePrefs } from '../extension-prefs.js'

describe('the shipped manifest stages', () => {
  it('leave a manifest as it is, whatever the person chose, until a feature fills them', () => {
    const base = { manifest_version: 3, name: 'x', version: '1', permissions: ['storage'], host_permissions: ['https://a.example/*'] }
    const prefs = normalizePrefs({
      granted: { permissions: ['history'], origins: ['https://b.example/*'] },
      siteAccess: { mode: 'sites', sites: ['https://a.example/*'] }
    })
    expect(effectiveManifest(base, prefs)).toEqual(base)
  })

  it('run in the documented order', () => {
    expect(MANIFEST_STAGES.map((stage) => stage.name)).toEqual(['applyGrantedStage', 'applySiteAccessStage'])
  })
})
