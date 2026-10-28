import { describe, expect, it } from 'vitest'
import { laneNames, publicText } from '../lane-names.js'

const KEY = '0123456789abcdef0123456789abcdef'
const CONFIG = { executionRpcs: [`https://mainnet.infura.io/v3/${KEY}`, 'https://b.rpc'], consensusRpc: `http://127.0.0.1:5052/k/${KEY}` }

describe('laneNames', () => {
  it('gives every route two names that resolve nowhere, the direct one included', () => {
    expect(laneNames('direct')).toEqual({ execution: 'https://direct-execution.orivon.invalid', consensus: 'https://direct-consensus.orivon.invalid' })
    expect(laneNames('nym')).toEqual({ execution: 'https://nym-execution.orivon.invalid', consensus: 'https://nym-consensus.orivon.invalid' })
    expect(laneNames('socks5').execution).toBe('https://socks5-execution.orivon.invalid')
  })
})

describe('publicText', () => {
  const names = laneNames('direct')

  it('shows a lane name as the server it stands for, masked', () => {
    const text = publicText(`error sending request for url (${names.execution}/): connection refused; GET ${names.consensus}/eth/v1/beacon/light_client/bootstrap/0x01 failed`, names, CONFIG)
    expect(text).toBe('error sending request for url (https://mainnet.infura.io/••••/): connection refused; GET http://127.0.0.1:5052/••••/eth/v1/beacon/light_client/bootstrap/0x01 failed')
  })

  it('leaves no part of a configured address in the text, wherever it came from', () => {
    const text = publicText(`fetch failed: https://mainnet.infura.io/v3/${KEY} (path /v3/${KEY}) and ${KEY}`, names, CONFIG)
    expect(text).not.toContain(KEY)
    expect(text).toContain('https://mainnet.infura.io/••••')
  })

  it('shows an address that holds no secret as the address, so text about the default servers reads as it did', () => {
    const plain = { executionRpcs: ['https://eth.drpc.org', 'https://rpc.mevblocker.io'], consensusRpc: 'https://ethereum-beacon-api.publicnode.com' }
    const text = publicText(`error sending request for url (${names.consensus}/eth/v1/beacon/headers): timed out; ${names.execution}/ answered 502`, names, plain)
    expect(text).toBe('error sending request for url (https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/headers): timed out; https://eth.drpc.org/ answered 502')
  })

  it('reads the execution lane as the first server still in use, once the first was dropped', () => {
    const text = `error sending request for url (${names.execution}/): connection refused`
    expect(publicText(text, names, CONFIG, ['https://b.rpc'])).toBe('error sending request for url (https://b.rpc/): connection refused')
    expect(publicText(text, names, CONFIG, ['https://b.rpc'])).not.toContain('infura')
  })

  it('still leaves no part of a dropped server\'s address in the text', () => {
    const text = publicText(`GET https://mainnet.infura.io/v3/${KEY} failed`, names, CONFIG, ['https://b.rpc'])
    expect(text).not.toContain(KEY)
  })

  it('leaves text that names nothing as it was', () => {
    expect(publicText('invalid timestamp', names, CONFIG)).toBe('invalid timestamp')
  })
})
