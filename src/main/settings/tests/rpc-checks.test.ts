import { describe, expect, it } from 'vitest'
import { isEmptyOrBeaconUrl, isRpcList, MAX_RPCS } from '../rpc-checks.js'
import { SETTINGS, validateSetting } from '../schema.js'

const A = 'https://mainnet.infura.io/v3/FAKE-KEY-0123456789'
const B = 'https://lb.drpc.org/ogrpc?network=ethereum&dkey=FAKE-KEY'
const C = 'http://127.0.0.1:8545'
const D = 'http://192.168.1.20:8545/'
const E = 'https://eth.llamarpc.com/'

describe('isRpcList', () => {
  it('accepts nothing, and one to four addresses one a line', () => {
    expect(isRpcList('')).toBe(true)
    expect(isRpcList(A)).toBe(true)
    expect(isRpcList([A, B, C, D].join('\n'))).toBe(true)
    expect(MAX_RPCS).toBe(4)
  })

  it('refuses a fifth address, and a blank line', () => {
    expect(isRpcList([A, B, C, D, E].join('\n'))).toBe(false)
    expect(isRpcList(`${A}\n\n${B}`)).toBe(false)
    expect(isRpcList(`${A}\n`)).toBe(false)
  })

  it('refuses the same server twice, however it is spelled', () => {
    expect(isRpcList(`${A}\n${A}`)).toBe(false)
    expect(isRpcList('https://RPC.example.com/x\nhttps://rpc.example.com/x')).toBe(false)
    expect(isRpcList('http://127.0.0.1:8545\nhttp://127.0.0.1:8545/')).toBe(false)
  })

  it('refuses a line that is not a server of the kinds allowed', () => {
    for (const bad of ['http://rpc.example.com/', 'https://rpc.example.com:8545/', 'https://user:pw@rpc.example.com/', 'https://rpc.example.com/#x', 'https://vitalik.eth/', 'https://169.254.169.254/', 'http://dappnode.local:8545/', 'not an address']) {
      expect(isRpcList(bad), bad).toBe(false)
      expect(isRpcList(`${A}\n${bad}`), bad).toBe(false)
    }
  })
})

describe('isEmptyOrBeaconUrl', () => {
  it('accepts nothing, or one address with no query', () => {
    expect(isEmptyOrBeaconUrl('')).toBe(true)
    expect(isEmptyOrBeaconUrl('https://beacon.example.com')).toBe(true)
    expect(isEmptyOrBeaconUrl('https://beacon.example.com/prefix')).toBe(true)
    expect(isEmptyOrBeaconUrl('http://127.0.0.1:5052')).toBe(true)
  })

  it('refuses a query, a second line, and what an execution server may not be either', () => {
    for (const bad of ['https://beacon.example.com/?key=FAKE', `https://a.example.com\nhttps://b.example.com`, 'http://beacon.example.com', 'https://beacon.example.com:5052', 'https://u:p@beacon.example.com']) {
      expect(isEmptyOrBeaconUrl(bad), bad).toBe(false)
    }
  })
})

describe('the settings that hold Ethereum servers', () => {
  it('chooses Orivon\'s servers by default, with the person\'s own as the other option', () => {
    expect(SETTINGS['web3.ethServers']).toMatchObject({ kind: 'enum', default: 'orivon', options: ['orivon', 'custom'], labels: { orivon: "Orivon's servers", custom: 'Your own servers' } })
  })

  it('holds no server by default, and validates through the checks above', () => {
    expect(SETTINGS['web3.ethRpcs']).toMatchObject({ kind: 'text', default: '' })
    expect(SETTINGS['web3.ethBeacon']).toMatchObject({ kind: 'text', default: '' })
    expect(validateSetting(SETTINGS['web3.ethRpcs'], [A, B, C, D].join('\n'))).toBe([A, B, C, D].join('\n'))
    expect(validateSetting(SETTINGS['web3.ethRpcs'], [A, B, C, D, E].join('\n'))).toBeUndefined()
    expect(validateSetting(SETTINGS['web3.ethRpcs'], 'http://rpc.example.com/')).toBeUndefined()
    expect(validateSetting(SETTINGS['web3.ethBeacon'], 'https://beacon.example.com/?x=1')).toBeUndefined()
    expect(validateSetting(SETTINGS['web3.ethBeacon'], 'https://beacon.example.com')).toBe('https://beacon.example.com')
  })

  it('has room for four addresses at their longest', () => {
    const longest = Array.from({ length: 4 }, (_, i) => `https://rpc${String(i)}.example.com/${'a'.repeat(2048 - 'https://rpc0.example.com/'.length)}`).join('\n')
    expect(validateSetting(SETTINGS['web3.ethRpcs'], longest)).toBe(longest)
  })
})
