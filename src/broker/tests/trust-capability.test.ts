// orivon.trust's grant check (../capabilities/trust.ts, ADR-0058), through createBroker like
// ./secrets-capability.test.ts: nothing granted, granted, revoked, and one origin's grant not another's.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

const OTHER = 'https://other.example'

describe('orivon.trust.requireScoreGrant', () => {
  it('refuses denied while nothing is granted, even to an app that declared it', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ trust: { score: true } }))
    expect(() => { broker.trust.requireScoreGrant(APP) }).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('passes once trust.score is granted, and only for the origin it was granted to', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ trust: { score: true } }))
    await broker.registerApp(OTHER, manifestWith({ trust: { score: true } }))
    await broker.grant(APP, 'trust.score', [])
    expect(() => { broker.trust.requireScoreGrant(APP) }).not.toThrow()
    expect(() => { broker.trust.requireScoreGrant(OTHER) }).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('refuses again after the grant is revoked', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ trust: { score: true } }))
    const grant = await broker.grant(APP, 'trust.score', [])
    await broker.revoke(APP, grant.id)
    expect(() => { broker.trust.requireScoreGrant(APP) }).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('a grant of another kind does not satisfy it', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    expect(() => { broker.trust.requireScoreGrant(APP) }).toThrow(expect.objectContaining({ code: 'denied' }))
  })
})
