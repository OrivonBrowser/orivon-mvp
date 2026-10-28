import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENDPOINTS } from '../endpoints.js'
import { effectiveEthServers } from '../eth-servers.js'
import { lightClientConfig } from '../light-client-config.js'
import type { CheckpointChoice } from '../checkpoint.js'

const ROOT = `0x${'a'.repeat(64)}`
const ok: CheckpointChoice = { ok: true, checkpoint: { root: ROOT, timestamp: 0 }, source: 'release', ageSeconds: 3600 }
const orivon = effectiveEthServers({ choice: 'orivon', rpcs: '', beacon: '' })
const renewal = (choice: CheckpointChoice, problem?: 'no-bootstrap') => ({ chooseForStart: () => choice, problem: () => problem })

afterEach(() => { vi.restoreAllMocks() })

describe('lightClientConfig', () => {
  it('gives Orivon\'s servers and the checkpoint, and says nothing of a person\'s servers, while the person named none', async () => {
    const config = await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(ok), servers: orivon })
    expect(config).toEqual({ lightClient: { executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: ROOT } })
  })

  it('gives the person\'s servers in place of Orivon\'s, names which fields are theirs, and names the local ones', async () => {
    const servers = effectiveEthServers({ choice: 'custom', rpcs: 'https://rpc.example.com/x\nhttp://127.0.0.1:8545', beacon: 'http://192.168.1.20:5052' })
    const config = await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(ok), servers })
    expect(config.lightClient).toEqual({
      executionRpcs: ['https://rpc.example.com/x', 'http://127.0.0.1:8545'],
      consensusRpc: 'http://192.168.1.20:5052',
      checkpoint: ROOT,
      localEndpoints: ['http://127.0.0.1:8545', 'http://192.168.1.20:5052'],
      ownServers: { execution: true, consensus: true }
    })
  })

  it('leaves out localEndpoints when none is local, and ownServers when none is the person\'s', async () => {
    const config = await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(ok), servers: effectiveEthServers({ choice: 'custom', rpcs: 'https://rpc.example.com/x', beacon: '' }) })
    expect(config.lightClient).not.toHaveProperty('localEndpoints')
    expect(config.lightClient).toHaveProperty('ownServers', { execution: true, consensus: false })
  })

  it('starts nothing, and says why, while the person has the light client off', async () => {
    const config = await lightClientConfig({ switchedOff: true, renewing: undefined, renewal: renewal(ok), servers: orivon })
    expect(config).toEqual({ lightClient: undefined, lightClientOff: 'the Ethereum light client is switched off, so no .eth name can be verified' })
  })

  it('waits for a checkpoint being renewed before it chooses one', async () => {
    let renewed = false
    const renewing = Promise.resolve().then(() => { renewed = true })
    let choseAfter = false
    await lightClientConfig({ switchedOff: false, renewing, renewal: { chooseForStart: () => { choseAfter = renewed; return ok }, problem: () => undefined }, servers: orivon })
    expect(choseAfter).toBe(true)
  })

  it('starts nothing when no checkpoint can be used, naming the person\'s beacon server when it is the one that refused', async () => {
    const refused: CheckpointChoice = { ok: false, problem: 'not-served', source: 'release', ageSeconds: 3600 }
    const mine = effectiveEthServers({ choice: 'custom', rpcs: '', beacon: 'https://beacon.example.com' })
    expect((await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(refused), servers: orivon })).lightClientOff).toMatch(/^the Ethereum light client cannot start: the beacon server would not start/)
    expect((await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(refused), servers: mine })).lightClientOff).toMatch(/^the Ethereum light client cannot start: your beacon server would not start/)
  })

  it('logs one masked line naming the person\'s servers, and none for Orivon\'s', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(ok), servers: orivon })
    expect(log).not.toHaveBeenCalled()
    await lightClientConfig({ switchedOff: false, renewing: undefined, renewal: renewal(ok), servers: effectiveEthServers({ choice: 'custom', rpcs: 'https://mainnet.infura.io/v3/FAKE-KEY-0123456789', beacon: '' }) })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("[verifier] light client asks your own servers: https://mainnet.infura.io/••••; Orivon's beacon server")
  })

  it('logs nothing while the light client is off', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await lightClientConfig({ switchedOff: true, renewing: undefined, renewal: renewal(ok), servers: effectiveEthServers({ choice: 'custom', rpcs: 'https://rpc.example.com/x', beacon: '' }) })
    expect(log).not.toHaveBeenCalled()
  })
})
