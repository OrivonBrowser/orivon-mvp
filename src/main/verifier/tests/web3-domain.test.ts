import { describe, expect, it } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { web3Domain } from '../web3-domain.js'
import type { LightClientView } from '../status-view.js'

const CALLER = {} as InternalCaller
const VIEW: LightClientView = { state: 'synced', summary: 'In step with the chain.', checkpoint: 'c', about: 'a', endpoints: [] }

describe('the web3 domain', () => {
  it('says how the light client is, what is chosen now and what it was at the start', () => {
    let enabled = true
    const domain = web3Domain({ view: () => VIEW, enabled: () => enabled, enabledAtStart: true, forcedOff: () => false })
    expect(domain.handle({ type: 'status' }, CALLER)).toEqual({ view: VIEW, enabled: true, enabledAtStart: true, forcedOff: false })
    enabled = false
    expect(domain.handle({ type: 'status' }, CALLER)).toMatchObject({ enabled: false, enabledAtStart: true })
  })

  it('is for Settings only, and answers nothing else', () => {
    const domain = web3Domain({ view: () => VIEW, enabled: () => true, enabledAtStart: true, forcedOff: () => true })
    expect(domain.pages).toEqual(['settings'])
    expect(domain.handle({ type: 'switch-off' }, CALLER)).toBeUndefined()
    expect(domain.handle(null, CALLER)).toBeUndefined()
    expect(domain.handle({ type: 'status' }, CALLER)).toMatchObject({ forcedOff: true })
  })
})
