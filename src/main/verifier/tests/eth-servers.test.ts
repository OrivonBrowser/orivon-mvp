import { afterEach, describe, expect, it } from 'vitest'
import { forgetSecrets, noteSecret, scrub } from '../../diagnostics/secret-scrub.js'
import { DEFAULT_ENDPOINTS } from '../endpoints.js'
import { effectiveEthServers, ethServersLine, noteEthSecrets, sameEthServers } from '../eth-servers.js'
import type { EthServerValues } from '../eth-servers.js'

const KEY = 'FAKE-KEY-0123456789abcdef'
const INFURA = `https://mainnet.infura.io/v3/${KEY}`
const LOCAL = `http://127.0.0.1:8545/v3/${KEY}`
const HOME = 'http://192.168.1.20:8545'

const own = (rpcs: string, beacon = ''): EthServerValues => ({ choice: 'custom', rpcs, beacon })
const orivon: EthServerValues = { choice: 'orivon', rpcs: INFURA, beacon: 'https://beacon.example.com' }

describe('effectiveEthServers', () => {
  it('is Orivon\'s servers whatever the person typed, while they chose Orivon\'s', () => {
    const servers = effectiveEthServers(orivon)
    expect(servers.executionRpcs).toEqual(DEFAULT_ENDPOINTS.executionRpcs)
    expect(servers.consensusRpc).toBe(DEFAULT_ENDPOINTS.consensusRpc)
    expect(servers.own).toEqual({ execution: false, consensus: false })
    expect(servers.localEndpoints).toEqual([])
  })

  it('replaces Orivon\'s execution servers with the person\'s list, in order, and never adds to them', () => {
    const servers = effectiveEthServers(own(`${INFURA}\n${HOME}`))
    expect(servers.executionRpcs).toEqual([INFURA, HOME])
    expect(servers.own).toEqual({ execution: true, consensus: false })
    expect(servers.consensusRpc).toBe(DEFAULT_ENDPOINTS.consensusRpc)
  })

  it('replaces the beacon server alone when only that is set, and drops a trailing slash the light client would double', () => {
    const servers = effectiveEthServers(own('', 'https://beacon.example.com/prefix/'))
    expect(servers.consensusRpc).toBe('https://beacon.example.com/prefix')
    expect(servers.executionRpcs).toEqual(DEFAULT_ENDPOINTS.executionRpcs)
    expect(servers.own).toEqual({ execution: false, consensus: true })
  })

  it('keeps Orivon\'s servers for an empty field of a custom choice', () => {
    const servers = effectiveEthServers(own('', ''))
    expect(servers.executionRpcs).toEqual(DEFAULT_ENDPOINTS.executionRpcs)
    expect(servers.consensusRpc).toBe(DEFAULT_ENDPOINTS.consensusRpc)
    expect(servers.own).toEqual({ execution: false, consensus: false })
  })

  it('names the servers on this computer or a home network, whichever field they are in, once each', () => {
    const servers = effectiveEthServers(own(`${INFURA}\n${LOCAL}\n${HOME}`, 'http://127.0.0.1:5052'))
    expect(servers.localEndpoints).toEqual([LOCAL, HOME, 'http://127.0.0.1:5052'])
  })

  it('reads a line the way the store wrote it, with no blank line left', () => {
    expect(effectiveEthServers(own(`${INFURA}\n\n${HOME}\n`)).executionRpcs).toEqual([INFURA, HOME])
  })
})

