import { describe, expect, it } from 'vitest'
import { grantChangedCapabilities } from '../grant-changed-capabilities.js'
import { createBroker } from '../../broker/index.js'
import { baseDeps, manifestWith } from '../../broker/tests/index.test-helpers.js'

const APP = 'https://app.example'

// ADR-0019 regression, against a REAL broker (createBroker), not a stub:
// grantChangedCapabilities is install-consent's OWN grant call -- the ONLY
// door web.context is meant to have (app.requestGrant refuses it
// unconditionally, main/request-grant.ts). A blanket 'web.context' refusal
// once lived inside decideGrantRequest (../../broker/policy/request-grant.js),
// which this function also calls through -- so accepting the install
// dialog for web.context would have silently granted NOTHING at all. Fixed
// by moving that refusal to request-grant.ts's own requestGrant instead;
// this file pins that install consent still works for web.context.
describe('grantChangedCapabilities -- web.context (ADR-0019)', () => {
  it('actually grants web.context when the manifest declares it -- the install-consent path must not be silently blocked', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })
    await broker.registerApp(APP, manifest)

    await grantChangedCapabilities(broker, APP, manifest, ['web.context'])

    const grants = await broker.app.grants(APP)
    const webGrant = grants.find((g) => g.capability === 'web.context')
    expect(webGrant).toBeDefined()
    expect(webGrant?.patterns).toEqual(['https://example.com'])
  })

  it('does not re-grant (and so does not tear down live handles under) an unchanged web.context declaration', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })
    await broker.registerApp(APP, manifest)
    await grantChangedCapabilities(broker, APP, manifest, ['web.context'])
    const first = (await broker.app.grants(APP)).find((g) => g.capability === 'web.context')

    await grantChangedCapabilities(broker, APP, manifest, ['web.context'])

    const second = (await broker.app.grants(APP)).find((g) => g.capability === 'web.context')
    expect(second?.id).toBe(first?.id)
  })
})