describe('sameEthServers', () => {
  it('is true for the same servers however they were chosen, and false when one differs', () => {
    expect(sameEthServers(effectiveEthServers(orivon), effectiveEthServers({ choice: 'orivon', rpcs: '', beacon: '' }))).toBe(true)
    expect(sameEthServers(effectiveEthServers(own(INFURA)), effectiveEthServers(own(INFURA)))).toBe(true)
    expect(sameEthServers(effectiveEthServers(own(INFURA)), effectiveEthServers(own(`${INFURA}\n${HOME}`)))).toBe(false)
    expect(sameEthServers(effectiveEthServers(own(INFURA)), effectiveEthServers(orivon))).toBe(false)
    expect(sameEthServers(effectiveEthServers(own('', 'https://a.example.com')), effectiveEthServers(own('', 'https://b.example.com')))).toBe(false)
  })

  it('does not see an edit that changes nothing a request would use', () => {
    expect(sameEthServers(effectiveEthServers({ choice: 'orivon', rpcs: INFURA, beacon: '' }), effectiveEthServers({ choice: 'orivon', rpcs: HOME, beacon: '' }))).toBe(true)
  })
})

describe('noteEthSecrets', () => {
  function noted (values: EthServerValues): Array<[string, string]> {
    const seen: Array<[string, string]> = []
    noteEthSecrets(effectiveEthServers(values), (secret, shown) => { seen.push([secret, shown]) })
    return seen
  }

  it('notes nothing for Orivon\'s servers, which hold no key', () => {
    expect(noted(orivon)).toEqual([])
  })

  it('notes every part of the person\'s addresses that would give a key away, each with what shows in its place', () => {
    const seen = noted(own(INFURA, `https://beacon.example.com/${KEY}2`))
    expect(seen).toContainEqual([INFURA, 'https://mainnet.infura.io/••••'])
    expect(seen).toContainEqual([`/v3/${KEY}`, '••••'])
    expect(seen).toContainEqual([KEY, '••••'])
    expect(seen).toContainEqual([`https://beacon.example.com/${KEY}2`, 'https://beacon.example.com/••••'])
  })

  it('shows an address typed with a trailing slash masked too, however the log spells it', () => {
    const seen = noted(own(`${INFURA}/`))
    expect(seen).toContainEqual([`${INFURA}/`, 'https://mainnet.infura.io/••••'])
    expect(seen).toContainEqual([INFURA, 'https://mainnet.infura.io/••••'])
  })

  it('notes a local address with a key too, and a plain one not at all', () => {
    expect(noted(own(LOCAL))).toContainEqual([LOCAL, 'http://127.0.0.1:8545/••••'])
    expect(noted(own(HOME))).toEqual([])
  })

  describe('an address with an ordinary path, such as a public server\'s', () => {
    afterEach(() => { forgetSecrets() })
    const ANKR = 'https://rpc.ankr.com/eth'

    it('notes the address and not the path, which a key is not', () => {
      const seen = noted(own(ANKR))
      expect(seen).toEqual([[ANKR, 'https://rpc.ankr.com/••••']])
    })

    it('leaves the lines about other servers readable once it is noted', () => {
      noteEthSecrets(effectiveEthServers(own(ANKR)), noteSecret)
      const line = 'GET https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/headers/finalized failed; fallback https://eth.drpc.org; /ethers/lib'
      expect(scrub(line)).toBe(line)
      expect(scrub(`fetch ${ANKR} failed`)).toBe('fetch https://rpc.ankr.com/•••• failed')
    })
  })
})

describe('ethServersLine', () => {
  it('says nothing while Orivon\'s servers are asked', () => {
    expect(ethServersLine(effectiveEthServers(orivon))).toBeUndefined()
  })

  it('names the person\'s servers masked, and the beacon server when it is theirs', () => {
    const line = ethServersLine(effectiveEthServers(own(`${INFURA}\n${HOME}`, `https://beacon.example.com/${KEY}2`))) ?? ''
    expect(line).toBe('light client asks your own servers: https://mainnet.infura.io/••••, http://192.168.1.20:8545; beacon https://beacon.example.com/••••')
    expect(line).not.toContain(KEY)
  })

  it('says it asks Orivon\'s for the field the person left empty', () => {
    expect(ethServersLine(effectiveEthServers(own('', 'https://beacon.example.com')))).toBe("light client asks your own servers: beacon https://beacon.example.com; Orivon's Ethereum servers")
  })
})
